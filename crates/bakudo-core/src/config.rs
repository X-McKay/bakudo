//! Bakudo configuration, loaded from `~/.config/bakudo/config.toml` or
//! a repo-local `.bakudo/config.toml`.

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
    #[serde(default = "default_candidate_policy")]
    pub candidate_policy: String,

    /// Default sandbox lifecycle.
    #[serde(default = "default_sandbox_lifecycle")]
    pub sandbox_lifecycle: String,

    /// Default timeout in seconds.
    #[serde(default = "default_timeout_secs")]
    pub timeout_secs: u64,

    /// Environment variable allowlist — names forwarded into the VM.
    #[serde(default)]
    pub env_allowlist: Vec<String>,

    /// Directory where bakudo stores session data.
    #[serde(default)]
    pub data_dir: Option<PathBuf>,
}

fn default_abox_bin() -> String { "abox".to_string() }
fn default_provider() -> String { "claude".to_string() }
fn default_base_branch() -> String { "main".to_string() }
fn default_candidate_policy() -> String { "review".to_string() }
fn default_sandbox_lifecycle() -> String { "preserved".to_string() }
fn default_timeout_secs() -> u64 { 300 }

impl Default for BakudoConfig {
    fn default() -> Self {
        Self {
            abox_bin: default_abox_bin(),
            default_provider: default_provider(),
            default_model: String::new(),
            base_branch: default_base_branch(),
            candidate_policy: default_candidate_policy(),
            sandbox_lifecycle: default_sandbox_lifecycle(),
            timeout_secs: default_timeout_secs(),
            env_allowlist: vec![],
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
}
