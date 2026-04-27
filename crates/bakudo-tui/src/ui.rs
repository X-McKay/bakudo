//! Ratatui UI rendering for bakudo's inline-mode bottom pane.
//!
//! The live viewport stays intentionally compact:
//! - an optional single-row top strip for running status or mission context,
//! - a shaded composer surface,
//! - a one-line footer,
//! - and an optional right-side shelf on wide terminals.

use ratatui::{
    Frame,
    layout::{Alignment, Constraint, Direction, Layout, Rect},
    style::{Color, Modifier, Style, Stylize},
    text::{Line, Span, Text},
    widgets::{Block, BorderType, Borders, Clear, List, ListItem, ListState, Paragraph, Wrap},
};
use unicode_segmentation::UnicodeSegmentation;
use unicode_width::{UnicodeWidthChar, UnicodeWidthStr};

use crate::app::{App, ApprovalAction, FocusedPanel, PopupState, ShelfColor, short_task_id};
use crate::commands::SlashCommand;
use crate::footer::{self, FooterVariant};
use crate::palette::{
    self, FOOTER_HEIGHT, GUTTER, SHELF_MIN_TERM_WIDTH, SHELF_WIDTH, composer_height_for,
};
use crate::status_indicator;
use crate::style::user_message_style;
use strum::IntoEnumIterator;

// ─── Top-level render ──────────────────────────────────────────────────────

/// Render the full TUI into `frame`.
pub fn render(frame: &mut Frame, app: &App) {
    let area = frame.size();
    // Only carve out the shelf column when the terminal is wide enough AND
    // there is at least one sandbox to show — an empty sidebar is chrome,
    // not content.
    let show_shelf = area.width >= SHELF_MIN_TERM_WIDTH && !app.shelf.is_empty();

    // ── Horizontal split: main | shelf ────────────────────────────────────
    let h_chunks = if show_shelf {
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

    // ── Vertical split of main: spacer | top strip | composer | footer ────
    let composer_h = composer_height_for(app.input.split('\n').count());
    let top_strip_h: u16 = if status_indicator::shows_top_strip(app) {
        1
    } else {
        0
    };
    let v_chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Min(0),
            Constraint::Length(top_strip_h),
            Constraint::Length(composer_h),
            Constraint::Length(FOOTER_HEIGHT),
        ])
        .split(main_area);

    if top_strip_h > 0 {
        render_top_strip(frame, app, v_chunks[1]);
    }
    render_composer(frame, app, v_chunks[2]);
    render_footer(frame, app, v_chunks[3], show_shelf);

    if show_shelf {
        render_shelf(frame, app, h_chunks[1]);
    }

    if app.popup.is_some() {
        render_popup(frame, app, v_chunks[2]);
    }

    // ── Help overlay (drawn last so it sits on top of everything) ───────────
    if app.help_visible {
        render_help_overlay(frame, app);
    }
}

#[derive(Clone, Copy)]
enum PopupTone {
    Default,
    Positive,
    Destructive,
}

fn render_popup(frame: &mut Frame, app: &App, composer_area: Rect) {
    let Some(popup) = &app.popup else {
        return;
    };

    match popup {
        PopupState::SlashCommands(commands) if app.focus == FocusedPanel::Chat => {
            let area = slash_popup_rect(frame.size(), composer_area, commands.items.len());
            let lines = build_slash_popup_lines(commands);
            render_popup_surface(frame, area, "Commands", lines);
        }
        PopupState::SlashCommands(_) => {}
        PopupState::Approval(prompt) if prompt.editing => {
            let area = centered_rect_with_min(frame.size(), 78, 68, 58, 13);
            let lines = build_approval_edit_lines(prompt, area.width.saturating_sub(4) as usize);
            render_popup_surface(frame, area, "Approval", lines);
        }
        PopupState::Approval(prompt) => {
            let area = centered_rect_with_min(frame.size(), 78, 62, 58, 13);
            let lines = build_approval_choice_lines(prompt, area.width.saturating_sub(4) as usize);
            render_popup_surface(frame, area, "Approval", lines);
        }
        PopupState::UserQuestion(prompt) => {
            let area = centered_rect_with_min(frame.size(), 74, 58, 54, 10);
            let inner_width = area.width.saturating_sub(4) as usize;
            let lines = if prompt.editing {
                build_question_popup_edit_lines(prompt, inner_width)
            } else {
                build_question_popup_lines(prompt, inner_width)
            };
            render_popup_surface(frame, area, "Question", lines);
        }
    }
}

fn render_popup_surface(frame: &mut Frame, area: Rect, title: &str, lines: Vec<Line<'static>>) {
    frame.render_widget(Clear, area);
    let block = Block::default()
        .borders(Borders::ALL)
        .border_type(BorderType::Rounded)
        .border_style(Style::default().fg(palette::focus_border()))
        .title(Span::styled(
            format!(" {title} "),
            Style::default().fg(Color::White).bold(),
        ));
    let inner = block.inner(area);
    frame.render_widget(block, area);
    frame.render_widget(
        Paragraph::new(Text::from(lines))
            .wrap(Wrap { trim: false })
            .style(Style::default().fg(Color::White)),
        inner,
    );
}

fn slash_popup_rect(frame_area: Rect, composer_area: Rect, item_count: usize) -> Rect {
    let visible_items = item_count.min(8) as u16;
    let popup_height = (visible_items + 3).min(frame_area.height.max(4)); // items + footer + borders
    let popup_x = composer_area.x + 2;
    let max_width = frame_area.width.saturating_sub(popup_x).max(1);
    let popup_width = 34u16.min(max_width).max(22u16.min(max_width));
    let popup_y = composer_area
        .y
        .saturating_sub(popup_height)
        .max(frame_area.y);

    Rect {
        x: popup_x,
        y: popup_y,
        width: popup_width,
        height: popup_height,
    }
}

fn build_slash_popup_lines(commands: &crate::app::SlashCommandPopup) -> Vec<Line<'static>> {
    let mut lines = commands
        .items
        .iter()
        .take(8)
        .enumerate()
        .map(|(idx, command)| {
            popup_option_line(
                "/".to_string(),
                (*command).to_string(),
                None,
                idx == commands.selected,
                PopupTone::Default,
            )
        })
        .collect::<Vec<_>>();
    lines.push(Line::raw(""));
    lines.push(popup_hint_line(&[
        ("Tab/↑/↓", "select"),
        ("Enter", "apply"),
        ("Esc", "close"),
    ]));
    lines
}

fn build_approval_choice_lines(
    prompt: &crate::app::ApprovalPrompt,
    width: usize,
) -> Vec<Line<'static>> {
    let mut lines = vec![Line::from(Span::styled(
        "Approval required",
        Style::default().fg(Color::White).bold(),
    ))];
    lines.push(Line::raw(""));
    lines.extend(labeled_popup_lines("Command", &prompt.command, width));
    lines.push(Line::raw(""));
    lines.extend(labeled_popup_lines("Reason", &prompt.reason, width));
    lines.push(Line::raw(""));

    for action in ApprovalAction::ALL {
        let tone = match action {
            ApprovalAction::Approve => PopupTone::Positive,
            ApprovalAction::Deny => PopupTone::Destructive,
            ApprovalAction::Edit => PopupTone::Default,
        };
        let shortcut = match action {
            ApprovalAction::Edit => "[e] ".to_string(),
            ApprovalAction::Approve => "[a] ".to_string(),
            ApprovalAction::Deny => "[d] ".to_string(),
        };
        lines.push(popup_option_line(
            shortcut,
            action.label().to_string(),
            Some(action.detail().to_string()),
            prompt.selected_action == action,
            tone,
        ));
    }

    lines.push(Line::raw(""));
    lines.push(popup_hint_line(&[
        ("a/d/e", "direct"),
        ("↑/↓", "select"),
        ("Enter", "act"),
        ("Esc", "deny"),
    ]));
    lines
}

fn build_approval_edit_lines(
    prompt: &crate::app::ApprovalPrompt,
    width: usize,
) -> Vec<Line<'static>> {
    let mut lines = vec![Line::from(Span::styled(
        "Edit the command before approving.",
        Style::default().fg(Color::White).bold(),
    ))];
    lines.push(Line::raw(""));
    lines.extend(labeled_popup_lines("Reason", &prompt.reason, width));
    lines.push(Line::raw(""));
    lines.extend(labeled_popup_lines(
        "Command",
        &prompt.edited_command,
        width,
    ));
    lines.push(Line::raw(""));
    lines.push(popup_hint_line(&[
        ("Enter", "approve edit"),
        ("Esc", "back"),
    ]));
    lines
}

fn build_question_popup_lines(
    prompt: &crate::app::UserQuestionPrompt,
    width: usize,
) -> Vec<Line<'static>> {
    let mut lines = vec![Line::from(Span::styled(
        "Answer the question to continue.",
        Style::default().fg(Color::White).bold(),
    ))];
    lines.push(Line::raw(""));
    lines.extend(wrap_popup_text(&prompt.question, width));
    lines.push(Line::raw(""));
    for (idx, choice) in prompt.choices.iter().enumerate() {
        lines.push(popup_option_line(
            format!("{}. ", idx + 1),
            choice.clone(),
            None,
            idx == prompt.selected,
            PopupTone::Default,
        ));
    }
    lines.push(Line::raw(""));
    lines.push(popup_hint_line(&[
        ("↑/↓ or 1-9", "select"),
        ("Enter", "answer"),
        ("c", "custom answer"),
    ]));
    lines
}

fn build_question_popup_edit_lines(
    prompt: &crate::app::UserQuestionPrompt,
    width: usize,
) -> Vec<Line<'static>> {
    let mut lines = vec![Line::from(Span::styled(
        "Type your answer.",
        Style::default().fg(Color::White).bold(),
    ))];
    lines.push(Line::raw(""));
    lines.extend(wrap_popup_text(&prompt.question, width));
    lines.push(Line::raw(""));
    lines.extend(labeled_popup_lines("Answer", &prompt.edited_answer, width));
    lines.push(Line::raw(""));
    let escape_hint = if prompt.choices.is_empty() {
        ("Esc", "cancel")
    } else {
        ("Esc", "back to choices")
    };
    lines.push(popup_hint_line(&[("Enter", "submit"), escape_hint]));
    lines
}

fn labeled_popup_lines(label: &str, value: &str, width: usize) -> Vec<Line<'static>> {
    let mut lines = vec![Line::from(Span::styled(
        format!("{label}:"),
        palette::dim_style(),
    ))];
    lines.extend(
        wrap_popup_text(value, width.saturating_sub(2))
            .into_iter()
            .map(|line| {
                let mut spans = vec![Span::raw("  ")];
                spans.extend(line.spans);
                Line::from(spans)
            }),
    );
    lines
}

fn wrap_popup_text(text: &str, width: usize) -> Vec<Line<'static>> {
    wrap_to_width(text, width.max(8))
        .into_iter()
        .map(|line| Line::from(Span::styled(line, Style::default().fg(Color::White))))
        .collect()
}

fn popup_option_line(
    prefix: String,
    label: String,
    detail: Option<String>,
    selected: bool,
    tone: PopupTone,
) -> Line<'static> {
    let (label_style, detail_style) = popup_option_styles(selected, tone);
    let marker = if selected { "› " } else { "  " };
    let mut spans = vec![
        Span::styled(marker, label_style),
        Span::styled(prefix, label_style),
        Span::styled(label, label_style),
    ];
    if let Some(detail) = detail.filter(|detail| !detail.is_empty()) {
        spans.push(Span::styled("  ", detail_style));
        spans.push(Span::styled(detail, detail_style));
    }
    Line::from(spans)
}

fn popup_option_styles(selected: bool, tone: PopupTone) -> (Style, Style) {
    if selected {
        let style = Style::default()
            .fg(Color::Black)
            .bg(palette::focus_border())
            .add_modifier(Modifier::BOLD);
        return (style, style);
    }

    let label_style = match tone {
        PopupTone::Default => Style::default().fg(Color::White),
        PopupTone::Positive => Style::default().fg(palette::shelf_merged()).bold(),
        PopupTone::Destructive => Style::default().fg(palette::shelf_failed()).bold(),
    };
    (label_style, palette::dim_style())
}

fn popup_hint_line(parts: &[(&'static str, &'static str)]) -> Line<'static> {
    let mut spans = Vec::new();
    for (idx, (key, action)) in parts.iter().enumerate() {
        if idx > 0 {
            spans.push(Span::styled("  ", palette::dim_style()));
        }
        spans.push(hint_key(key));
        spans.push(Span::styled(format!(" {action}"), palette::dim_style()));
    }
    Line::from(spans)
}

fn centered_rect_with_min(
    area: Rect,
    width_percent: u16,
    height_percent: u16,
    min_width: u16,
    min_height: u16,
) -> Rect {
    let width = ((area.width as u32 * width_percent as u32) / 100)
        .max(min_width as u32)
        .min(area.width as u32) as u16;
    let height = ((area.height as u32 * height_percent as u32) / 100)
        .max(min_height as u32)
        .min(area.height as u32) as u16;

    Rect {
        x: area.x + area.width.saturating_sub(width) / 2,
        y: area.y + area.height.saturating_sub(height) / 2,
        width,
        height,
    }
}

// ─── Composer ──────────────────────────────────────────────────────────────

fn render_composer(frame: &mut Frame, app: &App, area: Rect) {
    if area.is_empty() {
        return;
    }

    let focused = app.focus == FocusedPanel::Chat && app.terminal_focused;
    let surface_style = user_message_style();
    let base_text_style = surface_style.fg(Color::White);
    frame.render_widget(Block::default().style(surface_style), area);

    let inner = Rect {
        x: area.x.saturating_add(GUTTER),
        y: area.y.saturating_add(1),
        width: area.width.saturating_sub(GUTTER + 1),
        height: area.height.saturating_sub(2),
    };
    if inner.is_empty() {
        return;
    }

    let prompt_width = GUTTER.min(area.width);
    let prompt_area = Rect {
        x: area.x,
        y: inner.y,
        width: prompt_width,
        height: inner.height,
    };
    let text_area = Rect {
        x: inner.x,
        y: inner.y,
        width: inner.width,
        height: inner.height,
    };

    let prompt_lines: Vec<Line> = (0..inner.height)
        .map(|i| {
            if i == 0 {
                let prompt_style = if focused {
                    surface_style
                        .fg(palette::focus_border())
                        .add_modifier(Modifier::BOLD)
                } else {
                    surface_style.add_modifier(Modifier::DIM)
                };
                Line::from(Span::styled("› ", prompt_style))
            } else {
                Line::from(Span::raw("  "))
            }
        })
        .collect();
    frame.render_widget(
        Paragraph::new(prompt_lines).style(surface_style),
        prompt_area,
    );

    if app.input.is_empty() {
        let placeholder_line = Line::from(vec![
            Span::styled(
                " ",
                surface_style
                    .fg(Color::White)
                    .add_modifier(Modifier::BOLD | Modifier::REVERSED),
            ),
            Span::styled(
                "Describe a task…",
                surface_style.add_modifier(Modifier::DIM | Modifier::ITALIC),
            ),
        ]);
        frame.render_widget(
            Paragraph::new(placeholder_line).style(surface_style),
            text_area,
        );
        return;
    }

    let input_lines: Vec<&str> = app.input.split('\n').collect();
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
                Span::styled(before, base_text_style),
                Span::styled(
                    at,
                    surface_style
                        .fg(Color::White)
                        .add_modifier(Modifier::BOLD | Modifier::REVERSED),
                ),
                Span::styled(after, base_text_style),
            ]));
        } else {
            text_lines.push(Line::from(Span::styled(*line_s, base_text_style)));
        }
    }

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

    let visible_h = text_area.height as usize;
    let scroll_y: u16 = if text_lines.len() > visible_h && visible_h > 0 {
        cursor_row.saturating_sub(visible_h - 1) as u16
    } else {
        0
    };

    let para = Paragraph::new(text_lines)
        .style(surface_style)
        .scroll((scroll_y, scroll_x));
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

// ─── Live top strip ────────────────────────────────────────────────────────

fn render_top_strip(frame: &mut Frame, app: &App, area: Rect) {
    if area.is_empty() {
        return;
    }

    if let Some(line) = status_indicator::render_top_line(app, area.width) {
        frame.render_widget(Paragraph::new(line), area);
    }
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

fn render_footer(frame: &mut Frame, app: &App, area: Rect, show_shelf: bool) {
    let variant = if app.focus == FocusedPanel::Chat {
        if app.input.starts_with('/') {
            FooterVariant::ChatSlash
        } else if show_shelf {
            FooterVariant::ChatShelf
        } else {
            FooterVariant::ChatPlain
        }
    } else {
        FooterVariant::Shelf
    };

    let footer = Paragraph::new(footer::line_for(variant, area.width));
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
                Span::styled(human_elapsed(entry.started_at), palette::dim_style()),
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
    use ratatui::{Terminal, backend::TestBackend};
    use tokio::sync::mpsc;

    use bakudo_core::{
        config::BakudoConfig,
        mission::{MissionStatus, Posture, WakeReason},
        provider::ProviderRegistry,
        state::SandboxLedger,
    };
    use bakudo_daemon::mission_status::{
        FleetCounts, MissionBanner, MissionWakeBanner, MissionWakeState,
    };

    use crate::app::{App, ApprovalAction, FocusedPanel, PopupState, ShelfEntry};
    use crate::palette::{SHELF_MIN_TERM_WIDTH, SHELF_WIDTH};

    use super::render;

    #[test]
    fn render_keeps_selection_detail_without_idle_header_chrome() {
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
        app.workspace_label = "workspace-header".to_string();
        app.provider_id = "provider-header".to_string();
        app.model = Some("model-header".to_string());
        app.focus = FocusedPanel::Shelf;
        app.shelf.push_back(ShelfEntry {
            task_id: "task-render".to_string(),
            provider: "provider-selection".to_string(),
            model: Some("model-selection".to_string()),
            prompt_summary: "Make the TUI feel native.".to_string(),
            last_note: "Summarizing diffs before applying the fix.".to_string(),
            state_label: "preserved".to_string(),
            state_color: crate::app::ShelfColor::Preserved,
            started_at: Local::now(),
            updated_at: Local::now(),
            pending_action: None,
        });

        let backend = TestBackend::new(120, 30);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal.draw(|frame| render(frame, &app)).unwrap();

        let buffer = terminal.backend().buffer();
        let rendered = buffer_to_string(buffer);
        assert!(rendered.contains("Selection"));
        assert!(rendered.contains("task-render"));
        assert!(rendered.contains("Summarizing diffs"));
        assert!(!rendered.contains("workspace-header"));
        assert!(!rendered.contains("provider-header"));
        assert!(!rendered.contains("model-header"));
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

    fn render_row(app: &App, cols: u16, rows: u16, row: usize) -> String {
        let rendered = render_to_string(app, cols, rows)
            .lines()
            .nth(row)
            .unwrap_or_default()
            .to_string();
        let main_width = if cols >= SHELF_MIN_TERM_WIDTH && !app.shelf.is_empty() {
            usize::from(cols.saturating_sub(SHELF_WIDTH))
        } else {
            usize::from(cols)
        };
        rendered
            .chars()
            .take(main_width)
            .collect::<String>()
            .trim_end()
            .to_string()
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
        assert!(!rendered.contains("Shift+Enter for newline"));
    }

    #[test]
    fn shelf_hidden_when_empty_at_wide_terminal() {
        let app = fresh_app();
        let rendered = render_to_string(&app, 140, 30);
        assert!(!rendered.contains("Sandboxes"));
        assert!(!rendered.contains("No sandboxes"));
    }

    #[test]
    fn composer_uses_inline_surface_without_box_title() {
        let app = fresh_app();
        let rendered = render_to_string(&app, 100, 20);
        assert!(
            !rendered.contains(" Input "),
            "composer title should not render in inline mode: {rendered}"
        );
        assert!(
            rendered.contains('›'),
            "expected codex-style prompt in: {rendered}"
        );
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
    fn slash_popup_uses_shared_surface() {
        let mut app = fresh_app();
        app.popup = Some(PopupState::SlashCommands(crate::app::SlashCommandPopup {
            items: vec!["provider", "providers"],
            selected: 0,
        }));
        let rendered = render_to_string(&app, 100, 24);
        assert!(rendered.contains("Commands"));
        assert!(rendered.contains("/provider"));
        assert!(rendered.contains("/providers"));
    }

    #[test]
    fn approval_popup_uses_shared_surface() {
        let mut app = fresh_app();
        app.popup = Some(PopupState::Approval(crate::app::ApprovalPrompt {
            request_id: "approval-1".to_string(),
            command: "git worktree remove stale-branch".to_string(),
            reason: "Clean up the finished worktree".to_string(),
            selected_action: ApprovalAction::Edit,
            selection_touched: false,
            editing: false,
            edited_command: "git worktree remove stale-branch".to_string(),
            cursor: 30,
        }));
        let rendered = render_to_string(&app, 100, 30);
        assert!(rendered.contains("Approval"));
        assert!(rendered.contains("Edit command"));
        assert!(rendered.contains("Approve"));
        assert!(rendered.contains("Deny"));
    }

    #[test]
    fn question_popup_uses_shared_surface() {
        let mut app = fresh_app();
        app.popup = Some(PopupState::UserQuestion(crate::app::UserQuestionPrompt {
            request_id: "question-1".to_string(),
            question: "Which branch should Bakudo continue from?".to_string(),
            choices: vec!["main".to_string(), "release".to_string()],
            selected: 0,
            selection_touched: false,
            editing: false,
            edited_answer: String::new(),
            cursor: 0,
        }));
        let rendered = render_to_string(&app, 100, 24);
        assert!(rendered.contains("Question"));
        assert!(rendered.contains("Which branch should Bakudo continue from?"));
        assert!(rendered.contains("1. main"));
        assert!(rendered.contains("2. release"));
        assert!(
            rendered.contains("custom answer"),
            "choice view should hint at the freeform editor: {rendered}"
        );
    }

    #[test]
    fn question_popup_edit_view_shows_typed_answer_and_submit_hint() {
        let mut app = fresh_app();
        app.popup = Some(PopupState::UserQuestion(crate::app::UserQuestionPrompt {
            request_id: "question-2".to_string(),
            question: "How should we proceed?".to_string(),
            choices: vec!["alpha".to_string(), "beta".to_string()],
            selected: 0,
            selection_touched: false,
            editing: true,
            edited_answer: "use the third option".to_string(),
            cursor: "use the third option".len(),
        }));
        let rendered = render_to_string(&app, 100, 24);
        assert!(rendered.contains("Type your answer"));
        assert!(rendered.contains("use the third option"));
        assert!(rendered.contains("Enter"));
        assert!(rendered.contains("submit"));
        assert!(rendered.contains("back to choices"));
    }

    #[test]
    fn mission_banner_renders_a_working_top_strip() {
        let mut app = fresh_app();
        app.mission_banner = Some(MissionBanner {
            mission_id: "mission-inline".to_string(),
            goal: "Refine the inline viewport spacing".to_string(),
            posture: Posture::Mission,
            status: MissionStatus::Deliberating,
            wake: MissionWakeBanner {
                state: MissionWakeState::Running,
                current_reason: Some(WakeReason::ManualResume),
                queued_count: 0,
                next_wake_at: None,
                timeout_streak: None,
            },
            active_wave: None,
            wall_clock_remaining_secs: 1800,
            abox_workers_remaining: 12,
            abox_workers_in_flight: 0,
            concurrent_max: 4,
            pending_user_messages: 0,
            pending_questions: 0,
            pending_approvals: 0,
            latest_issue: None,
            latest_change: None,
            fleet: FleetCounts {
                active: 0,
                queued: 0,
                completed: 0,
                failed: 0,
            },
        });

        let rendered = render_to_string(&app, 100, 20);
        assert!(rendered.contains("• Working"));
        assert!(rendered.contains("wake running: manual resume"));
        assert!(rendered.contains("Refine the inline viewport spacing"));
    }

    #[test]
    fn status_strip_renders_codex_style_running_row() {
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
            started_at: Local::now() - chrono::Duration::seconds(7),
            updated_at: Local::now(),
            pending_action: None,
        });
        let rendered = render_to_string(&app, 140, 30);
        assert!(rendered.contains("• Running (7s)"));
        assert!(rendered.contains("2 sandboxes active"));
        assert!(rendered.contains("[02bf30c1]"));
        assert!(rendered.contains("Booting sandbox"));
    }

    #[test]
    fn status_strip_truncates_at_narrow_width() {
        let mut app = fresh_app();
        app.active_task_count = 1;
        app.shelf.push_back(ShelfEntry {
            task_id: "bakudo-attempt-02bf30c1-abcd".to_string(),
            provider: "claude".to_string(),
            model: None,
            prompt_summary: "fix the readme".to_string(),
            last_note: "Booting sandbox for a much longer status note".to_string(),
            state_label: "running".to_string(),
            state_color: crate::app::ShelfColor::Running,
            started_at: Local::now() - chrono::Duration::seconds(7),
            updated_at: Local::now(),
            pending_action: None,
        });
        let rendered = render_to_string(&app, 60, 20);
        assert!(rendered.contains("…"), "expected ellipsis in: {rendered}");
        assert!(
            rendered.contains("Running"),
            "expected status row in: {rendered}"
        );
    }

    #[test]
    fn footer_hides_shelf_hint_when_terminal_is_narrow() {
        let mut app = fresh_app();
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

        assert_eq!(
            render_row(&app, 80, 20, 19),
            "Enter: send  Ctrl+C: quit  /help: commands"
        );
    }

    #[test]
    fn footer_shows_shelf_hint_when_shelf_is_visible() {
        let mut app = fresh_app();
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

        assert_eq!(
            render_row(&app, 140, 20, 19),
            "Enter: send  Tab: inspect shelf  Ctrl+C: quit  /help: commands"
        );
    }

    #[test]
    fn footer_switches_for_slash_input_and_shelf_focus() {
        let mut app = fresh_app();
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
        app.input = "/help".to_string();

        assert_eq!(
            render_row(&app, 140, 20, 19),
            "Enter: send  Tab: complete  Ctrl+C: quit  /help: commands"
        );

        app.focus = FocusedPanel::Shelf;
        assert_eq!(
            render_row(&app, 140, 20, 19),
            "Tab/Esc: back to chat  j/k: navigate  a: apply  d: discard"
        );
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
