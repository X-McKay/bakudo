//! Bakudo configuration, loaded from `~/.config/bakudo/config.toml` or
//! a repo-local `.bakudo/config.toml`.

use crate::policy::ExecutionPolicy;
use crate::protocol::{
    AttemptBudget, AttemptPermissions, AttemptSpec, CandidatePolicy, SandboxLifecycle,
};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use uuid::Uuid;

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

    /// Execution / approval policy for provider runs.
    #[serde(default)]
    pub execution_policy: ExecutionPolicy,

    /// Optional post-run hook command. Bakudo writes the JSON payload to stdin.
    #[serde(default)]
    pub post_run_hook: Option<Vec<String>>,

    /// Directory where bakudo stores session data.
    #[serde(default)]
    pub data_dir: Option<PathBuf>,
}

#[derive(Debug, Clone, Default, Deserialize)]
struct BakudoConfigLayer {
    #[serde(default)]
    abox_bin: Option<String>,
    #[serde(default)]
    default_provider: Option<String>,
    #[serde(default, deserialize_with = "deserialize_optional_model_layer")]
    default_model: Option<Option<String>>,
    #[serde(default)]
    base_branch: Option<String>,
    #[serde(default)]
    candidate_policy: Option<CandidatePolicy>,
    #[serde(default)]
    sandbox_lifecycle: Option<SandboxLifecycle>,
    #[serde(default)]
    timeout_secs: Option<u64>,
    #[serde(default)]
    execution_policy: Option<ExecutionPolicy>,
    #[serde(default)]
    post_run_hook: Option<Option<Vec<String>>>,
    #[serde(default)]
    data_dir: Option<PathBuf>,
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

fn deserialize_optional_model_layer<'de, D>(
    deserializer: D,
) -> Result<Option<Option<String>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let opt: Option<String> = Option::deserialize(deserializer)?;
    Ok(Some(opt.filter(|s| !s.is_empty())))
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
            execution_policy: ExecutionPolicy::default(),
            post_run_hook: None,
            data_dir: None,
        }
    }
}

impl BakudoConfig {
    /// Load config from the given path. Returns `Default` if the file does not exist.
    pub fn load(path: &Path) -> anyhow::Result<Self> {
        Ok(Self::load_layer(path)?
            .map(|layer| layer.apply_to(Self::default()))
            .unwrap_or_default())
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
        let mut cfg = Self::default();
        if let Some(user_layer) = dirs::config_dir()
            .map(|d| d.join("bakudo").join("config.toml"))
            .map(|p| Self::load_layer(&p))
            .transpose()?
            .flatten()
        {
            cfg = user_layer.apply_to(cfg);
        }
        if let Some(repo_layer) = repo_root
            .map(|r| r.join(".bakudo").join("config.toml"))
            .filter(|p| p.exists())
            .map(|p| Self::load_layer(&p))
            .transpose()?
            .flatten()
        {
            cfg = repo_layer.apply_to(cfg);
        }
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

    /// Resolve a per-repo data dir nested under the shared bakudo data root.
    pub fn resolved_repo_data_dir(&self, repo_root: Option<&Path>) -> PathBuf {
        self.resolved_data_dir()
            .join("repos")
            .join(repo_scope_key(repo_root))
    }

    pub fn resolved_repo_data_dir_from_str(&self, repo_root: Option<&str>) -> PathBuf {
        self.resolved_repo_data_dir(repo_root.map(Path::new))
    }

    #[allow(clippy::too_many_arguments)]
    pub fn build_attempt_spec(
        &self,
        prompt: impl Into<String>,
        provider_id: impl Into<String>,
        model: Option<String>,
        repo_root: Option<String>,
        allow_all_tools: bool,
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
        spec.permissions = AttemptPermissions { allow_all_tools };
        spec.candidate_policy = candidate_policy;
        spec.sandbox_lifecycle = sandbox_lifecycle;
        spec
    }

    fn load_layer(path: &Path) -> anyhow::Result<Option<BakudoConfigLayer>> {
        if !path.exists() {
            return Ok(None);
        }
        let text = std::fs::read_to_string(path)?;
        let layer = toml::from_str(&text)
            .map_err(|e| anyhow::anyhow!("config parse error in '{}': {e}", path.display()))?;
        Ok(Some(layer))
    }
}

impl BakudoConfigLayer {
    fn apply_to(self, base: BakudoConfig) -> BakudoConfig {
        BakudoConfig {
            abox_bin: self.abox_bin.unwrap_or(base.abox_bin),
            default_provider: self.default_provider.unwrap_or(base.default_provider),
            default_model: self.default_model.unwrap_or(base.default_model),
            base_branch: self.base_branch.unwrap_or(base.base_branch),
            candidate_policy: self.candidate_policy.unwrap_or(base.candidate_policy),
            sandbox_lifecycle: self.sandbox_lifecycle.unwrap_or(base.sandbox_lifecycle),
            timeout_secs: self.timeout_secs.unwrap_or(base.timeout_secs),
            execution_policy: self.execution_policy.unwrap_or(base.execution_policy),
            post_run_hook: self.post_run_hook.unwrap_or(base.post_run_hook),
            data_dir: self.data_dir.or(base.data_dir),
        }
    }
}

fn repo_scope_key(repo_root: Option<&Path>) -> String {
    let normalized = repo_root
        .map(normalize_repo_root)
        .unwrap_or_else(|| "no-repo".to_string());
    let label = repo_root
        .and_then(|path| path.file_name())
        .map(|name| sanitize_path_component(&name.to_string_lossy()))
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "workspace".to_string());
    let id = Uuid::new_v5(&Uuid::NAMESPACE_URL, normalized.as_bytes());
    format!("{label}-{id}")
}

fn normalize_repo_root(repo_root: &Path) -> String {
    repo_root
        .canonicalize()
        .unwrap_or_else(|_| repo_root.to_path_buf())
        .to_string_lossy()
        .to_string()
}

fn sanitize_path_component(value: &str) -> String {
    value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' || ch == '.' {
                ch
            } else {
                '-'
            }
        })
        .collect::<String>()
        .trim_matches('-')
        .to_string()
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
            false,
            CandidatePolicy::Discard,
            SandboxLifecycle::Ephemeral,
        );

        assert_eq!(spec.provider_id, "codex");
        assert_eq!(spec.model.as_deref(), Some("gpt-5"));
        assert_eq!(spec.repo_root.as_deref(), Some("/tmp/repo"));
        assert_eq!(spec.budget.timeout_secs, 42);
        assert!(!spec.permissions.allow_all_tools);
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
    fn layered_merge_honors_explicit_default_values() {
        let user: BakudoConfigLayer = toml::from_str(
            "timeout_secs = 42\nbase_branch = \"develop\"\ncandidate_policy = \"discard\"\n",
        )
        .unwrap();
        let repo: BakudoConfigLayer = toml::from_str(
            "timeout_secs = 300\nbase_branch = \"main\"\ncandidate_policy = \"review\"\n",
        )
        .unwrap();

        let merged = repo.apply_to(user.apply_to(BakudoConfig::default()));
        assert_eq!(merged.timeout_secs, 300);
        assert_eq!(merged.base_branch, "main");
        assert_eq!(merged.candidate_policy, CandidatePolicy::Review);
    }

    #[test]
    fn load_rejects_invalid_candidate_policy() {
        let path = std::env::temp_dir().join(format!("bakudo-config-{}.toml", Uuid::new_v4()));
        fs::write(&path, "candidate_policy = \"definitely_not_valid\"\n").unwrap();

        let err = BakudoConfig::load(&path).unwrap_err();
        assert!(err.to_string().contains("candidate_policy"));

        let _ = fs::remove_file(path);
    }

    #[test]
    fn resolved_repo_data_dir_is_stable_per_repo() {
        let cfg = BakudoConfig::default();
        let repo_a = cfg.resolved_repo_data_dir(Some(Path::new("/tmp/repo-a")));
        let repo_a_again = cfg.resolved_repo_data_dir(Some(Path::new("/tmp/repo-a")));
        let repo_b = cfg.resolved_repo_data_dir(Some(Path::new("/tmp/repo-b")));

        assert_eq!(repo_a, repo_a_again);
        assert_ne!(repo_a, repo_b);
    }
}
