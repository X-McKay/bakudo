// Derived from bakudo's former transcript pane rendering; used for inline scrollback.
use ratatui::style::Style;
use ratatui::style::Stylize;
use ratatui::text::Line;
use ratatui::text::Span;
use unicode_width::UnicodeWidthChar;

use crate::app::ChatMessage;
use crate::app::MessageRole;
use crate::palette;
use crate::palette::GUTTER;
use crate::style::user_message_style;

pub fn render_message(msg: &ChatMessage, width: u16) -> Vec<Line<'static>> {
    let width = width.max(1) as usize;
    let gutter = GUTTER as usize;

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
    let body_width = width.saturating_sub(prefix_width).max(1);
    let cont_indent = " ".repeat(prefix_width);
    let row_style = if matches!(msg.role, MessageRole::User) {
        user_message_style()
    } else {
        Style::default()
    };

    let mut lines = Vec::new();
    let mut first_segment_of_msg = true;
    for content_line in msg.content.lines() {
        let wrapped = wrap_to_width(content_line, body_width);
        for segment in wrapped {
            let body_span = render_diff_aware_span(&segment, body_style);
            if first_segment_of_msg {
                lines.push(
                    Line::from(vec![
                        Span::styled(format!("{:>gutter$}", ""), palette::dim_style()),
                        Span::styled(format!("{ts} "), palette::dim_style()),
                        Span::styled(icon, role_style),
                        Span::raw(" "),
                        Span::styled(role_label, role_style),
                        body_span,
                    ])
                    .style(row_style),
                );
                first_segment_of_msg = false;
            } else {
                lines.push(
                    Line::from(vec![Span::raw(cont_indent.clone()), body_span]).style(row_style),
                );
            }
        }
    }

    if lines.is_empty() {
        lines.push(Line::default());
    }

    lines
}

fn wrap_to_width(text: &str, width: usize) -> Vec<String> {
    if width == 0 {
        return vec![String::new()];
    }

    let mut out = Vec::new();
    let mut current = String::new();
    let mut current_w = 0usize;

    for word in text.split(' ') {
        let word_w: usize = word
            .chars()
            .map(|c| UnicodeWidthChar::width(c).unwrap_or(0))
            .sum();

        if current.is_empty() {
            if word_w <= width {
                current.push_str(word);
                current_w = word_w;
            } else {
                push_hard_broken(&mut out, &mut current, &mut current_w, word, width);
            }
            continue;
        }

        if current_w + 1 + word_w <= width {
            current.push(' ');
            current.push_str(word);
            current_w += 1 + word_w;
        } else if word_w > width {
            out.push(std::mem::take(&mut current));
            current_w = 0;
            push_hard_broken(&mut out, &mut current, &mut current_w, word, width);
        } else {
            out.push(std::mem::take(&mut current));
            current.push_str(word);
            current_w = word_w;
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

#[cfg(test)]
mod tests {
    use chrono::Local;

    use super::render_message;
    use crate::app::ChatMessage;

    #[test]
    fn user_message_wraps_with_continuation_indent() {
        let msg = ChatMessage {
            role: crate::app::MessageRole::User,
            content: "one two three four five six".to_string(),
            timestamp: Local::now(),
        };

        let rendered = render_message(&msg, 24);
        assert!(rendered.len() >= 2);
        assert!(rendered[0].to_string().contains("you"));
        assert!(rendered[1].to_string().starts_with("              "));
    }

    #[test]
    fn diff_lines_keep_prefix_content() {
        let msg = ChatMessage::agent("+ added line\n- removed line\n@@ hunk");
        let rendered = render_message(&msg, 80);
        assert!(rendered[0].to_string().contains("+ added line"));
        assert!(rendered[1].to_string().contains("- removed line"));
        assert!(rendered[2].to_string().contains("@@ hunk"));
    }
}
