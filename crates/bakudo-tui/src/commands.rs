//! Slash command catalog and parser.
//!
//! Commands are typed in the chat composer and begin with `/`.
//! They are parsed before the input is dispatched as a task prompt.
//!
//! The enum is ordered by expected usage frequency — this order is also used
//! when rendering the `/help` command catalog.

use strum::{AsRefStr, EnumIter, EnumString, IntoEnumIterator, IntoStaticStr};

/// All supported slash commands.
///
/// DO NOT ALPHA-SORT — enum order is the presentation order in `/help`.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Hash, EnumString, EnumIter, AsRefStr, IntoStaticStr,
)]
#[strum(serialize_all = "kebab-case")]
pub enum SlashCommand {
    // ── Provider / model ─────────────────────────────────────────────────
    Provider,
    Approve,
    Model,
    Providers,

    // ── Worktree lifecycle ────────────────────────────────────────────────
    Apply,
    Discard,
    #[strum(serialize = "sandboxes", serialize = "ls", serialize = "list")]
    Sandboxes,
    Diverge,
    Diff,

    // ── Session management ────────────────────────────────────────────────
    New,
    Clear,

    // ── Observability ─────────────────────────────────────────────────────
    Config,
    Status,
    Doctor,

    // ── Meta ──────────────────────────────────────────────────────────────
    Help,
    #[strum(serialize = "quit", serialize = "exit", serialize = "q")]
    Quit,
}

impl SlashCommand {
    /// Short user-visible description shown in `/help`.
    pub fn description(&self) -> &'static str {
        match self {
            SlashCommand::Provider => "switch the active AI provider  e.g. /provider claude",
            SlashCommand::Approve => {
                "approve the next task dispatch when execution policy requires prompting"
            }
            SlashCommand::Model => {
                "set the model for the current provider  e.g. /model claude-opus-4-5"
            }
            SlashCommand::Providers => "list all registered providers",
            SlashCommand::Apply => "merge a preserved worktree into the base branch",
            SlashCommand::Discard => "discard a preserved worktree (abox stop --clean)",
            SlashCommand::Sandboxes => {
                "list all active and preserved sandboxes  (aliases: /ls /list)"
            }
            SlashCommand::Diverge => "show divergence summary for a preserved worktree",
            SlashCommand::Diff => "show a colorised unified diff for a preserved worktree",
            SlashCommand::New => {
                "clear transcript and local shelf view (does not abort running tasks)"
            }
            SlashCommand::Clear => "clear the transcript display",
            SlashCommand::Config => "show current configuration",
            SlashCommand::Status => "show session, provider, model, and active sandbox count",
            SlashCommand::Doctor => "probe abox and provider binaries for health issues",
            SlashCommand::Help => "show this help  (alias: /h /?)",
            SlashCommand::Quit => "exit bakudo  (aliases: /exit /q)",
        }
    }

    /// Whether this command can be run while a task is in progress.
    pub fn available_during_task(&self) -> bool {
        matches!(
            self,
            SlashCommand::Providers
                | SlashCommand::Sandboxes
                | SlashCommand::Status
                | SlashCommand::Config
                | SlashCommand::Doctor
                | SlashCommand::Help
                | SlashCommand::Clear
                | SlashCommand::Approve
                | SlashCommand::Diverge
                | SlashCommand::Diff
                | SlashCommand::Quit
        )
    }

    /// Whether this command accepts an inline argument after the command name.
    pub fn supports_inline_arg(&self) -> bool {
        matches!(
            self,
            SlashCommand::Provider
                | SlashCommand::Model
                | SlashCommand::Apply
                | SlashCommand::Discard
                | SlashCommand::Diverge
                | SlashCommand::Diff
        )
    }

    /// The canonical command string (without leading `/`).
    pub fn command(&self) -> &'static str {
        self.into()
    }
}

// ─── Parsed command with optional argument ─────────────────────────────────

/// The result of parsing a slash command from raw input.
#[derive(Debug, Clone, PartialEq)]
pub struct ParsedCommand {
    pub command: SlashCommand,
    /// The remainder of the input after the command token, trimmed.
    pub arg: String,
}

/// Parse a slash command from raw input.
///
/// Returns `None` if the input does not start with `/`.
/// Returns `Err` with a user-facing error message if the command is unknown
/// or is missing a required argument.
pub fn parse_slash(input: &str) -> Option<Result<ParsedCommand, String>> {
    let trimmed = input.trim();
    if !trimmed.starts_with('/') {
        return None;
    }

    let rest = &trimmed[1..];
    let mut parts = rest.splitn(2, ' ');
    let cmd_str = parts.next().unwrap_or("").to_lowercase();
    let arg = parts.next().unwrap_or("").trim().to_string();

    // Resolve aliases manually for commands that strum can't handle with
    // multiple serialize attributes cleanly.
    let resolved = match cmd_str.as_str() {
        "h" | "?" => Some(SlashCommand::Help),
        _ => cmd_str.parse::<SlashCommand>().ok(),
    };

    let command = match resolved {
        Some(c) => c,
        None => {
            return Some(Err(format!(
                "Unknown command: /{cmd_str}  — type /help for a list of commands"
            )));
        }
    };

    // Validate required arguments. `/model` with no arg is a valid "reset to
    // provider default" so it is not required.
    if command.supports_inline_arg() && arg.is_empty() && command != SlashCommand::Model {
        let usage = match command {
            SlashCommand::Provider => "Usage: /provider <id>  (e.g. /provider claude)",
            SlashCommand::Apply => "Usage: /apply <task_id>",
            SlashCommand::Discard => "Usage: /discard <task_id>",
            SlashCommand::Diverge => "Usage: /diverge <task_id>",
            SlashCommand::Diff => "Usage: /diff <task_id>",
            _ => "Usage: /<command> <arg>",
        };
        return Some(Err(usage.to_string()));
    }

    Some(Ok(ParsedCommand { command, arg }))
}

// ─── Help text ─────────────────────────────────────────────────────────────

/// Return a formatted help string listing all commands in catalog order.
pub fn help_text() -> String {
    let mut out = String::from(
        "Bakudo Slash Commands\n\
         ─────────────────────────────────────────────────────────────\n",
    );
    for cmd in SlashCommand::iter() {
        let name = format!("/{}", cmd.command());
        out.push_str(&format!("  {:<22}  {}\n", name, cmd.description()));
    }
    out.push_str("─────────────────────────────────────────────────────────────\n");
    out.push_str("Type a message and press Enter to dispatch a task to a sandbox.");
    out
}

// ─── Autocomplete ──────────────────────────────────────────────────────────

/// Return all command names that start with `prefix` (without leading `/`).
/// Used for Tab-completion in the composer.
pub fn completions_for(prefix: &str) -> Vec<&'static str> {
    let lower = prefix.to_lowercase();
    SlashCommand::iter()
        .map(|c| c.command())
        .filter(|name| name.starts_with(lower.as_str()))
        .collect()
}

// ─── Tests ─────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn ok(cmd: SlashCommand, arg: &str) -> Option<Result<ParsedCommand, String>> {
        Some(Ok(ParsedCommand {
            command: cmd,
            arg: arg.to_string(),
        }))
    }

    fn err_contains(input: &str, needle: &str) {
        match parse_slash(input) {
            Some(Err(msg)) => assert!(msg.contains(needle), "expected '{needle}' in '{msg}'"),
            other => panic!("expected Err, got {other:?}"),
        }
    }

    #[test]
    fn parse_provider() {
        assert_eq!(
            parse_slash("/provider claude"),
            ok(SlashCommand::Provider, "claude")
        );
    }

    #[test]
    fn parse_model() {
        assert_eq!(
            parse_slash("/model claude-opus-4-5"),
            ok(SlashCommand::Model, "claude-opus-4-5")
        );
    }

    #[test]
    fn parse_model_with_spaces() {
        // Full remainder after command token is the model name.
        assert_eq!(
            parse_slash("/model gpt-4.1 mini"),
            ok(SlashCommand::Model, "gpt-4.1 mini")
        );
    }

    #[test]
    fn parse_quit_aliases() {
        assert_eq!(parse_slash("/quit"), ok(SlashCommand::Quit, ""));
        assert_eq!(parse_slash("/exit"), ok(SlashCommand::Quit, ""));
        assert_eq!(parse_slash("/q"), ok(SlashCommand::Quit, ""));
    }

    #[test]
    fn parse_help_aliases() {
        assert_eq!(parse_slash("/help"), ok(SlashCommand::Help, ""));
        assert_eq!(parse_slash("/h"), ok(SlashCommand::Help, ""));
        assert_eq!(parse_slash("/?"), ok(SlashCommand::Help, ""));
    }

    #[test]
    fn parse_sandboxes_aliases() {
        assert_eq!(parse_slash("/sandboxes"), ok(SlashCommand::Sandboxes, ""));
        assert_eq!(parse_slash("/ls"), ok(SlashCommand::Sandboxes, ""));
        assert_eq!(parse_slash("/list"), ok(SlashCommand::Sandboxes, ""));
    }

    #[test]
    fn not_a_slash_command() {
        assert_eq!(parse_slash("hello world"), None);
        assert_eq!(parse_slash(""), None);
    }

    #[test]
    fn parse_apply() {
        assert_eq!(
            parse_slash("/apply bakudo-attempt-abc"),
            ok(SlashCommand::Apply, "bakudo-attempt-abc")
        );
    }

    #[test]
    fn missing_arg_returns_usage() {
        err_contains("/provider", "Usage:");
        err_contains("/apply", "Usage:");
        err_contains("/discard", "Usage:");
    }

    #[test]
    fn model_without_arg_is_valid_reset() {
        assert_eq!(parse_slash("/model"), ok(SlashCommand::Model, ""));
    }

    #[test]
    fn doctor_has_no_inline_arg() {
        assert_eq!(parse_slash("/doctor"), ok(SlashCommand::Doctor, ""));
    }

    #[test]
    fn diff_requires_task_id() {
        err_contains("/diff", "Usage:");
        assert_eq!(
            parse_slash("/diff bakudo-abc"),
            ok(SlashCommand::Diff, "bakudo-abc")
        );
    }

    #[test]
    fn unknown_command() {
        err_contains("/frobnicate", "Unknown command");
    }

    #[test]
    fn completions_prefix() {
        let completions = completions_for("pr");
        assert!(completions.contains(&"provider"));
        assert!(completions.contains(&"providers"));
    }

    #[test]
    fn available_during_task() {
        assert!(SlashCommand::Status.available_during_task());
        assert!(SlashCommand::Sandboxes.available_during_task());
        assert!(!SlashCommand::Provider.available_during_task());
        assert!(!SlashCommand::New.available_during_task());
    }
}
