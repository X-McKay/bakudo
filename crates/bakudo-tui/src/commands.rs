//! Slash command parser.
//!
//! Slash commands are typed in the chat input and begin with `/`.
//! They are parsed before the input is dispatched as a task prompt.
//!
//! Supported commands:
//!
//! | Command                    | Description                                    |
//! |----------------------------|------------------------------------------------|
//! | /provider <id>             | Switch the active AI provider                  |
//! | /model <name>              | Set the model for the current provider         |
//! | /providers                 | List all registered providers                  |
//! | /apply <task_id>           | Merge a preserved worktree                     |
//! | /discard <task_id>         | Discard a preserved worktree                   |
//! | /sandboxes                 | List all active/preserved sandboxes            |
//! | /config                    | Show current configuration                     |
//! | /help                      | Show this help                                 |
//! | /quit or /exit             | Exit bakudo                                    |

#[derive(Debug, Clone, PartialEq)]
pub enum SlashCommand {
    SetProvider(String),
    SetModel(String),
    ListProviders,
    Apply(String),
    Discard(String),
    ListSandboxes,
    ShowConfig,
    Help,
    Quit,
    Unknown(String),
}

/// Parse a slash command from a raw input string.
/// Returns `None` if the input is not a slash command.
pub fn parse_slash(input: &str) -> Option<SlashCommand> {
    let trimmed = input.trim();
    if !trimmed.starts_with('/') {
        return None;
    }
    let rest = &trimmed[1..];
    let mut parts = rest.splitn(2, ' ');
    let cmd = parts.next().unwrap_or("").to_lowercase();
    let arg = parts.next().unwrap_or("").trim().to_string();

    Some(match cmd.as_str() {
        "provider" if !arg.is_empty() => SlashCommand::SetProvider(arg),
        "provider" => SlashCommand::Unknown("Usage: /provider <id>".to_string()),
        "model" if !arg.is_empty() => SlashCommand::SetModel(arg),
        "model" => SlashCommand::Unknown("Usage: /model <name>".to_string()),
        "providers" => SlashCommand::ListProviders,
        "apply" if !arg.is_empty() => SlashCommand::Apply(arg),
        "apply" => SlashCommand::Unknown("Usage: /apply <task_id>".to_string()),
        "discard" if !arg.is_empty() => SlashCommand::Discard(arg),
        "discard" => SlashCommand::Unknown("Usage: /discard <task_id>".to_string()),
        "sandboxes" | "ls" | "list" => SlashCommand::ListSandboxes,
        "config" => SlashCommand::ShowConfig,
        "help" | "h" | "?" => SlashCommand::Help,
        "quit" | "exit" | "q" => SlashCommand::Quit,
        other => SlashCommand::Unknown(format!("Unknown command: /{other}")),
    })
}

/// Return the help text for all slash commands.
pub fn help_text() -> &'static str {
    r#"Bakudo Slash Commands
─────────────────────────────────────────────────────
/provider <id>      Switch AI provider (claude, codex, opencode, gemini)
/model <name>       Set model for current provider
/providers          List all registered providers
/apply <task_id>    Merge a preserved worktree into the base branch
/discard <task_id>  Discard a preserved worktree (abox stop --clean)
/sandboxes          List all active and preserved sandboxes
/config             Show current configuration
/help               Show this help
/quit               Exit bakudo
─────────────────────────────────────────────────────
Type a message and press Enter to dispatch a task."#
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_provider() {
        assert_eq!(parse_slash("/provider claude"), Some(SlashCommand::SetProvider("claude".to_string())));
    }

    #[test]
    fn parse_model() {
        assert_eq!(parse_slash("/model claude-opus-4-5"), Some(SlashCommand::SetModel("claude-opus-4-5".to_string())));
    }

    #[test]
    fn parse_quit() {
        assert_eq!(parse_slash("/quit"), Some(SlashCommand::Quit));
        assert_eq!(parse_slash("/exit"), Some(SlashCommand::Quit));
        assert_eq!(parse_slash("/q"), Some(SlashCommand::Quit));
    }

    #[test]
    fn parse_help() {
        assert_eq!(parse_slash("/help"), Some(SlashCommand::Help));
        assert_eq!(parse_slash("/?"), Some(SlashCommand::Help));
    }

    #[test]
    fn not_a_slash_command() {
        assert_eq!(parse_slash("hello world"), None);
        assert_eq!(parse_slash(""), None);
    }

    #[test]
    fn parse_apply() {
        assert_eq!(parse_slash("/apply bakudo-attempt-abc"), Some(SlashCommand::Apply("bakudo-attempt-abc".to_string())));
    }

    #[test]
    fn parse_unknown() {
        assert!(matches!(parse_slash("/frobnicate"), Some(SlashCommand::Unknown(_))));
    }
}
