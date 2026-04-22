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
    widgets::{Block, Borders, List, ListItem, ListState, Paragraph, Wrap},
    Frame,
};
use unicode_width::UnicodeWidthStr;

use crate::app::{App, FocusedPanel, MessageRole, ShelfColor};
use crate::palette::{
    self, COMPOSER_HEIGHT, FOOTER_HEIGHT, GUTTER, HEADER_HEIGHT, SHELF_MIN_TERM_WIDTH, SHELF_WIDTH,
};

// ─── Top-level render ──────────────────────────────────────────────────────

/// Render the full TUI into `frame`.
pub fn render(frame: &mut Frame, app: &App) {
    let area = frame.size();
    let use_shelf = area.width >= SHELF_MIN_TERM_WIDTH;

    // ── Horizontal split: main | shelf ─────────────────────────────────────
    let h_chunks = if use_shelf {
        Layout::default()
            .direction(Direction::Horizontal)
            .constraints([Constraint::Min(40), Constraint::Length(SHELF_WIDTH)])
            .split(area)
    } else {
        Layout::default()
            .direction(Direction::Horizontal)
            .constraints([Constraint::Percentage(100)])
            .split(area)
    };

    let main_area = h_chunks[0];

    // ── Vertical split: header | transcript | composer | footer ────────────
    let v_chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(HEADER_HEIGHT),
            Constraint::Min(5),
            Constraint::Length(COMPOSER_HEIGHT),
            Constraint::Length(FOOTER_HEIGHT),
        ])
        .split(main_area);

    render_header(frame, app, v_chunks[0]);
    render_transcript(frame, app, v_chunks[1]);
    render_composer(frame, app, v_chunks[2]);
    render_footer(frame, app, v_chunks[3]);

    if use_shelf {
        render_shelf(frame, app, h_chunks[1]);
    }

    // ── Completion popup ────────────────────────────────────────────────────
    if !app.completions.is_empty() && app.focus == FocusedPanel::Chat {
        render_completion_popup(frame, app, v_chunks[2]);
    }
}

// ─── Header ────────────────────────────────────────────────────────────────

fn render_header(frame: &mut Frame, app: &App, area: Rect) {
    let model_str = if app.model.is_empty() {
        "default"
    } else {
        &app.model
    };
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
    let line_2 = Line::from(vec![
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
    ]);

    let header = Paragraph::new(Text::from(vec![line_1, line_2]))
        .style(Style::default().bg(palette::header_bg()));
    frame.render_widget(header, area);
}

// ─── Transcript ────────────────────────────────────────────────────────────

fn render_transcript(frame: &mut Frame, app: &App, area: Rect) {
    let border_style = if app.focus == FocusedPanel::Chat && app.terminal_focused {
        palette::focused_border_style()
    } else {
        palette::unfocused_border_style()
    };

    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(border_style)
        .title(Span::styled(" Chat ", Style::default().fg(Color::White)));

    let inner = block.inner(area);
    frame.render_widget(block, area);

    let gutter = GUTTER as usize;
    let mut lines: Vec<Line> = Vec::new();

    for msg in &app.transcript {
        let (icon, role_label, fg) = match msg.role {
            MessageRole::User => ("▶", "you  ", palette::role_user_fg()),
            MessageRole::System => ("·", "sys  ", palette::role_system_fg()),
            MessageRole::AgentOutput => (" ", "     ", palette::role_agent_fg()),
            MessageRole::Error => ("✗", "err  ", palette::role_error_fg()),
            MessageRole::Info => ("·", "info ", palette::role_info_fg()),
        };

        let ts = msg.timestamp.format("%H:%M:%S").to_string();
        let role_style = Style::default().fg(fg).bold();
        let body_style = Style::default().fg(fg);

        for (i, content_line) in msg.content.lines().enumerate() {
            if i == 0 {
                lines.push(Line::from(vec![
                    Span::styled(format!("{:>gutter$}", ""), palette::dim_style()),
                    Span::styled(format!("{ts} "), palette::dim_style()),
                    Span::styled(icon, role_style),
                    Span::raw(" "),
                    Span::styled(role_label, role_style),
                    Span::styled(content_line.to_string(), body_style),
                ]));
            } else {
                // Continuation lines: indent to align with first-line body.
                let indent = " ".repeat(gutter + ts.len() + 1 + 1 + 1 + role_label.len());
                lines.push(Line::from(vec![
                    Span::raw(indent),
                    Span::styled(content_line.to_string(), body_style),
                ]));
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

    let para = Paragraph::new(Text::from(visible_lines)).wrap(Wrap { trim: false });
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
    let border_style = if app.focus == FocusedPanel::Chat && app.terminal_focused {
        palette::focused_border_style()
    } else {
        palette::unfocused_border_style()
    };

    // Title badge: first letter of provider in brackets.
    let provider_initial = app
        .provider_id
        .chars()
        .next()
        .unwrap_or('?')
        .to_uppercase()
        .to_string();
    let title = Line::from(vec![
        Span::raw(" "),
        Span::styled(
            format!("[{provider_initial}]"),
            Style::default().fg(palette::provider_accent()).bold(),
        ),
        Span::raw(" Input "),
    ]);

    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(border_style)
        .title(title);

    let inner = block.inner(area);
    frame.render_widget(block, area);

    // Render input with a block cursor at the cursor position.
    let before_cursor = &app.input[..app.cursor];
    let at_cursor = if app.cursor < app.input.len() {
        let end = app.input[app.cursor..]
            .char_indices()
            .nth(1)
            .map(|(i, _)| app.cursor + i)
            .unwrap_or(app.input.len());
        &app.input[app.cursor..end]
    } else {
        " "
    };
    let after_cursor = if app.cursor < app.input.len() {
        let end = app.input[app.cursor..]
            .char_indices()
            .nth(1)
            .map(|(i, _)| app.cursor + i)
            .unwrap_or(app.input.len());
        &app.input[end..]
    } else {
        ""
    };

    let prompt_icon = Span::styled("> ", Style::default().fg(palette::dim_border()));
    let line = Line::from(vec![
        prompt_icon,
        Span::styled(before_cursor, Style::default().fg(Color::White)),
        Span::styled(
            at_cursor,
            Style::default()
                .fg(Color::Black)
                .bg(Color::White)
                .add_modifier(Modifier::BOLD),
        ),
        Span::styled(after_cursor, Style::default().fg(Color::White)),
    ]);

    let para = Paragraph::new(line);
    frame.render_widget(para, inner);
}

// ─── Completion popup ──────────────────────────────────────────────────────

fn render_completion_popup(frame: &mut Frame, app: &App, composer_area: Rect) {
    if app.completions.is_empty() {
        return;
    }

    let popup_height = (app.completions.len() as u16).min(8) + 2; // +2 for borders
    let popup_width = app
        .completions
        .iter()
        .map(|s| s.len() + 3) // "/ " prefix + padding
        .max()
        .unwrap_or(12) as u16
        + 4;

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
        .border_style(Style::default().fg(palette::focus_border()))
        .title(Span::styled(" Tab: complete ", palette::dim_style()));

    let list = List::new(items).block(popup_block);
    frame.render_widget(list, popup_rect);
}

// ─── Footer ────────────────────────────────────────────────────────────────

fn render_footer(frame: &mut Frame, app: &App, area: Rect) {
    let hints: Line = if app.focus == FocusedPanel::Chat {
        let tab_hint = if app.input.starts_with('/') {
            ": complete  "
        } else {
            ": inspect shelf  "
        };
        Line::from(vec![
            hint_key("Enter"),
            Span::styled(": send  ", palette::footer_fg()),
            hint_key("Tab"),
            Span::styled(tab_hint, palette::footer_fg()),
            hint_key("PgUp/Dn"),
            Span::styled(": scroll  ", palette::footer_fg()),
            hint_key("Ctrl+C"),
            Span::styled(": quit  ", palette::footer_fg()),
            hint_key("/help"),
            Span::styled(": commands", palette::footer_fg()),
        ])
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

// ─── Shelf ─────────────────────────────────────────────────────────────────

fn render_shelf(frame: &mut Frame, app: &App, area: Rect) {
    let border_style = if app.focus == FocusedPanel::Shelf && app.terminal_focused {
        palette::focused_border_style()
    } else {
        palette::unfocused_border_style()
    };

    let title = Line::from(vec![
        Span::raw(" "),
        Span::styled("Sandboxes", Style::default().fg(Color::White).bold()),
        if !app.shelf.is_empty() {
            Span::styled(format!(" ({})", app.shelf.len()), palette::dim_style())
        } else {
            Span::raw("")
        },
        Span::raw(" "),
    ]);

    let block = Block::default()
        .borders(Borders::ALL)
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

            // Truncate task_id to fit.
            let id_max = (list_area.width as usize).saturating_sub(6);
            let id_short: String = entry.task_id.chars().take(id_max).collect();

            // Truncate summary.
            let summary: String = entry.prompt_summary.chars().take(max_summary_w).collect();
            let note: String = entry.last_note.chars().take(max_summary_w).collect();
            let provider_model = if entry.model.is_empty() {
                entry.provider.clone()
            } else {
                format!("{}/{}", entry.provider, entry.model)
            };

            ListItem::new(vec![
                Line::from(vec![
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
                ])
                .style(Style::default().bg(row_bg)),
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
        .title(Span::styled(" Selection ", palette::dim_style()));
    let inner = block.inner(area);
    frame.render_widget(block, area);

    let Some(entry) = app.selected_shelf_entry() else {
        return;
    };

    let provider_model = if entry.model.is_empty() {
        entry.provider.clone()
    } else {
        format!("{}/{}", entry.provider, entry.model)
    };
    let detail = vec![
        Line::from(vec![
            Span::styled(
                entry.state_label.clone(),
                Style::default()
                    .fg(state_color(entry.state_color.clone()))
                    .bold(),
            ),
            Span::styled("  ", palette::dim_style()),
            Span::styled(provider_model, palette::dim_style()),
        ]),
        Line::from(Span::styled(
            entry.task_id.clone(),
            Style::default().fg(Color::White).bold(),
        )),
        Line::from(Span::styled(
            entry.prompt_summary.clone(),
            Style::default().fg(Color::White),
        )),
        Line::from(vec![
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
        Line::from(Span::styled(entry.last_note.clone(), palette::dim_style())),
    ];
    let para = Paragraph::new(detail).wrap(Wrap { trim: false });
    frame.render_widget(para, inner);
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
        );
        app.provider_id = "codex".to_string();
        app.model = "gpt-5".to_string();
        app.focus = FocusedPanel::Shelf;
        app.active_task_count = 1;
        app.shelf.push_back(ShelfEntry {
            task_id: "task-render".to_string(),
            provider: "codex".to_string(),
            model: "gpt-5".to_string(),
            prompt_summary: "Make the TUI feel native.".to_string(),
            last_note: "Summarizing diffs before applying the fix.".to_string(),
            state_label: "running".to_string(),
            state_color: crate::app::ShelfColor::Running,
            started_at: Local::now(),
            updated_at: Local::now(),
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
}
