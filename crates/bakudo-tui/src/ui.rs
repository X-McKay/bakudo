//! Ratatui UI rendering.
//!
//! Layout (terminal width >= 100):
//!
//!  ┌─────────────────────────────────────────────────┬──────────────────────┐
//!  │  Header: bakudo v2 | provider: claude | model   │                      │
//!  ├─────────────────────────────────────────────────┤   Sandbox Shelf      │
//!  │                                                 │                      │
//!  │   Chat Transcript                               │  [running] task-abc  │
//!  │                                                 │  [preserved] task-xy │
//!  │                                                 │                      │
//!  ├─────────────────────────────────────────────────┤                      │
//!  │  > composer input                               │                      │
//!  └─────────────────────────────────────────────────┴──────────────────────┘
//!  Footer: key hints

use ratatui::{
    backend::Backend,
    layout::{Alignment, Constraint, Direction, Layout, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span, Text},
    widgets::{Block, Borders, List, ListItem, ListState, Paragraph, Wrap},
    Frame,
};

use crate::app::{App, FocusedPanel, MessageRole, ShelfColor};

const SHELF_WIDTH: u16 = 32;
const HEADER_HEIGHT: u16 = 1;
const COMPOSER_HEIGHT: u16 = 3;
const FOOTER_HEIGHT: u16 = 1;

/// Render the full TUI.
pub fn render(frame: &mut Frame, app: &App) {
    let area = frame.size();

    // Outer horizontal split: main area | shelf
    let use_shelf = area.width >= 80;
    let h_chunks = if use_shelf {
        Layout::default()
            .direction(Direction::Horizontal)
            .constraints([
                Constraint::Min(40),
                Constraint::Length(SHELF_WIDTH),
            ])
            .split(area)
    } else {
        Layout::default()
            .direction(Direction::Horizontal)
            .constraints([Constraint::Percentage(100)])
            .split(area)
    };

    let main_area = h_chunks[0];

    // Vertical split for main area: header | transcript | composer | footer
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
}

fn render_header(frame: &mut Frame, app: &App, area: Rect) {
    let model_str = if app.model.is_empty() {
        "default".to_string()
    } else {
        app.model.clone()
    };
    let header = Paragraph::new(format!(
        " bakudo v2  │  provider: {}  │  model: {}",
        app.provider_id, model_str
    ))
    .style(Style::default().fg(Color::White).bg(Color::DarkGray));
    frame.render_widget(header, area);
}

fn render_transcript(frame: &mut Frame, app: &App, area: Rect) {
    let focus_style = if app.focus == FocusedPanel::Chat {
        Style::default().fg(Color::Cyan)
    } else {
        Style::default().fg(Color::DarkGray)
    };

    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(focus_style)
        .title(" Chat ");

    let inner = block.inner(area);
    frame.render_widget(block, area);

    // Build lines from transcript.
    let mut lines: Vec<Line> = Vec::new();
    for msg in &app.transcript {
        let (prefix, style) = match msg.role {
            MessageRole::User => (
                "you  ",
                Style::default().fg(Color::Green).add_modifier(Modifier::BOLD),
            ),
            MessageRole::System => (
                "sys  ", Style::default().fg(Color::Yellow)
            ),
            MessageRole::AgentOutput => (
                "     ", Style::default().fg(Color::White)
            ),
            MessageRole::Error => (
                "err  ", Style::default().fg(Color::Red)
            ),
            MessageRole::Info => (
                "info ", Style::default().fg(Color::Cyan)
            ),
        };
        let ts = msg.timestamp.format("%H:%M:%S").to_string();
        // Split multi-line content.
        for (i, content_line) in msg.content.lines().enumerate() {
            if i == 0 {
                lines.push(Line::from(vec![
                    Span::styled(format!("{} ", ts), Style::default().fg(Color::DarkGray)),
                    Span::styled(prefix, style),
                    Span::styled(content_line.to_string(), style),
                ]));
            } else {
                lines.push(Line::from(vec![
                    Span::raw("         "),
                    Span::styled(content_line.to_string(), style),
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
}

fn render_composer(frame: &mut Frame, app: &App, area: Rect) {
    let focus_style = if app.focus == FocusedPanel::Chat {
        Style::default().fg(Color::Cyan)
    } else {
        Style::default().fg(Color::DarkGray)
    };

    let provider = app.provider_id.chars().next().unwrap_or('?').to_uppercase().to_string();
    let title = format!(" [{}] Input ", provider);

    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(focus_style)
        .title(title);

    let inner = block.inner(area);
    frame.render_widget(block, area);

    // Show input with cursor.
    let before_cursor = &app.input[..app.cursor];
    let after_cursor = &app.input[app.cursor..];
    let cursor_char = if app.input.len() == app.cursor { " " } else {
        &app.input[app.cursor..app.cursor + app.input[app.cursor..].chars().next().map(|c| c.len_utf8()).unwrap_or(1)]
    };

    let line = Line::from(vec![
        Span::raw("> "),
        Span::styled(before_cursor, Style::default().fg(Color::White)),
        Span::styled(cursor_char, Style::default().bg(Color::White).fg(Color::Black)),
        Span::styled(after_cursor, Style::default().fg(Color::White)),
    ]);

    let para = Paragraph::new(line);
    frame.render_widget(para, inner);
}

fn render_footer(frame: &mut Frame, app: &App, area: Rect) {
    let hints = if app.focus == FocusedPanel::Chat {
        " Enter: send  Tab: shelf  PgUp/Dn: scroll  Ctrl+C: quit  /help: commands "
    } else {
        " Tab/Esc: back to chat  j/k: navigate  a: apply  d: discard "
    };
    let footer = Paragraph::new(hints)
        .style(Style::default().fg(Color::DarkGray).bg(Color::Black));
    frame.render_widget(footer, area);
}

fn render_shelf(frame: &mut Frame, app: &App, area: Rect) {
    let focus_style = if app.focus == FocusedPanel::Shelf {
        Style::default().fg(Color::Cyan)
    } else {
        Style::default().fg(Color::DarkGray)
    };

    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(focus_style)
        .title(" Sandboxes ");

    let inner = block.inner(area);
    frame.render_widget(block, area);

    if app.shelf.is_empty() {
        let empty = Paragraph::new("No sandboxes")
            .style(Style::default().fg(Color::DarkGray))
            .alignment(Alignment::Center);
        frame.render_widget(empty, inner);
        return;
    }

    let items: Vec<ListItem> = app
        .shelf
        .iter()
        .enumerate()
        .map(|(i, entry)| {
            let state_color = match entry.state_color {
                ShelfColor::Running => Color::Green,
                ShelfColor::Preserved => Color::Yellow,
                ShelfColor::Merged => Color::Blue,
                ShelfColor::Discarded => Color::DarkGray,
                ShelfColor::Failed => Color::Red,
            };
            let selected = i == app.shelf_selected && app.focus == FocusedPanel::Shelf;
            let style = if selected {
                Style::default().bg(Color::DarkGray)
            } else {
                Style::default()
            };
            // Truncate task_id and summary to fit shelf width.
            let max_w = (inner.width as usize).saturating_sub(2);
            let id_short: String = entry.task_id.chars().take(16).collect();
            let summary: String = entry.prompt_summary.chars().take(max_w.saturating_sub(4)).collect();
            ListItem::new(vec![
                Line::from(vec![
                    Span::styled(
                        format!("[{}] ", entry.state_label),
                        Style::default().fg(state_color),
                    ),
                    Span::styled(id_short, Style::default().fg(Color::White)),
                ]),
                Line::from(Span::styled(
                    format!("  {}", summary),
                    Style::default().fg(Color::DarkGray),
                )),
            ])
            .style(style)
        })
        .collect();

    let mut list_state = ListState::default();
    if app.focus == FocusedPanel::Shelf {
        list_state.select(Some(app.shelf_selected));
    }

    let list = List::new(items);
    frame.render_stateful_widget(list, inner, &mut list_state);
}
