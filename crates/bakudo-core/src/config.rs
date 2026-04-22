//! Bakudo configuration, loaded from `~/.config/bakudo/config.toml` or
//! a repo-local `.bakudo/config.toml`.

use crate::protocol::{
    AttemptBudget, AttemptPermissions, AttemptSpec, CandidatePolicy, SandboxLifecycle,
};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BakudoConfig {
    /// Path to the `abox` binary. Defaults to `abox` on PATH.
    #[serde(default = "default_abox_bin")]
    pub abox_bin: String,

    /// Default provider ID (e.g. "claude").
    #[serde(default = "default_provider")]
    pub default_provider: String,

    /// Default model override. Empty string means use the provider default.
    #[serde(default)]
    pub default_model: String,

    /// Base branch for abox worktrees.
    #[serde(default = "default_base_branch")]
    pub base_branch: String,

    /// Default candidate policy.
    #[serde(default)]
    pub candidate_policy: CandidatePolicy,

    /// Default sandbox lifecycle.
    #[serde(default)]
    pub sandbox_lifecycle: SandboxLifecycle,

    /// Default timeout in seconds.
    #[serde(default = "default_timeout_secs")]
    pub timeout_secs: u64,

    /// Directory where bakudo stores session data.
    #[serde(default)]
    pub data_dir: Option<PathBuf>,
}

fn default_abox_bin() -> String {
    "abox".to_string()
}
fn default_provider() -> String {
    "claude".to_string()
}
fn default_base_branch() -> String {
    "main".to_string()
}
fn default_timeout_secs() -> u64 {
    300
}

impl Default for BakudoConfig {
    fn default() -> Self {
        Self {
            abox_bin: default_abox_bin(),
            default_provider: default_provider(),
            default_model: String::new(),
            base_branch: default_base_branch(),
            candidate_policy: CandidatePolicy::default(),
            sandbox_lifecycle: SandboxLifecycle::default(),
            timeout_secs: default_timeout_secs(),
            data_dir: None,
        }
    }
}

impl BakudoConfig {
    /// Load config from the given path. Returns `Default` if the file does not exist.
    pub fn load(path: &Path) -> anyhow::Result<Self> {
        if !path.exists() {
            return Ok(Self::default());
        }
        let text = std::fs::read_to_string(path)?;
        let cfg: Self = toml::from_str(&text)
            .map_err(|e| anyhow::anyhow!("config parse error in '{}': {e}", path.display()))?;
        Ok(cfg)
    }

    /// Resolve the data directory: explicit config value, or `~/.local/share/bakudo`.
    pub fn resolved_data_dir(&self) -> PathBuf {
        self.data_dir.clone().unwrap_or_else(|| {
            dirs::data_local_dir()
                .unwrap_or_else(|| PathBuf::from("."))
                .join("bakudo")
        })
    }

    pub fn build_attempt_spec(
        &self,
        prompt: impl Into<String>,
        provider_id: impl Into<String>,
        model: impl Into<String>,
        repo_root: Option<String>,
        candidate_policy: CandidatePolicy,
        sandbox_lifecycle: SandboxLifecycle,
    ) -> AttemptSpec {
        let mut spec = AttemptSpec::new(prompt, provider_id);
        spec.model = model.into();
        spec.repo_root = repo_root;
        spec.budget = AttemptBudget {
            timeout_secs: self.timeout_secs,
            ..Default::default()
        };
        spec.permissions = AttemptPermissions {
            allow_all_tools: true,
        };
        spec.candidate_policy = candidate_policy;
        spec.sandbox_lifecycle = sandbox_lifecycle;
        spec
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use uuid::Uuid;

    #[test]
    fn build_attempt_spec_applies_runtime_defaults() {
        let config = BakudoConfig {
            timeout_secs: 42,
            ..Default::default()
        };

        let spec = config.build_attempt_spec(
            "ship it",
            "codex",
            "gpt-5",
            Some("/tmp/repo".to_string()),
            CandidatePolicy::Discard,
            SandboxLifecycle::Ephemeral,
        );

        assert_eq!(spec.provider_id, "codex");
        assert_eq!(spec.model, "gpt-5");
        assert_eq!(spec.repo_root.as_deref(), Some("/tmp/repo"));
        assert_eq!(spec.budget.timeout_secs, 42);
        assert!(spec.permissions.allow_all_tools);
        assert_eq!(spec.candidate_policy, CandidatePolicy::Discard);
        assert_eq!(spec.sandbox_lifecycle, SandboxLifecycle::Ephemeral);
    }

    #[test]
    fn load_rejects_invalid_candidate_policy() {
        let path = std::env::temp_dir().join(format!("bakudo-config-{}.toml", Uuid::new_v4()));
        fs::write(&path, "candidate_policy = \"definitely_not_valid\"\n").unwrap();

        let err = BakudoConfig::load(&path).unwrap_err();
        assert!(err.to_string().contains("candidate_policy"));

        let _ = fs::remove_file(path);
    }
}
