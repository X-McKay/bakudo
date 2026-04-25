// Thin inline-history insertion adapter built on ratatui's inline viewport support.
use std::io;

use ratatui::Terminal;
use ratatui::backend::Backend;
use ratatui::text::Text;
use ratatui::widgets::Paragraph;
use ratatui::widgets::Widget;

use crate::app::ChatMessage;
use crate::history_render;

pub fn insert_messages<B>(terminal: &mut Terminal<B>, messages: &[ChatMessage]) -> io::Result<()>
where
    B: Backend,
{
    if messages.is_empty() {
        return Ok(());
    }

    let width = terminal.size()?.width;
    let mut lines = Vec::new();
    for message in messages {
        lines.extend(history_render::render_message(message, width));
    }
    let height = lines.len() as u16;
    if height == 0 {
        return Ok(());
    }

    terminal.insert_before(height, move |buf| {
        Paragraph::new(Text::from(lines)).render(buf.area, buf);
    })
}

#[cfg(test)]
mod tests {
    use chrono::Local;
    use ratatui::Terminal;
    use ratatui::backend::TestBackend;
    use ratatui::prelude::TerminalOptions;
    use ratatui::prelude::Viewport;

    use super::insert_messages;
    use crate::app::ChatMessage;
    use crate::app::MessageRole;

    #[test]
    fn inserts_history_above_inline_viewport() {
        let backend = TestBackend::new(40, 10);
        let mut terminal = Terminal::with_options(
            backend,
            TerminalOptions {
                viewport: Viewport::Inline(4),
            },
        )
        .expect("terminal");

        let messages = vec![ChatMessage {
            role: MessageRole::Info,
            content: "history line".to_string(),
            timestamp: Local::now(),
        }];

        insert_messages(&mut terminal, &messages).expect("insert");
        let buffer = terminal.backend().buffer();
        let top = (0..10)
            .map(|y| {
                let mut line = String::new();
                for x in 0..40 {
                    line.push_str(buffer.get(x, y).symbol());
                }
                line
            })
            .collect::<Vec<_>>()
            .join("\n");

        assert!(top.contains("history line"));
    }
}
