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

    /// Default model override. `None` means use the provider default.
    #[serde(default, deserialize_with = "deserialize_optional_model")]
    pub default_model: Option<String>,

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

fn deserialize_optional_model<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let opt: Option<String> = Option::deserialize(deserializer)?;
    Ok(opt.filter(|s| !s.is_empty()))
}

impl Default for BakudoConfig {
    fn default() -> Self {
        Self {
            abox_bin: default_abox_bin(),
            default_provider: default_provider(),
            default_model: None,
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

    /// Load a layered config: user-level defaults merged with a repo-local
    /// override. Repo-local values win over user-level values when both are
    /// set. `explicit` (from the `-c` CLI flag) wins over everything and
    /// suppresses layering.
    ///
    /// Layers searched when `explicit` is `None`:
    /// 1. `~/.config/bakudo/config.toml`
    /// 2. `<repo_root>/.bakudo/config.toml`
    pub fn load_layered(explicit: Option<&Path>, repo_root: Option<&Path>) -> anyhow::Result<Self> {
        if let Some(path) = explicit {
            return Self::load(path);
        }
        let user_cfg = dirs::config_dir()
            .map(|d| d.join("bakudo").join("config.toml"))
            .map(|p| Self::load(&p))
            .transpose()?
            .unwrap_or_default();
        let repo_cfg = repo_root
            .map(|r| r.join(".bakudo").join("config.toml"))
            .filter(|p| p.exists())
            .map(|p| Self::load(&p))
            .transpose()?;
        Ok(match repo_cfg {
            Some(repo) => user_cfg.merged_with(repo),
            None => user_cfg,
        })
    }

    /// Merge a higher-priority layer over `self`. Non-default fields in
    /// `other` overwrite `self`.
    fn merged_with(self, other: Self) -> Self {
        let defaults = Self::default();
        Self {
            abox_bin: if other.abox_bin != defaults.abox_bin {
                other.abox_bin
            } else {
                self.abox_bin
            },
            default_provider: if other.default_provider != defaults.default_provider {
                other.default_provider
            } else {
                self.default_provider
            },
            default_model: other.default_model.or(self.default_model),
            base_branch: if other.base_branch != defaults.base_branch {
                other.base_branch
            } else {
                self.base_branch
            },
            candidate_policy: if other.candidate_policy != defaults.candidate_policy {
                other.candidate_policy
            } else {
                self.candidate_policy
            },
            sandbox_lifecycle: if other.sandbox_lifecycle != defaults.sandbox_lifecycle {
                other.sandbox_lifecycle
            } else {
                self.sandbox_lifecycle
            },
            timeout_secs: if other.timeout_secs != defaults.timeout_secs {
                other.timeout_secs
            } else {
                self.timeout_secs
            },
            data_dir: other.data_dir.or(self.data_dir),
        }
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
        model: Option<String>,
        repo_root: Option<String>,
        candidate_policy: CandidatePolicy,
        sandbox_lifecycle: SandboxLifecycle,
    ) -> AttemptSpec {
        let mut spec = AttemptSpec::new(prompt, provider_id);
        spec.model = model.filter(|s| !s.is_empty());
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
            Some("gpt-5".to_string()),
            Some("/tmp/repo".to_string()),
            CandidatePolicy::Discard,
            SandboxLifecycle::Ephemeral,
        );

        assert_eq!(spec.provider_id, "codex");
        assert_eq!(spec.model.as_deref(), Some("gpt-5"));
        assert_eq!(spec.repo_root.as_deref(), Some("/tmp/repo"));
        assert_eq!(spec.budget.timeout_secs, 42);
        assert!(spec.permissions.allow_all_tools);
        assert_eq!(spec.candidate_policy, CandidatePolicy::Discard);
        assert_eq!(spec.sandbox_lifecycle, SandboxLifecycle::Ephemeral);
    }

    #[test]
    fn load_layered_repo_wins_over_user() {
        let repo = std::env::temp_dir().join(format!("bakudo-layered-{}", Uuid::new_v4()));
        let repo_cfg_dir = repo.join(".bakudo");
        fs::create_dir_all(&repo_cfg_dir).unwrap();
        fs::write(
            repo_cfg_dir.join("config.toml"),
            "default_provider = \"codex\"\nbase_branch = \"develop\"\n",
        )
        .unwrap();

        let loaded = BakudoConfig::load_layered(None, Some(&repo)).unwrap();
        assert_eq!(loaded.default_provider, "codex");
        assert_eq!(loaded.base_branch, "develop");

        let _ = fs::remove_dir_all(&repo);
    }

    #[test]
    fn empty_default_model_parses_as_none() {
        let path = std::env::temp_dir().join(format!("bakudo-cfg-{}.toml", Uuid::new_v4()));
        fs::write(&path, "default_model = \"\"\n").unwrap();
        let cfg = BakudoConfig::load(&path).unwrap();
        assert_eq!(cfg.default_model, None);
        let _ = fs::remove_file(path);
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
