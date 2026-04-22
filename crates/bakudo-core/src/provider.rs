use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderSpec {
    pub id: String,
    pub display_name: String,
    pub binary: String,
    pub non_interactive_args: Vec<String>,
    pub model_flag: String,
    pub allow_all_flag: Option<String>,
    pub memory_mib: Option<u32>,
    pub cpus: Option<u8>,
}

impl ProviderSpec {
    /// Build the full argument list for a non-interactive invocation.
    pub fn build_args(&self, model: &str, allow_all: bool) -> Vec<String> {
        let mut args = self.non_interactive_args.clone();
        if !model.is_empty() && !self.model_flag.is_empty() {
            args.push(self.model_flag.clone());
            args.push(model.to_string());
        }
        if allow_all {
            if let Some(flag) = &self.allow_all_flag {
                args.push(flag.clone());
            }
        }
        args
    }

    /// Build a command that feeds the prompt from `BAKUDO_PROMPT` into stdin.
    pub fn build_stdin_command(&self, model: &str, allow_all: bool) -> Vec<String> {
        let mut command = vec![
            "bash".to_string(),
            "-lc".to_string(),
            "printf '%s' \"$BAKUDO_PROMPT\" | \"$0\" \"$@\"".to_string(),
            self.binary.clone(),
        ];
        command.extend(self.build_args(model, allow_all));
        command
    }
}

#[derive(Debug, Clone)]
pub struct ProviderRegistry {
    providers: HashMap<String, ProviderSpec>,
    default_provider: String,
}

impl ProviderRegistry {
    pub fn with_defaults() -> Self {
        let mut providers = HashMap::new();

        providers.insert(
            "claude".to_string(),
            ProviderSpec {
                id: "claude".to_string(),
                display_name: "Claude Code".to_string(),
                binary: "claude".to_string(),
                non_interactive_args: vec!["-p".to_string()],
                model_flag: "--model".to_string(),
                allow_all_flag: Some("--dangerously-skip-permissions".to_string()),
                memory_mib: Some(4096),
                cpus: Some(2),
            },
        );

        providers.insert(
            "codex".to_string(),
            ProviderSpec {
                id: "codex".to_string(),
                display_name: "OpenAI Codex CLI".to_string(),
                binary: "codex".to_string(),
                non_interactive_args: vec!["exec".to_string()],
                model_flag: "--model".to_string(),
                allow_all_flag: Some("--full-auto".to_string()),
                memory_mib: Some(4096),
                cpus: Some(2),
            },
        );

        providers.insert(
            "opencode".to_string(),
            ProviderSpec {
                id: "opencode".to_string(),
                display_name: "OpenCode".to_string(),
                binary: "opencode".to_string(),
                non_interactive_args: vec!["run".to_string()],
                model_flag: "--model".to_string(),
                allow_all_flag: None,
                memory_mib: Some(4096),
                cpus: Some(2),
            },
        );

        providers.insert(
            "gemini".to_string(),
            ProviderSpec {
                id: "gemini".to_string(),
                display_name: "Gemini CLI".to_string(),
                binary: "gemini".to_string(),
                non_interactive_args: vec!["-p".to_string()],
                model_flag: "--model".to_string(),
                allow_all_flag: Some("--yolo".to_string()),
                memory_mib: Some(4096),
                cpus: Some(2),
            },
        );

        Self {
            providers,
            default_provider: "claude".to_string(),
        }
    }

    pub fn get(&self, id: &str) -> Option<&ProviderSpec> {
        self.providers.get(id)
    }

    pub fn default_provider_id(&self) -> &str {
        &self.default_provider
    }

    pub fn set_default(&mut self, id: &str) -> Result<(), String> {
        if self.providers.contains_key(id) {
            self.default_provider = id.to_string();
            Ok(())
        } else {
            Err(format!("unknown provider '{}'", id))
        }
    }

    pub fn list_ids(&self) -> Vec<&str> {
        let mut ids: Vec<&str> = self.providers.keys().map(|s| s.as_str()).collect();
        ids.sort();
        ids
    }
}

impl Default for ProviderRegistry {
    fn default() -> Self {
        Self::with_defaults()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_registry_has_all_providers() {
        let reg = ProviderRegistry::with_defaults();
        assert!(reg.get("claude").is_some());
        assert!(reg.get("codex").is_some());
        assert!(reg.get("opencode").is_some());
        assert!(reg.get("gemini").is_some());
    }

    #[test]
    fn claude_args_non_interactive() {
        let reg = ProviderRegistry::with_defaults();
        let args = reg.get("claude").unwrap().build_args("", false);
        assert_eq!(args, vec!["-p"]);
    }

    #[test]
    fn claude_args_with_model_and_allow_all() {
        let reg = ProviderRegistry::with_defaults();
        let args = reg
            .get("claude")
            .unwrap()
            .build_args("claude-opus-4-5", true);
        assert_eq!(
            args,
            vec![
                "-p",
                "--model",
                "claude-opus-4-5",
                "--dangerously-skip-permissions"
            ]
        );
    }

    #[test]
    fn codex_exec_subcommand() {
        let reg = ProviderRegistry::with_defaults();
        let args = reg.get("codex").unwrap().build_args("", false);
        assert_eq!(args, vec!["exec"]);
    }

    #[test]
    fn stdin_command_wraps_provider_and_preserves_args() {
        let reg = ProviderRegistry::with_defaults();
        let cmd = reg.get("codex").unwrap().build_stdin_command("gpt-5", true);
        assert_eq!(cmd[0], "bash");
        assert_eq!(cmd[1], "-lc");
        assert_eq!(cmd[3], "codex");
        assert_eq!(&cmd[4..], &["exec", "--model", "gpt-5", "--full-auto"]);
    }

    #[test]
    fn set_default_unknown_fails() {
        let mut reg = ProviderRegistry::with_defaults();
        assert!(reg.set_default("nonexistent").is_err());
    }
}
