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
    FooterItem {
        key: "Enter",
        label: "send",
        short_label: None,
    },
    FooterItem {
        key: "Tab",
        label: "complete",
        short_label: None,
    },
    FooterItem {
        key: "PgUp/Dn",
        label: "scroll",
        short_label: None,
    },
    FooterItem {
        key: "Ctrl+C",
        label: "quit",
        short_label: None,
    },
    FooterItem {
        key: "/help",
        label: "commands",
        short_label: Some("help"),
    },
];

const CHAT_SHELF_ITEMS: &[FooterItem] = &[
    FooterItem {
        key: "Enter",
        label: "send",
        short_label: None,
    },
    FooterItem {
        key: "Tab",
        label: "inspect shelf",
        short_label: Some("shelf"),
    },
    FooterItem {
        key: "PgUp/Dn",
        label: "scroll",
        short_label: None,
    },
    FooterItem {
        key: "Ctrl+C",
        label: "quit",
        short_label: None,
    },
    FooterItem {
        key: "/help",
        label: "commands",
        short_label: Some("help"),
    },
];

const CHAT_PLAIN_ITEMS: &[FooterItem] = &[
    FooterItem {
        key: "Enter",
        label: "send",
        short_label: None,
    },
    FooterItem {
        key: "PgUp/Dn",
        label: "scroll",
        short_label: None,
    },
    FooterItem {
        key: "Ctrl+C",
        label: "quit",
        short_label: None,
    },
    FooterItem {
        key: "/help",
        label: "commands",
        short_label: Some("help"),
    },
];

const SHELF_ITEMS: &[FooterItem] = &[
    FooterItem {
        key: "Tab/Esc",
        label: "back to chat",
        short_label: Some("chat"),
    },
    FooterItem {
        key: "j/k",
        label: "navigate",
        short_label: None,
    },
    FooterItem {
        key: "a",
        label: "apply",
        short_label: None,
    },
    FooterItem {
        key: "d",
        label: "discard",
        short_label: None,
    },
];

pub(crate) fn line_for(variant: FooterVariant, width: u16) -> Line<'static> {
    let mut items = items_for_variant(variant).to_vec();

    loop {
        let full = build_line(&items, false);
        if fits(&full, width) {
            return full;
        }

        let shortened = build_line(&items, true);
        if fits(&shortened, width) {
            return shortened;
        }

        if items.len() == 1 {
            return shortened;
        }

        items.pop();
    }
}

fn items_for_variant(variant: FooterVariant) -> &'static [FooterItem] {
    match variant {
        FooterVariant::ChatSlash => CHAT_SLASH_ITEMS,
        FooterVariant::ChatShelf => CHAT_SHELF_ITEMS,
        FooterVariant::ChatPlain => CHAT_PLAIN_ITEMS,
        FooterVariant::Shelf => SHELF_ITEMS,
    }
}

fn build_line(items: &[FooterItem], use_short_labels: bool) -> Line<'static> {
    let mut spans = Vec::with_capacity(items.len() * 3);
    for (idx, item) in items.iter().enumerate() {
        spans.push(key_span(item.key));
        spans.push(Span::styled(
            format!(
                ": {}",
                if use_short_labels {
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
            render_footer_row(FooterVariant::ChatShelf, 80),
            "Enter: send  Tab: inspect shelf  PgUp/Dn: scroll  Ctrl+C: quit  /help: commands "
        );
    }

    #[test]
    fn chat_slash_full_snapshot() {
        assert_eq!(
            render_footer_row(FooterVariant::ChatSlash, 74),
            "Enter: send  Tab: complete  PgUp/Dn: scroll  Ctrl+C: quit  /help: commands"
        );
    }

    #[test]
    fn chat_shelf_shortens_before_dropping_more_items() {
        assert_eq!(
            render_footer_row(FooterVariant::ChatShelf, 54),
            "Enter: send  Tab: shelf  PgUp/Dn: scroll  Ctrl+C: quit"
        );
    }

    #[test]
    fn chat_plain_narrow_snapshot() {
        assert_eq!(
            render_footer_row(FooterVariant::ChatPlain, 40),
            "Enter: send  PgUp/Dn: scroll            "
        );
    }

    #[test]
    fn shelf_snapshot_uses_short_chat_label() {
        assert_eq!(
            render_footer_row(FooterVariant::Shelf, 40),
            "Tab/Esc: chat  j/k: navigate  a: apply  "
        );
    }

    #[test]
    fn slash_footer_falls_back_to_primary_action() {
        assert_eq!(
            render_footer_row(FooterVariant::ChatSlash, 11),
            "Enter: send"
        );
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
        rendered
    }
}
