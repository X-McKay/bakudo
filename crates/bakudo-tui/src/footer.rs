//! Width-aware footer hint selection for the bakudo TUI.
//!
//! Adapted from the collapse strategy in `codex-rs/tui/src/bottom_pane/footer.rs`
//! (Apache-2.0), but scoped to bakudo's simpler one-line footer vocabulary.

use ratatui::{
    style::{Style, Stylize},
    text::{Line, Span},
};

use crate::palette;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum FooterVariant {
    ChatSlash,
    ChatShelf,
    ChatPlain,
    Shelf,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct FooterItem {
    key: &'static str,
    label: &'static str,
    short_label: Option<&'static str>,
}

const CHAT_SLASH_ITEMS: &[FooterItem] = &[
    FooterItem::new("Enter", "send", None),
    FooterItem::new("Tab", "complete", None),
    FooterItem::new("Ctrl+C", "quit", None),
    FooterItem::new("/help", "commands", Some("help")),
];

const CHAT_SHELF_ITEMS: &[FooterItem] = &[
    FooterItem::new("Enter", "send", None),
    FooterItem::new("Tab", "inspect shelf", Some("shelf")),
    FooterItem::new("Ctrl+C", "quit", None),
    FooterItem::new("/help", "commands", Some("help")),
];

const CHAT_PLAIN_ITEMS: &[FooterItem] = &[
    FooterItem::new("Enter", "send", None),
    FooterItem::new("Ctrl+C", "quit", None),
    FooterItem::new("/help", "commands", Some("help")),
];

const SHELF_ITEMS: &[FooterItem] = &[
    FooterItem::new("Tab/Esc", "back to chat", Some("chat")),
    FooterItem::new("j/k", "navigate", None),
    FooterItem::new("a", "apply", None),
    FooterItem::new("d", "discard", None),
];

impl FooterItem {
    const fn new(
        key: &'static str,
        label: &'static str,
        short_label: Option<&'static str>,
    ) -> Self {
        Self {
            key,
            label,
            short_label,
        }
    }
}

pub(crate) fn line_for(variant: FooterVariant, width: u16) -> Line<'static> {
    if width == 0 {
        return Line::default();
    }

    let items = items_for_variant(variant);
    for visible_count in (1..=items.len()).rev() {
        let visible = &items[..visible_count];
        let shortenable = shortenable_positions(visible);

        for shortened_count in 0..=shortenable.len() {
            let line = build_line(visible, &shortenable[..shortened_count]);
            if fits(&line, width) {
                return line;
            }
        }
    }

    let fallback = &items[..1];
    build_line(fallback, &shortenable_positions(fallback))
}

fn items_for_variant(variant: FooterVariant) -> &'static [FooterItem] {
    match variant {
        FooterVariant::ChatSlash => CHAT_SLASH_ITEMS,
        FooterVariant::ChatShelf => CHAT_SHELF_ITEMS,
        FooterVariant::ChatPlain => CHAT_PLAIN_ITEMS,
        FooterVariant::Shelf => SHELF_ITEMS,
    }
}

fn shortenable_positions(items: &[FooterItem]) -> Vec<usize> {
    items
        .iter()
        .enumerate()
        .rev()
        .filter_map(|(idx, item)| item.short_label.map(|_| idx))
        .collect()
}

fn build_line(items: &[FooterItem], shortened_positions: &[usize]) -> Line<'static> {
    let mut spans = Vec::with_capacity(items.len() * 3);
    for (idx, item) in items.iter().enumerate() {
        spans.push(key_span(item.key));
        spans.push(Span::styled(
            format!(
                ": {}",
                if shortened_positions.contains(&idx) {
                    item.short_label.unwrap_or(item.label)
                } else {
                    item.label
                }
            ),
            label_style(),
        ));
        if idx + 1 != items.len() {
            spans.push(Span::raw("  "));
        }
    }
    Line::from(spans)
}

fn fits(line: &Line<'_>, width: u16) -> bool {
    line.width() <= width as usize
}

fn key_span(key: &'static str) -> Span<'static> {
    Span::styled(key, Style::default().fg(palette::hint_key_fg()).bold())
}

fn label_style() -> Style {
    Style::default().fg(palette::footer_fg())
}

#[cfg(test)]
mod tests {
    use ratatui::widgets::Paragraph;
    use ratatui::{Terminal, backend::TestBackend};

    use super::{FooterVariant, line_for};

    #[test]
    fn chat_shelf_full_snapshot() {
        assert_eq!(
            render_footer_row(FooterVariant::ChatShelf, 90),
            "Enter: send  Tab: inspect shelf  Ctrl+C: quit  /help: commands"
        );
    }

    #[test]
    fn chat_shelf_shortens_low_priority_help_before_dropping() {
        assert_eq!(
            render_footer_row(FooterVariant::ChatShelf, 60),
            "Enter: send  Tab: inspect shelf  Ctrl+C: quit  /help: help"
        );
    }

    #[test]
    fn chat_plain_narrow_snapshot() {
        assert_eq!(
            render_footer_row(FooterVariant::ChatPlain, 28),
            "Enter: send  Ctrl+C: quit"
        );
    }

    #[test]
    fn slash_footer_full_snapshot() {
        assert_eq!(
            render_footer_row(FooterVariant::ChatSlash, 90),
            "Enter: send  Tab: complete  Ctrl+C: quit  /help: commands"
        );
    }

    #[test]
    fn shelf_footer_full_snapshot() {
        assert_eq!(
            render_footer_row(FooterVariant::Shelf, 80),
            "Tab/Esc: back to chat  j/k: navigate  a: apply  d: discard"
        );
    }

    #[test]
    fn shelf_footer_very_narrow_falls_back_to_chat_hint() {
        assert_eq!(render_footer_row(FooterVariant::Shelf, 13), "Tab/Esc: chat");
    }

    fn render_footer_row(variant: FooterVariant, width: u16) -> String {
        let backend = TestBackend::new(width, 1);
        let mut terminal = Terminal::new(backend).expect("terminal");
        terminal
            .draw(|frame| {
                let area = frame.size();
                frame.render_widget(Paragraph::new(line_for(variant, width)), area);
            })
            .expect("draw");

        let mut rendered = String::new();
        for x in 0..width {
            rendered.push_str(terminal.backend().buffer().get(x, 0).symbol());
        }
        rendered.trim_end().to_string()
    }
}
