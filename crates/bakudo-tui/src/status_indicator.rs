//! Codex-style running status row adapted from `codex-rs/tui/src/status_indicator_widget.rs`
//! (Apache-2.0). This bakudo version stays single-line and derives context from the shelf.

use chrono::Local;
use crossterm::event::KeyCode;
use ratatui::{
    style::{Modifier, Style},
    text::{Line, Span},
};
use unicode_width::{UnicodeWidthChar, UnicodeWidthStr};

use crate::{
    app::{App, ShelfColor, short_task_id},
    key_hint, palette,
    shimmer::shimmer_spans,
};

pub(crate) fn fmt_elapsed_compact(elapsed_secs: u64) -> String {
    if elapsed_secs < 60 {
        return format!("{elapsed_secs}s");
    }
    if elapsed_secs < 3600 {
        let minutes = elapsed_secs / 60;
        let seconds = elapsed_secs % 60;
        return format!("{minutes}m {seconds:02}s");
    }

    let hours = elapsed_secs / 3600;
    let minutes = (elapsed_secs % 3600) / 60;
    let seconds = elapsed_secs % 60;
    format!("{hours}h {minutes:02}m {seconds:02}s")
}

pub(crate) fn render_status_line(app: &App, width: u16) -> Option<Line<'static>> {
    let running_entries: Vec<_> = app
        .shelf
        .iter()
        .filter(|entry| entry.state_color == ShelfColor::Running)
        .collect();
    let count = app.active_task_count.max(running_entries.len());
    if count == 0 {
        return None;
    }

    let elapsed_secs = running_entries
        .iter()
        .min_by_key(|entry| entry.started_at)
        .map(|entry| {
            Local::now()
                .signed_duration_since(entry.started_at)
                .num_seconds()
                .max(0) as u64
        })
        .unwrap_or(0);
    let elapsed = fmt_elapsed_compact(elapsed_secs);

    let mut spans = vec![Span::styled(
        "• ",
        Style::default()
            .fg(palette::shelf_running())
            .add_modifier(Modifier::BOLD),
    )];
    spans.extend(shimmer_spans("Running"));
    spans.extend([
        Span::styled(format!(" ({elapsed} • "), palette::dim_style()),
        key_hint::plain(KeyCode::Esc).into(),
        Span::styled(" to interrupt)", palette::dim_style()),
    ]);

    if let Some(entry) = running_entries.first() {
        spans.push(Span::styled(" · ", palette::dim_style()));
        if count > 1 {
            spans.push(Span::styled(
                format!("{count} sandboxes active"),
                palette::dim_style(),
            ));
            spans.push(Span::styled(" · ", palette::dim_style()));
        }
        spans.push(Span::styled(
            format!("[{}]", short_task_id(&entry.task_id)),
            Style::default()
                .fg(palette::role_info_fg())
                .add_modifier(Modifier::BOLD),
        ));
        if !entry.last_note.trim().is_empty() {
            spans.push(Span::raw(" "));
            spans.push(Span::styled(
                entry.last_note.trim().to_string(),
                Style::default().fg(palette::role_agent_fg()),
            ));
        }
    }

    Some(truncate_line_with_ellipsis(Line::from(spans), width))
}

fn truncate_line_with_ellipsis(line: Line<'static>, width: u16) -> Line<'static> {
    let max_width = usize::from(width);
    if max_width == 0 {
        return Line::default();
    }

    let line_width: usize = line
        .spans
        .iter()
        .map(|span| UnicodeWidthStr::width(span.content.as_ref()))
        .sum();
    if line_width <= max_width {
        return line;
    }
    if max_width == 1 {
        return Line::from("…");
    }

    let mut spans = Vec::new();
    let mut used = 0usize;

    'outer: for span in line.spans {
        let mut content = String::new();
        for ch in span.content.chars() {
            let ch_width = UnicodeWidthChar::width(ch).unwrap_or(0);
            if used + ch_width > max_width - 1 {
                break 'outer;
            }
            content.push(ch);
            used += ch_width;
        }
        if !content.is_empty() {
            spans.push(Span::styled(content, span.style));
        }
    }

    trim_trailing_whitespace(&mut spans);
    spans.push(Span::raw("…"));
    Line::from(spans)
}

fn trim_trailing_whitespace(spans: &mut Vec<Span<'static>>) {
    loop {
        let Some(last) = spans.last_mut() else {
            break;
        };
        let trimmed = last
            .content
            .trim_end_matches(char::is_whitespace)
            .to_string();
        if trimmed.is_empty() {
            spans.pop();
            continue;
        }
        if trimmed.len() != last.content.len() {
            *last = Span::styled(trimmed, last.style);
        }
        break;
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use chrono::{Duration, Local};
    use tokio::sync::mpsc;

    use bakudo_core::{config::BakudoConfig, provider::ProviderRegistry, state::SandboxLedger};

    use crate::app::{App, ShelfColor, ShelfEntry};

    use super::{fmt_elapsed_compact, render_status_line};

    #[test]
    fn fmt_elapsed_compact_formats_seconds_minutes_and_hours() {
        assert_eq!(fmt_elapsed_compact(0), "0s");
        assert_eq!(fmt_elapsed_compact(59), "59s");
        assert_eq!(fmt_elapsed_compact(60), "1m 00s");
        assert_eq!(fmt_elapsed_compact(61), "1m 01s");
        assert_eq!(fmt_elapsed_compact(59 * 60 + 59), "59m 59s");
        assert_eq!(fmt_elapsed_compact(3600), "1h 00m 00s");
        assert_eq!(fmt_elapsed_compact(3600 + 62), "1h 01m 02s");
    }

    #[test]
    fn render_status_line_includes_elapsed_interrupt_and_inline_context() {
        let mut app = fresh_app();
        app.active_task_count = 2;
        app.shelf.push_back(running_entry(
            "bakudo-attempt-02bf30c1-newest",
            "Booting sandbox",
            Local::now() - Duration::seconds(7),
        ));
        app.shelf.push_back(running_entry(
            "bakudo-attempt-9f8e7d6c-oldest",
            "Older note",
            Local::now() - Duration::minutes(2) - Duration::seconds(3),
        ));

        let line = render_status_line(&app, 140).expect("status line");
        let rendered = line_to_string(&line);

        assert!(rendered.contains("• Running (2m 03s • esc to interrupt)"));
        assert!(rendered.contains("2 sandboxes active"));
        assert!(rendered.contains("[02bf30c1]"));
        assert!(rendered.contains("Booting sandbox"));
    }

    #[test]
    fn render_status_line_truncates_with_ellipsis() {
        let mut app = fresh_app();
        app.active_task_count = 1;
        app.shelf.push_back(running_entry(
            "bakudo-attempt-02bf30c1-abcd",
            "Booting sandbox for a much longer status note",
            Local::now() - Duration::seconds(7),
        ));

        let line = render_status_line(&app, 32).expect("status line");
        let rendered = line_to_string(&line);

        assert!(rendered.ends_with('…'), "rendered={rendered}");
        assert!(rendered.contains("Running"));
    }

    #[test]
    fn render_status_line_falls_back_to_zero_seconds_when_shelf_lags() {
        let mut app = fresh_app();
        app.active_task_count = 1;

        let line = render_status_line(&app, 140).expect("status line");
        let rendered = line_to_string(&line);

        assert_eq!(rendered, "• Running (0s • esc to interrupt)");
    }

    fn line_to_string(line: &ratatui::text::Line<'static>) -> String {
        line.spans
            .iter()
            .map(|span| span.content.as_ref())
            .collect::<String>()
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

    fn running_entry(
        task_id: &str,
        last_note: &str,
        started_at: chrono::DateTime<Local>,
    ) -> ShelfEntry {
        ShelfEntry {
            task_id: task_id.to_string(),
            provider: "codex".to_string(),
            model: Some("gpt-5".to_string()),
            prompt_summary: "Test prompt".to_string(),
            last_note: last_note.to_string(),
            state_label: "running".to_string(),
            state_color: ShelfColor::Running,
            started_at,
            updated_at: started_at,
            pending_action: None,
        }
    }
}
