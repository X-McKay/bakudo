//! Ratatui UI rendering — Codex-level polish.
//!
//! Layout (terminal width ≥ SHELF_MIN_TERM_WIDTH):
//!
//!  ┌──────────────────────────────────────────────────────┬──────────────────────────┐
//!  │  bakudo v2  ·  provider: claude  ·  model: opus-4-5  │                          │
//!  ├──────────────────────────────────────────────────────┤   ╔═ Sandboxes (2) ════╗  │
//!  │                                                      │   ║ ⠙ running          ║  │
//!  │   HH:MM:SS  you   hello world                        │   ║   task-abc         ║  │
//!  │             ─────────────────────────────────────    │   ║   "fix the bug"    ║  │
//!  │   HH:MM:SS        agent output line 1               │   ║                    ║  │
//!  │                   agent output line 2               │   ║ ✓ preserved        ║  │
//!  │                                                      │   ║   task-xyz         ║  │
//!  ├──────────────────────────────────────────────────────┤   ╚════════════════════╝  │
//!  │  [C] > input with cursor█                            │                          │
//!  └──────────────────────────────────────────────────────┴──────────────────────────┘
//!   Enter: send  Tab: complete/shelf  PgUp/Dn: scroll  Ctrl+C: quit  /help: commands
//!
//! When the terminal is narrower than SHELF_MIN_TERM_WIDTH the shelf is hidden.

use ratatui::{
    layout::{Alignment, Constraint, Direction, Layout, Rect},
    style::{Color, Modifier, Style, Stylize},
    text::{Line, Span, Text},
    widgets::{Block, BorderType, Borders, Clear, List, ListItem, ListState, Paragraph, Wrap},
    Frame,
};
use unicode_segmentation::UnicodeSegmentation;
use unicode_width::{UnicodeWidthChar, UnicodeWidthStr};

use crate::app::{short_task_id, App, FocusedPanel, MessageRole, ShelfColor};
use crate::commands::SlashCommand;
use crate::palette::{
    self, composer_height_for, FOOTER_HEIGHT, GUTTER, HEADER_HEIGHT, SHELF_MIN_TERM_WIDTH,
    SHELF_WIDTH,
};
use strum::IntoEnumIterator;

// ─── Top-level render ──────────────────────────────────────────────────────

/// Render the full TUI into `frame`.
pub fn render(frame: &mut Frame, app: &App) {
    let area = frame.size();
    // Only carve out the shelf column when the terminal is wide enough AND
    // there is at least one sandbox to show — an empty sidebar is chrome,
    // not content.
    let show_shelf = area.width >= SHELF_MIN_TERM_WIDTH && !app.shelf.is_empty();

    // ── Slice the header off the top so it spans the full terminal width and
    //    the shelf naturally starts below it. ──────────────────────────────
    let outer = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Length(HEADER_HEIGHT), Constraint::Min(0)])
        .split(area);
    let header_area = outer[0];
    let body_area = outer[1];

    // ── Horizontal split of the body: main | shelf ────────────────────────
    let h_chunks = if show_shelf {
        Layout::default()
            .direction(Direction::Horizontal)
            .constraints([Constraint::Min(40), Constraint::Length(SHELF_WIDTH)])
            .split(body_area)
    } else {
        Layout::default()
            .direction(Direction::Horizontal)
            .constraints([Constraint::Percentage(100)])
            .split(body_area)
    };

    let main_area = h_chunks[0];

    // ── Vertical split of main: transcript | status | composer | footer ──
    // The status strip appears only when at least one task is running; it
    // shows a spinner, the running count, and the latest phase of the most
    // recently-started running task. Composer grows with multi-line input.
    let composer_h = composer_height_for(app.input.split('\n').count());
    let status_h: u16 = if app.active_task_count > 0 || has_running_entry(app) {
        1
    } else {
        0
    };
    let v_chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Min(5),
            Constraint::Length(status_h),
            Constraint::Length(composer_h),
            Constraint::Length(FOOTER_HEIGHT),
        ])
        .split(main_area);

    render_header(frame, app, header_area);
    render_transcript(frame, app, v_chunks[0]);
    if status_h > 0 {
        render_status_strip(frame, app, v_chunks[1]);
    }
    render_composer(frame, app, v_chunks[2]);
    render_footer(frame, app, v_chunks[3]);

    if show_shelf {
        render_shelf(frame, app, h_chunks[1]);
    }

    // ── Completion popup ────────────────────────────────────────────────────
    if !app.completions.is_empty() && app.focus == FocusedPanel::Chat {
        render_completion_popup(frame, app, v_chunks[2]);
    }

    if app.approval_prompt.is_some() {
        render_approval_modal(frame, app);
    }
    if app.user_question_prompt.is_some() {
        render_question_modal(frame, app);
    }

    // ── Help overlay (drawn last so it sits on top of everything) ───────────
    if app.help_visible {
        render_help_overlay(frame, app);
    }
}

// ─── Header ────────────────────────────────────────────────────────────────

fn render_header(frame: &mut Frame, app: &App, area: Rect) {
    let model_label = app.model_label();
    let model_str = model_label.as_str();
    let line_1 = Line::from(vec![
        Span::raw("  "),
        Span::styled("bakudo", Style::default().fg(Color::White).bold()),
        Span::styled(" v2", Style::default().fg(palette::dim_border())),
        Span::styled("  ·  ", Style::default().fg(palette::dim_border())),
        Span::styled(&app.workspace_label, Style::default().fg(Color::White)),
        Span::styled("  ·  ", Style::default().fg(palette::dim_border())),
        Span::styled("provider: ", Style::default().fg(palette::header_fg())),
        Span::styled(
            &app.provider_id,
            Style::default().fg(palette::provider_accent()).bold(),
        ),
        Span::styled("  ·  ", Style::default().fg(palette::dim_border())),
        Span::styled("model: ", Style::default().fg(palette::header_fg())),
        Span::styled(model_str, Style::default().fg(palette::model_accent())),
    ]);
    let line_2 = if let Some(banner) = &app.mission_banner {
        Line::from(vec![
            Span::raw("  "),
            Span::styled("mission ", palette::dim_style()),
            Span::styled(&banner.goal, Style::default().fg(Color::White).bold()),
            Span::styled("  ·  ", Style::default().fg(palette::dim_border())),
            Span::styled("posture ", palette::dim_style()),
            Span::styled(
                banner.posture.to_string(),
                Style::default().fg(palette::provider_accent()).bold(),
            ),
            Span::styled("  ·  ", Style::default().fg(palette::dim_border())),
            Span::styled("wallet ", palette::dim_style()),
            Span::styled(
                format!(
                    "{}s · {} remain · {} in flight / {} max",
                    banner.wall_clock_remaining_secs,
                    banner.abox_workers_remaining,
                    banner.abox_workers_in_flight,
                    banner.concurrent_max
                ),
                Style::default().fg(Color::White),
            ),
        ])
    } else if area.width < SHELF_MIN_TERM_WIDTH {
        let counts = format!(
            "r{} p{} c{}",
            app.running_shelf_count(),
            app.preserved_shelf_count(),
            app.conflict_shelf_count(),
        );
        Line::from(vec![
            Span::raw("  "),
            Span::styled("base ", palette::dim_style()),
            Span::styled(&app.config.base_branch, Style::default().fg(Color::White)),
            Span::styled("  ·  ", Style::default().fg(palette::dim_border())),
            Span::styled("policy ", palette::dim_style()),
            Span::styled(
                app.config.candidate_policy.to_string(),
                Style::default().fg(Color::White),
            ),
            Span::styled("  ·  ", Style::default().fg(palette::dim_border())),
            Span::styled("lc ", palette::dim_style()),
            Span::styled(
                app.config.sandbox_lifecycle.to_string(),
                Style::default().fg(Color::White),
            ),
            Span::styled("  ·  ", Style::default().fg(palette::dim_border())),
            Span::styled(counts, Style::default().fg(Color::White).bold()),
        ])
    } else {
        Line::from(vec![
            Span::raw("  "),
            Span::styled("base ", palette::dim_style()),
            Span::styled(&app.config.base_branch, Style::default().fg(Color::White)),
            Span::styled("  ·  ", Style::default().fg(palette::dim_border())),
            Span::styled("policy ", palette::dim_style()),
            Span::styled(
                app.config.candidate_policy.to_string(),
                Style::default().fg(Color::White),
            ),
            Span::styled("  ·  ", Style::default().fg(palette::dim_border())),
            Span::styled("lifecycle ", palette::dim_style()),
            Span::styled(
                app.config.sandbox_lifecycle.to_string(),
                Style::default().fg(Color::White),
            ),
            Span::styled("  ·  ", Style::default().fg(palette::dim_border())),
            Span::styled("running ", palette::dim_style()),
            Span::styled(
                app.running_shelf_count().to_string(),
                Style::default().fg(palette::shelf_running()).bold(),
            ),
            Span::styled("  ·  ", Style::default().fg(palette::dim_border())),
            Span::styled("preserved ", palette::dim_style()),
            Span::styled(
                app.preserved_shelf_count().to_string(),
                Style::default().fg(palette::shelf_preserved()).bold(),
            ),
            Span::styled("  ·  ", Style::default().fg(palette::dim_border())),
            Span::styled("conflicts ", palette::dim_style()),
            Span::styled(
                app.conflict_shelf_count().to_string(),
                Style::default().fg(palette::shelf_conflicts()).bold(),
            ),
        ])
    };

    let header = Paragraph::new(Text::from(vec![line_1, line_2]))
        .style(Style::default().bg(palette::header_bg()));
    frame.render_widget(header, area);
}

fn render_approval_modal(frame: &mut Frame, app: &App) {
    let Some(prompt) = &app.approval_prompt else {
        return;
    };
    let area = centered_rect(frame.size(), 70, if prompt.editing { 40 } else { 34 });
    frame.render_widget(Clear, area);
    let body = if prompt.editing {
        format!(
            "Approval required\n\nCommand:\n{}\n\nReason:\n{}\n\nEdit command, then press Enter to approve.\nEsc returns to approve/deny.",
            prompt.edited_command, prompt.reason
        )
    } else {
        format!(
            "Approval required\n\nCommand:\n{}\n\nReason:\n{}\n\n[a] approve   [d] deny   [e] edit",
            prompt.command, prompt.reason
        )
    };
    let block = Block::default()
        .borders(Borders::ALL)
        .border_type(BorderType::Rounded)
        .title(" Approval ");
    frame.render_widget(
        Paragraph::new(body).block(block).wrap(Wrap { trim: false }),
        area,
    );
}

fn render_question_modal(frame: &mut Frame, app: &App) {
    let Some(prompt) = &app.user_question_prompt else {
        return;
    };
    let area = centered_rect(frame.size(), 70, 34);
    frame.render_widget(Clear, area);
    let mut lines = vec![Line::from(prompt.question.as_str()), Line::from("")];
    for (idx, choice) in prompt.choices.iter().enumerate() {
        let prefix = if idx == prompt.selected { "> " } else { "  " };
        lines.push(Line::from(format!("{prefix}{}: {}", idx + 1, choice)));
    }
    lines.push(Line::from(""));
    lines.push(Line::from("Use arrows or number keys, then Enter."));
    let block = Block::default()
        .borders(Borders::ALL)
        .border_type(BorderType::Rounded)
        .title(" Question ");
    frame.render_widget(
        Paragraph::new(Text::from(lines))
            .block(block)
            .wrap(Wrap { trim: false }),
        area,
    );
}

fn centered_rect(area: Rect, width_percent: u16, height_percent: u16) -> Rect {
    let vertical = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Percentage((100 - height_percent) / 2),
            Constraint::Percentage(height_percent),
            Constraint::Percentage((100 - height_percent) / 2),
        ])
        .split(area);
    let horizontal = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([
            Constraint::Percentage((100 - width_percent) / 2),
            Constraint::Percentage(width_percent),
            Constraint::Percentage((100 - width_percent) / 2),
        ])
        .split(vertical[1]);
    horizontal[1]
}

// ─── Transcript ────────────────────────────────────────────────────────────

fn render_transcript(frame: &mut Frame, app: &App, area: Rect) {
    let focused = app.focus == FocusedPanel::Chat && app.terminal_focused;
    let border_style = if focused {
        palette::focused_border_style()
    } else {
        palette::unfocused_border_style()
    };

    let block = Block::default()
        .borders(Borders::ALL)
        .border_type(BorderType::Rounded)
        .border_style(border_style)
        .title(Span::styled(" Chat ", panel_title_style(focused)));

    let inner = block.inner(area);
    frame.render_widget(block, area);

    let gutter = GUTTER as usize;
    let mut lines: Vec<Line> = Vec::new();

    for msg in &app.transcript {
        let (icon, role_label, fg) = match msg.role {
            MessageRole::User => ("▶", "you  ", palette::role_user_fg()),
            MessageRole::System => ("·", "sys  ", palette::role_system_fg()),
            MessageRole::Mission => ("◆", "plan ", palette::role_mission_fg()),
            MessageRole::AgentOutput => (" ", "     ", palette::role_agent_fg()),
            MessageRole::Error => ("✗", "err  ", palette::role_error_fg()),
            MessageRole::Info => ("·", "info ", palette::role_info_fg()),
        };

        let ts = msg.timestamp.format("%H:%M:%S").to_string();
        let role_style = Style::default().fg(fg).bold();
        let body_style = Style::default().fg(fg);

        let prefix_width = gutter + ts.len() + 1 + 1 + 1 + role_label.len();
        let body_width = (inner.width as usize).saturating_sub(prefix_width).max(1);
        let cont_indent = " ".repeat(prefix_width);

        let mut first_segment_of_msg = true;
        for content_line in msg.content.lines() {
            let wrapped = wrap_to_width(content_line, body_width);
            for segment in wrapped {
                let body_span = render_diff_aware_span(&segment, body_style);
                if first_segment_of_msg {
                    lines.push(Line::from(vec![
                        Span::styled(format!("{:>gutter$}", ""), palette::dim_style()),
                        Span::styled(format!("{ts} "), palette::dim_style()),
                        Span::styled(icon, role_style),
                        Span::raw(" "),
                        Span::styled(role_label, role_style),
                        body_span,
                    ]));
                    first_segment_of_msg = false;
                } else {
                    lines.push(Line::from(vec![Span::raw(cont_indent.clone()), body_span]));
                }
            }
        }
    }

    // Apply scroll offset (from bottom).
    let total = lines.len();
    let visible = inner.height as usize;
    let start = if total > visible + app.scroll_offset {
        total - visible - app.scroll_offset
    } else {
        0
    };
    let visible_lines: Vec<Line> = lines.into_iter().skip(start).collect();

    let para = Paragraph::new(Text::from(visible_lines));
    frame.render_widget(para, inner);

    // Scroll indicator in top-right corner of transcript.
    if app.scroll_offset > 0 {
        let indicator = format!(" ↑ {} ", app.scroll_offset);
        let ind_width = indicator.width() as u16;
        if inner.width > ind_width + 2 {
            let ind_rect = Rect {
                x: inner.x + inner.width - ind_width - 1,
                y: inner.y,
                width: ind_width,
                height: 1,
            };
            let ind_para = Paragraph::new(indicator).style(
                Style::default()
                    .fg(palette::role_info_fg())
                    .bg(palette::header_bg()),
            );
            frame.render_widget(ind_para, ind_rect);
        }
    }
}

// ─── Composer ──────────────────────────────────────────────────────────────

fn render_composer(frame: &mut Frame, app: &App, area: Rect) {
    let focused = app.focus == FocusedPanel::Chat && app.terminal_focused;
    let border_style = if focused {
        palette::focused_border_style()
    } else {
        palette::unfocused_border_style()
    };

    // Border color signals focus; the title is just a plain label.
    let title = Span::styled(" Input ", panel_title_style(focused));

    let block = Block::default()
        .borders(Borders::ALL)
        .border_type(BorderType::Rounded)
        .border_style(border_style)
        .title(title);

    let inner = block.inner(area);
    frame.render_widget(block, area);

    const PROMPT_WIDTH: u16 = 2;
    let prompt_width = PROMPT_WIDTH.min(inner.width);
    let prompt_area = Rect {
        x: inner.x,
        y: inner.y,
        width: prompt_width,
        height: inner.height,
    };
    let text_area = Rect {
        x: inner.x + prompt_width,
        y: inner.y,
        width: inner.width.saturating_sub(prompt_width),
        height: inner.height,
    };

    // Prompt column: "> " on the first row, "  " on continuation rows so that
    // multi-line input reads as a single indented block.
    let prompt_lines: Vec<Line> = (0..inner.height)
        .map(|i| {
            if i == 0 {
                Line::from(Span::styled(
                    "> ",
                    Style::default().fg(palette::dim_border()),
                ))
            } else {
                Line::from(Span::raw("  "))
            }
        })
        .collect();
    frame.render_widget(Paragraph::new(prompt_lines), prompt_area);

    // ── Empty input: show a dim placeholder with a reversed cursor cell ──
    if app.input.is_empty() {
        let placeholder_line = Line::from(vec![
            Span::styled(
                " ",
                Style::default()
                    .fg(Color::White)
                    .add_modifier(Modifier::BOLD | Modifier::REVERSED),
            ),
            Span::styled(
                "Describe a task…  ",
                palette::dim_style().add_modifier(Modifier::ITALIC),
            ),
            Span::styled(
                "Shift+Enter",
                Style::default()
                    .fg(palette::hint_key_fg())
                    .add_modifier(Modifier::BOLD),
            ),
            Span::styled(" for newline", palette::dim_style()),
        ]);
        frame.render_widget(Paragraph::new(placeholder_line), text_area);
        return;
    }

    // ── Multi-line input ─────────────────────────────────────────────────
    let input_lines: Vec<&str> = app.input.split('\n').collect();

    // Find which rendered row and byte offset within that row the cursor sits.
    let (cursor_row, row_start_byte) = locate_cursor(&app.input, app.cursor);
    let current_line = input_lines[cursor_row];
    let col_byte = app
        .cursor
        .saturating_sub(row_start_byte)
        .min(current_line.len());

    let mut text_lines: Vec<Line> = Vec::with_capacity(input_lines.len());
    for (i, line_s) in input_lines.iter().enumerate() {
        if i == cursor_row {
            let before = &line_s[..col_byte];
            let (at, after) = if col_byte < line_s.len() {
                let tail = &line_s[col_byte..];
                let g_len = tail.graphemes(true).next().map(str::len).unwrap_or(0);
                if g_len == 0 {
                    (" ", "")
                } else {
                    (&tail[..g_len], &tail[g_len..])
                }
            } else {
                (" ", "")
            };
            text_lines.push(Line::from(vec![
                Span::styled(before, Style::default().fg(Color::White)),
                Span::styled(
                    at,
                    Style::default()
                        .fg(Color::White)
                        .add_modifier(Modifier::BOLD | Modifier::REVERSED),
                ),
                Span::styled(after, Style::default().fg(Color::White)),
            ]));
        } else {
            text_lines.push(Line::from(Span::styled(
                *line_s,
                Style::default().fg(Color::White),
            )));
        }
    }

    // Horizontal scroll — keep the cursor column in view for the current row.
    let cursor_col = current_line[..col_byte].width();
    let visible_w = text_area.width as usize;
    let scroll_x: u16 = if visible_w == 0 {
        0
    } else if cursor_col + 1 > visible_w {
        let target = visible_w.saturating_sub(4);
        cursor_col.saturating_sub(target) as u16
    } else {
        0
    };

    // Vertical scroll — keep the cursor row in view when input grows beyond
    // the composer's visible height.
    let visible_h = text_area.height as usize;
    let scroll_y: u16 = if text_lines.len() > visible_h && visible_h > 0 {
        cursor_row.saturating_sub(visible_h - 1) as u16
    } else {
        0
    };

    let para = Paragraph::new(text_lines).scroll((scroll_y, scroll_x));
    frame.render_widget(para, text_area);
}

/// Given `input` and a byte-offset cursor position, return (row_index,
/// row_start_byte_offset) so the renderer knows which line the cursor sits on
/// and where that line begins in the buffer.
fn locate_cursor(input: &str, cursor: usize) -> (usize, usize) {
    let mut row = 0usize;
    let mut start = 0usize;
    for (i, byte) in input.as_bytes().iter().enumerate() {
        if i >= cursor {
            break;
        }
        if *byte == b'\n' {
            row += 1;
            start = i + 1;
        }
    }
    (row, start)
}

// ─── Completion popup ──────────────────────────────────────────────────────

fn render_completion_popup(frame: &mut Frame, app: &App, composer_area: Rect) {
    if app.completions.is_empty() {
        return;
    }

    let popup_height = (app.completions.len() as u16).min(8) + 2; // +2 for borders

    const POPUP_TITLE_FLOOR: u16 = 17;
    let entries_width = app
        .completions
        .iter()
        .map(|s| s.len() + 3) // "/ " prefix + padding
        .max()
        .unwrap_or(12) as u16
        + 4;
    let popup_width = entries_width.max(POPUP_TITLE_FLOOR);

    // Position popup just above the composer.
    let popup_y = composer_area.y.saturating_sub(popup_height);
    let popup_x = composer_area.x + 2; // align with "> " prompt
    let popup_rect = Rect {
        x: popup_x,
        y: popup_y,
        width: popup_width.min(frame.size().width.saturating_sub(popup_x)),
        height: popup_height,
    };

    let items: Vec<ListItem> = app
        .completions
        .iter()
        .enumerate()
        .map(|(i, cmd)| {
            let selected = i == app.completion_idx.saturating_sub(1) % app.completions.len();
            let style = if selected {
                Style::default()
                    .fg(Color::Black)
                    .bg(palette::focus_border())
            } else {
                Style::default().fg(Color::White)
            };
            ListItem::new(Line::from(vec![
                Span::styled("/", palette::dim_style()),
                Span::styled(*cmd, style),
            ]))
        })
        .collect();

    let popup_block = Block::default()
        .borders(Borders::ALL)
        .border_type(BorderType::Rounded)
        .border_style(Style::default().fg(palette::focus_border()))
        .title(Span::styled(" Tab: complete ", palette::dim_style()));

    let list = List::new(items).block(popup_block);
    frame.render_widget(list, popup_rect);
}

// ─── Live status strip ─────────────────────────────────────────────────────

/// Whether the shelf has at least one entry currently in the Running state.
fn has_running_entry(app: &App) -> bool {
    app.shelf
        .iter()
        .any(|entry| entry.state_color == ShelfColor::Running)
}

/// A single-row status line shown above the composer when at least one
/// sandbox task is running. Format:
///
///    ⠋  1 running · [02bf30c1] Booting sandbox…
fn render_status_strip(frame: &mut Frame, app: &App, area: Rect) {
    let running = app
        .shelf
        .iter()
        .filter(|e| e.state_color == ShelfColor::Running)
        .count();

    // Prefer the `active_task_count` if it disagrees with the shelf — that's
    // the dispatcher's authoritative view and the shelf may lag briefly.
    let count = app.active_task_count.max(running);
    if count == 0 {
        return;
    }

    let latest = app
        .shelf
        .iter()
        .find(|e| e.state_color == ShelfColor::Running);

    let mut spans = vec![
        Span::raw("  "),
        Span::styled(
            palette::spinner_frame(app.tick),
            Style::default().fg(palette::shelf_running()).bold(),
        ),
        Span::raw("  "),
        Span::styled(
            count.to_string(),
            Style::default().fg(palette::shelf_running()).bold(),
        ),
        Span::styled(" running", palette::dim_style()),
    ];

    if let Some(entry) = latest {
        spans.push(Span::styled("  ·  ", palette::dim_style()));
        spans.push(Span::styled(
            format!("[{}]", short_task_id(&entry.task_id)),
            Style::default().fg(palette::role_info_fg()).bold(),
        ));
        spans.push(Span::raw(" "));
        // Phase: latest note, truncated to fit within the remaining width.
        let used: usize = spans.iter().map(|s| s.content.width()).sum();
        let remaining = (area.width as usize).saturating_sub(used + 2);
        spans.push(Span::styled(
            word_truncate(&entry.last_note, remaining.max(10)),
            Style::default().fg(Color::White),
        ));
    }

    let strip = Paragraph::new(Line::from(spans));
    frame.render_widget(strip, area);
}

// ─── Help overlay ──────────────────────────────────────────────────────────

fn render_help_overlay(frame: &mut Frame, app: &App) {
    let area = frame.size();
    // Centered, bounded so we never render smaller than a minimum useful size
    // and never larger than roughly 80×28. The overlay is clamped to fit the
    // current terminal so narrow windows still work.
    let max_w: u16 = 80;
    let max_h: u16 = 28;
    let w = area
        .width
        .saturating_sub(4)
        .min(max_w)
        .max(30)
        .min(area.width);
    let h = area
        .height
        .saturating_sub(2)
        .min(max_h)
        .max(10)
        .min(area.height);
    let x = area.x + (area.width.saturating_sub(w)) / 2;
    let y = area.y + (area.height.saturating_sub(h)) / 2;
    let rect = Rect {
        x,
        y,
        width: w,
        height: h,
    };

    // Blank out whatever was behind, so the modal reads as a lifted surface.
    frame.render_widget(Clear, rect);

    let block = Block::default()
        .borders(Borders::ALL)
        .border_type(BorderType::Rounded)
        .border_style(Style::default().fg(palette::focus_border()))
        .title(Span::styled(
            " Slash Commands ",
            Style::default().fg(Color::White).bold(),
        ));
    let inner = block.inner(rect);
    frame.render_widget(block, rect);

    // Split the inner area: body + 1-row footer hint inside the modal.
    let v = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Min(1), Constraint::Length(1)])
        .split(inner);

    let lines = build_help_lines(v[0].width as usize);
    let visible = v[0].height as usize;
    let max_scroll = lines.len().saturating_sub(visible);
    let scroll = app.help_scroll.min(max_scroll) as u16;
    let body = Paragraph::new(lines).scroll((scroll, 0));
    frame.render_widget(body, v[0]);

    let hint = Line::from(vec![
        Span::styled(" ", palette::dim_style()),
        hint_key("↑/↓"),
        Span::styled(" scroll  ", palette::dim_style()),
        hint_key("Esc"),
        Span::styled(" / ", palette::dim_style()),
        hint_key("Enter"),
        Span::styled(" close", palette::dim_style()),
    ]);
    frame.render_widget(Paragraph::new(hint), v[1]);
}

fn build_help_lines(width: usize) -> Vec<Line<'static>> {
    const NAME_COL: usize = 14;
    const INDENT: &str = "  ";
    let mut out: Vec<Line<'static>> = Vec::new();

    out.push(Line::from(Span::styled(
        "Type a command below, or press a listed key to control the session.",
        palette::dim_style(),
    )));
    out.push(Line::raw(""));

    for cmd in SlashCommand::iter() {
        let name = format!("/{}", cmd.command());
        let desc = cmd.description().to_string();
        let body_width = width.saturating_sub(INDENT.len() + NAME_COL + 2).max(10);
        let wrapped = wrap_to_width(&desc, body_width);
        for (i, segment) in wrapped.into_iter().enumerate() {
            let mut spans: Vec<Span<'static>> = Vec::with_capacity(4);
            spans.push(Span::raw(INDENT));
            if i == 0 {
                spans.push(Span::styled(
                    format!("{:<NAME_COL$}", name),
                    Style::default().fg(palette::role_info_fg()).bold(),
                ));
            } else {
                spans.push(Span::raw(format!("{:<NAME_COL$}", "")));
            }
            spans.push(Span::raw("  "));
            spans.push(Span::styled(segment, Style::default().fg(Color::White)));
            out.push(Line::from(spans));
        }
    }

    out.push(Line::raw(""));
    out.push(Line::from(vec![
        Span::raw(INDENT),
        Span::styled("Keybinds", Style::default().fg(Color::White).bold()),
    ]));
    for (k, v) in &[
        ("Enter", "send the composed message"),
        ("Shift+Enter", "insert a newline in the composer"),
        (
            "Tab",
            "autocomplete /slash commands · cycle focus to the shelf",
        ),
        ("↑ / ↓", "move between rows of multi-line input"),
        ("PgUp / PgDn", "scroll the transcript"),
        ("Ctrl+W", "delete the previous word"),
        ("Ctrl+U", "delete from cursor to start of line"),
        ("Ctrl+C", "quit"),
    ] {
        out.push(Line::from(vec![
            Span::raw(INDENT),
            Span::styled(
                format!("{:<NAME_COL$}", k),
                Style::default().fg(palette::hint_key_fg()).bold(),
            ),
            Span::raw("  "),
            Span::styled(v.to_string(), Style::default().fg(Color::White)),
        ]));
    }

    out
}

// ─── Footer ────────────────────────────────────────────────────────────────

fn render_footer(frame: &mut Frame, app: &App, area: Rect) {
    let hints: Line = if app.focus == FocusedPanel::Chat {
        let shelf_visible = area.width >= SHELF_MIN_TERM_WIDTH && !app.shelf.is_empty();
        let mut spans = vec![
            hint_key("Enter"),
            Span::styled(": send  ", palette::footer_fg()),
        ];
        if app.input.starts_with('/') {
            spans.push(hint_key("Tab"));
            spans.push(Span::styled(": complete  ", palette::footer_fg()));
        } else if shelf_visible {
            spans.push(hint_key("Tab"));
            spans.push(Span::styled(": inspect shelf  ", palette::footer_fg()));
        }
        spans.extend([
            hint_key("PgUp/Dn"),
            Span::styled(": scroll  ", palette::footer_fg()),
            hint_key("Ctrl+C"),
            Span::styled(": quit  ", palette::footer_fg()),
            hint_key("/help"),
            Span::styled(": commands", palette::footer_fg()),
        ]);
        Line::from(spans)
    } else {
        Line::from(vec![
            hint_key("Tab/Esc"),
            Span::styled(": back to chat  ", palette::footer_fg()),
            hint_key("j/k"),
            Span::styled(": navigate  ", palette::footer_fg()),
            hint_key("a"),
            Span::styled(": apply  ", palette::footer_fg()),
            hint_key("d"),
            Span::styled(": discard", palette::footer_fg()),
        ])
    };

    let footer = Paragraph::new(hints).style(Style::default().bg(Color::Black));
    frame.render_widget(footer, area);
}

fn hint_key(label: &'static str) -> Span<'static> {
    Span::styled(label, Style::default().fg(palette::hint_key_fg()).bold())
}

fn panel_title_style(focused: bool) -> Style {
    if focused {
        Style::default()
            .fg(palette::focus_border())
            .add_modifier(Modifier::BOLD | Modifier::REVERSED)
    } else {
        Style::default().fg(Color::White).bold()
    }
}

// ─── Shelf ─────────────────────────────────────────────────────────────────

fn render_shelf(frame: &mut Frame, app: &App, area: Rect) {
    let focused = app.focus == FocusedPanel::Shelf && app.terminal_focused;
    let border_style = if focused {
        palette::focused_border_style()
    } else {
        palette::unfocused_border_style()
    };

    let title = Line::from(vec![
        Span::raw(" "),
        Span::styled("Sandboxes", panel_title_style(focused)),
        if !app.shelf.is_empty() {
            Span::styled(format!(" ({})", app.shelf.len()), palette::dim_style())
        } else {
            Span::raw("")
        },
        Span::raw(" "),
    ]);

    let block = Block::default()
        .borders(Borders::ALL)
        .border_type(BorderType::Rounded)
        .border_style(border_style)
        .title(title);

    let inner = block.inner(area);
    frame.render_widget(block, area);

    if app.shelf.is_empty() {
        let empty = Paragraph::new("No sandboxes yet")
            .style(palette::dim_style())
            .alignment(Alignment::Center);
        frame.render_widget(empty, inner);
        return;
    }

    let shelf_chunks = if inner.height >= 14 {
        Layout::default()
            .direction(Direction::Vertical)
            .constraints([Constraint::Min(6), Constraint::Length(7)])
            .split(inner)
    } else {
        Layout::default()
            .direction(Direction::Vertical)
            .constraints([Constraint::Min(1)])
            .split(inner)
    };
    let list_area = shelf_chunks[0];
    let detail_area = shelf_chunks.get(1).copied();
    let max_summary_w = (list_area.width as usize).saturating_sub(6);

    let items: Vec<ListItem> = app
        .shelf
        .iter()
        .enumerate()
        .map(|(i, entry)| {
            let state_color = match entry.state_color {
                ShelfColor::Running => palette::shelf_running(),
                ShelfColor::Preserved => palette::shelf_preserved(),
                ShelfColor::Merged => palette::shelf_merged(),
                ShelfColor::Discarded => palette::shelf_discarded(),
                ShelfColor::Failed => palette::shelf_failed(),
                ShelfColor::Conflicts => palette::shelf_conflicts(),
                ShelfColor::TimedOut => palette::shelf_timed_out(),
            };

            let selected = i == app.shelf_selected && app.focus == FocusedPanel::Shelf;
            let row_bg = if selected {
                palette::shelf_selected_bg()
            } else {
                Color::Reset
            };

            // State icon.
            let icon = match entry.state_color {
                ShelfColor::Running => palette::spinner_frame(app.tick),
                ShelfColor::Preserved => "◎",
                ShelfColor::Merged => "✓",
                ShelfColor::Discarded => "✗",
                ShelfColor::Failed => "✗",
                ShelfColor::Conflicts => "⚡",
                ShelfColor::TimedOut => "⌛",
            };

            // Use the short UUID suffix (e.g. "02bf30c1") — dense and scannable.
            // The full id is still visible in the Selection detail pane below.
            let id_short = short_task_id(&entry.task_id).to_string();

            // Truncate summary and note at word boundaries so we don't cut
            // mid-word (e.g. "make the readme add a trai…").
            let summary = word_truncate(&entry.prompt_summary, max_summary_w);
            let note = word_truncate(&entry.last_note, max_summary_w);
            let provider_model = match entry.model.as_deref().filter(|m| !m.is_empty()) {
                Some(m) => format!("{}/{}", entry.provider, m),
                None => entry.provider.clone(),
            };

            let mut status_spans: Vec<Span> = vec![
                Span::raw(" "),
                Span::styled(icon, Style::default().fg(state_color).bold()),
                Span::raw(" "),
                Span::styled(
                    format!("{:<9}", entry.state_label),
                    Style::default().fg(state_color),
                ),
                Span::styled(
                    human_elapsed(entry.started_at),
                    Style::default().fg(palette::dim_border()),
                ),
            ];
            if let Some(action) = entry.pending_action {
                status_spans.push(Span::styled("  → ", palette::dim_style()));
                status_spans.push(Span::styled(
                    palette::spinner_frame(app.tick),
                    Style::default().fg(palette::focus_border()).bold(),
                ));
                status_spans.push(Span::raw(" "));
                status_spans.push(Span::styled(
                    action.label(),
                    Style::default().fg(palette::focus_border()).bold(),
                ));
                status_spans.push(Span::styled("…", palette::dim_style()));
            }

            ListItem::new(vec![
                Line::from(status_spans).style(Style::default().bg(row_bg)),
                Line::from(vec![
                    Span::raw("   "),
                    Span::styled(id_short, Style::default().fg(Color::White).bold()),
                    Span::styled("  ", palette::dim_style()),
                    Span::styled(provider_model, palette::dim_style()),
                ])
                .style(Style::default().bg(row_bg)),
                Line::from(vec![
                    Span::raw("   "),
                    Span::styled(summary, Style::default().fg(Color::White)),
                ])
                .style(Style::default().bg(row_bg)),
                Line::from(vec![
                    Span::raw("   "),
                    Span::styled(note, palette::dim_style()),
                ])
                .style(Style::default().bg(row_bg)),
                Line::raw(""),
            ])
        })
        .collect();

    let mut list_state = ListState::default();
    if app.focus == FocusedPanel::Shelf {
        list_state.select(Some(app.shelf_selected));
    }

    let list = List::new(items);
    frame.render_stateful_widget(list, list_area, &mut list_state);

    if let Some(detail_area) = detail_area {
        render_shelf_detail(frame, app, detail_area);
    }
}

fn render_shelf_detail(frame: &mut Frame, app: &App, area: Rect) {
    let block = Block::default()
        .borders(Borders::TOP)
        .border_style(palette::unfocused_border_style())
        .title(Span::styled(
            " Selection ",
            Style::default().fg(Color::White).bold(),
        ));
    let inner = block.inner(area);
    frame.render_widget(block, area);

    let Some(entry) = app.selected_shelf_entry() else {
        return;
    };

    let provider_model = match entry.model.as_deref().filter(|m| !m.is_empty()) {
        Some(m) => format!("{}/{}", entry.provider, m),
        None => entry.provider.clone(),
    };
    let pad = || Span::raw(" ");
    let detail = vec![
        Line::from(vec![
            pad(),
            Span::styled(
                entry.state_label.clone(),
                Style::default()
                    .fg(state_color(entry.state_color.clone()))
                    .bold(),
            ),
            Span::styled("  ", palette::dim_style()),
            Span::styled(provider_model, palette::dim_style()),
        ]),
        Line::from(vec![
            pad(),
            Span::styled(
                entry.task_id.clone(),
                Style::default().fg(Color::White).bold(),
            ),
        ]),
        Line::from(vec![
            pad(),
            Span::styled(
                entry.prompt_summary.clone(),
                Style::default().fg(Color::White),
            ),
        ]),
        Line::from(vec![
            pad(),
            Span::styled("started ", palette::dim_style()),
            Span::styled(
                entry.started_at.format("%H:%M:%S").to_string(),
                Style::default().fg(Color::White),
            ),
            Span::styled("  ·  ", palette::dim_style()),
            Span::styled("updated ", palette::dim_style()),
            Span::styled(
                entry.updated_at.format("%H:%M:%S").to_string(),
                Style::default().fg(Color::White),
            ),
        ]),
        Line::from(vec![
            pad(),
            Span::styled(entry.last_note.clone(), palette::dim_style()),
        ]),
    ];
    let para = Paragraph::new(detail).wrap(Wrap { trim: false });
    frame.render_widget(para, inner);
}

/// Word-wrap `text` so each returned line's display width is at most `width`.
fn wrap_to_width(text: &str, width: usize) -> Vec<String> {
    if text.is_empty() || width == 0 {
        return vec![text.to_string()];
    }
    if text.width() <= width {
        return vec![text.to_string()];
    }

    let mut out: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut current_w = 0usize;

    for word in text.split_whitespace() {
        let word_w = word.width();
        if current.is_empty() {
            if word_w > width {
                push_hard_broken(&mut out, &mut current, &mut current_w, word, width);
            } else {
                current.push_str(word);
                current_w = word_w;
            }
        } else if current_w + 1 + word_w <= width {
            current.push(' ');
            current.push_str(word);
            current_w += 1 + word_w;
        } else {
            out.push(std::mem::take(&mut current));
            current_w = 0;
            if word_w > width {
                push_hard_broken(&mut out, &mut current, &mut current_w, word, width);
            } else {
                current.push_str(word);
                current_w = word_w;
            }
        }
    }

    if !current.is_empty() {
        out.push(current);
    }
    if out.is_empty() {
        out.push(String::new());
    }
    out
}

fn push_hard_broken(
    out: &mut Vec<String>,
    current: &mut String,
    current_w: &mut usize,
    word: &str,
    width: usize,
) {
    for ch in word.chars() {
        let cw = UnicodeWidthChar::width(ch).unwrap_or(0);
        if *current_w + cw > width && !current.is_empty() {
            out.push(std::mem::take(current));
            *current_w = 0;
        }
        current.push(ch);
        *current_w += cw;
    }
}

/// Truncate `text` to at most `max_chars` display characters, preferring a
/// word boundary — so we don't emit "make the readme add a trai…". Falls back
/// to a hard cut if there's no whitespace in range. An ellipsis is appended
/// when truncation actually happened.
fn word_truncate(text: &str, max_chars: usize) -> String {
    if max_chars == 0 {
        return String::new();
    }
    let total = text.chars().count();
    if total <= max_chars {
        return text.to_string();
    }
    if max_chars == 1 {
        return "…".to_string();
    }

    // Collect up to max_chars-1 chars (reserve 1 for the ellipsis), then walk
    // back to the last whitespace char so we don't split a word.
    let budget = max_chars - 1;
    let head: String = text.chars().take(budget).collect();
    let cut = head.rfind(char::is_whitespace).unwrap_or(head.len());
    // Only accept the word boundary if it leaves something meaningful (at
    // least a third of the budget); otherwise fall back to a hard cut.
    let trimmed = if cut >= budget / 3 {
        head[..cut].trim_end().to_string()
    } else {
        head
    };
    format!("{trimmed}…")
}

fn human_elapsed(started_at: chrono::DateTime<chrono::Local>) -> String {
    let elapsed = chrono::Local::now().signed_duration_since(started_at);
    let seconds = elapsed.num_seconds().max(0);
    if seconds < 60 {
        format!(" {:>3}s", seconds)
    } else if seconds < 3600 {
        format!(" {:>3}m", seconds / 60)
    } else {
        format!(" {:>3}h", seconds / 3600)
    }
}

/// Colorise a single line from a unified-diff-ish payload.
/// Lines starting with `+`/`-` (but not `+++`/`---` file headers) and `@@`
/// hunk headers get diff-flavoured colors; everything else inherits
/// `fallback`.
fn render_diff_aware_span(line: &str, fallback: Style) -> Span<'static> {
    if line.starts_with("@@") {
        Span::styled(line.to_string(), Style::default().fg(palette::diff_hunk()))
    } else if line.starts_with("+++") || line.starts_with("---") {
        Span::styled(line.to_string(), fallback.fg(palette::diff_hunk()))
    } else if line.starts_with('+') {
        Span::styled(line.to_string(), Style::default().fg(palette::diff_added()))
    } else if line.starts_with('-') && !line.starts_with("--") {
        Span::styled(
            line.to_string(),
            Style::default().fg(palette::diff_removed()),
        )
    } else {
        Span::styled(line.to_string(), fallback)
    }
}

fn state_color(color: ShelfColor) -> Color {
    match color {
        ShelfColor::Running => palette::shelf_running(),
        ShelfColor::Preserved => palette::shelf_preserved(),
        ShelfColor::Merged => palette::shelf_merged(),
        ShelfColor::Discarded => palette::shelf_discarded(),
        ShelfColor::Failed => palette::shelf_failed(),
        ShelfColor::Conflicts => palette::shelf_conflicts(),
        ShelfColor::TimedOut => palette::shelf_timed_out(),
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use chrono::Local;
    use ratatui::{backend::TestBackend, Terminal};
    use tokio::sync::mpsc;

    use bakudo_core::{config::BakudoConfig, provider::ProviderRegistry, state::SandboxLedger};

    use crate::app::{App, FocusedPanel, ShelfEntry};

    use super::render;

    #[test]
    fn render_includes_header_context_and_selection_detail() {
        let (cmd_tx, _cmd_rx) = mpsc::channel(4);
        let (_event_tx, event_rx) = mpsc::channel(4);
        let mut app = App::new(
            Arc::new(BakudoConfig::default()),
            Arc::new(ProviderRegistry::with_defaults()),
            Arc::new(SandboxLedger::new()),
            cmd_tx,
            event_rx,
            None,
            true,
        );
        app.provider_id = "codex".to_string();
        app.model = Some("gpt-5".to_string());
        app.focus = FocusedPanel::Shelf;
        app.active_task_count = 1;
        app.shelf.push_back(ShelfEntry {
            task_id: "task-render".to_string(),
            provider: "codex".to_string(),
            model: Some("gpt-5".to_string()),
            prompt_summary: "Make the TUI feel native.".to_string(),
            last_note: "Summarizing diffs before applying the fix.".to_string(),
            state_label: "running".to_string(),
            state_color: crate::app::ShelfColor::Running,
            started_at: Local::now(),
            updated_at: Local::now(),
            pending_action: None,
        });

        let backend = TestBackend::new(120, 30);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal.draw(|frame| render(frame, &app)).unwrap();

        let buffer = terminal.backend().buffer();
        let rendered = buffer_to_string(buffer);
        assert!(rendered.contains("provider: codex"));
        assert!(rendered.contains("policy review"));
        assert!(rendered.contains("Selection"));
        assert!(rendered.contains("task-render"));
        assert!(rendered.contains("Summarizing diffs"));
    }

    fn buffer_to_string(buffer: &ratatui::buffer::Buffer) -> String {
        let mut rendered = String::new();
        for y in 0..buffer.area.height {
            for x in 0..buffer.area.width {
                rendered.push_str(buffer.get(x, y).symbol());
            }
            rendered.push('\n');
        }
        rendered
    }

    fn fresh_app() -> App {
        let (cmd_tx, _cmd_rx) = mpsc::channel(4);
        let (_event_tx, event_rx) = mpsc::channel(4);
        App::new(
            Arc::new(BakudoConfig::default()),
            Arc::new(ProviderRegistry::with_defaults()),
            Arc::new(SandboxLedger::new()),
            cmd_tx,
            event_rx,
            None,
            true,
        )
    }

    fn render_to_string(app: &App, cols: u16, rows: u16) -> String {
        let backend = TestBackend::new(cols, rows);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal.draw(|frame| render(frame, app)).unwrap();
        buffer_to_string(terminal.backend().buffer())
    }

    #[test]
    fn composer_shows_placeholder_when_input_is_empty() {
        let app = fresh_app();
        let rendered = render_to_string(&app, 100, 20);
        assert!(
            rendered.contains("Describe a task"),
            "placeholder should render when input is empty: {rendered}"
        );
    }

    #[test]
    fn composer_renders_multiline_input_on_separate_rows() {
        let mut app = fresh_app();
        app.input = "line one\nline two\nline three".to_string();
        app.cursor = app.input.len();
        let rendered = render_to_string(&app, 100, 24);
        // Each logical line should appear as its own row in the composer.
        let count = rendered.matches("line one").count();
        assert!(count >= 1, "expected 'line one' in output: {rendered}");
        assert!(rendered.contains("line two"));
        assert!(rendered.contains("line three"));
        // Placeholder must not show once input has content.
        assert!(!rendered.contains("Describe a task"));
    }

    #[test]
    fn shelf_hidden_when_empty_at_wide_terminal() {
        let app = fresh_app();
        let rendered = render_to_string(&app, 140, 30);
        assert!(!rendered.contains("Sandboxes"));
        assert!(!rendered.contains("No sandboxes"));
    }

    #[test]
    fn rounded_border_corners_used() {
        let app = fresh_app();
        let rendered = render_to_string(&app, 100, 20);
        // Rounded top-left corner for the Chat and Input blocks.
        assert!(
            rendered.contains('╭'),
            "expected rounded ╭ corner in: {rendered}"
        );
        assert!(rendered.contains('╯'));
    }

    #[test]
    fn help_overlay_renders_slash_commands_when_visible() {
        let mut app = fresh_app();
        app.help_visible = true;
        let rendered = render_to_string(&app, 100, 30);
        assert!(rendered.contains("Slash Commands"));
        assert!(rendered.contains("/provider"));
        assert!(rendered.contains("/help"));
        app.help_scroll = 64;
        let rendered = render_to_string(&app, 100, 30);
        assert!(rendered.contains("Keybinds"));
        assert!(rendered.contains("Shift+Enter"));
    }

    #[test]
    fn status_strip_shows_spinner_and_count_when_tasks_running() {
        let mut app = fresh_app();
        app.active_task_count = 2;
        app.shelf.push_back(ShelfEntry {
            task_id: "bakudo-attempt-02bf30c1-abcd".to_string(),
            provider: "claude".to_string(),
            model: None,
            prompt_summary: "fix the readme".to_string(),
            last_note: "Booting sandbox".to_string(),
            state_label: "running".to_string(),
            state_color: crate::app::ShelfColor::Running,
            started_at: Local::now(),
            updated_at: Local::now(),
            pending_action: None,
        });
        let rendered = render_to_string(&app, 140, 30);
        assert!(rendered.contains("running"));
        assert!(rendered.contains("[02bf30c1]"));
        assert!(rendered.contains("Booting sandbox"));
    }

    #[test]
    fn word_truncate_cuts_at_word_boundary() {
        // Far shorter than text → should cut at last space before budget.
        let got = super::word_truncate("make the readme add a trailing newline", 25);
        assert!(
            !got.contains("trai "),
            "should not cut mid-word, got: {got}"
        );
        assert!(got.ends_with('…'));
        // No-op when text already fits.
        assert_eq!(super::word_truncate("hi", 25), "hi");
    }
}
