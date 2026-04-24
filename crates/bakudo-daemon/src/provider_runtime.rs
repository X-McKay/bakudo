use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use bakudo_core::mission::Posture;
use serde::{Deserialize, Serialize};

pub const MISSION_CONTRACT_VERSION: u32 = 4;

const CONTRACT_MANIFEST_FILE: &str = "mission-contract.json";

#[derive(Debug, Clone)]
pub struct ProviderRuntimeConfig {
    pub name: String,
    pub engine: ProviderEngine,
    pub posture: Posture,
    pub engine_args: Vec<String>,
    pub allow_all_tools: bool,
    pub abox_profile: String,
    pub system_prompt_file: PathBuf,
    pub wake_budget: WakeBudget,
    pub env: BTreeMap<String, String>,
    pub worker: Option<WorkerRuntimeConfig>,
}

#[derive(Debug, Clone)]
pub struct WorkerRuntimeConfig {
    pub engine: ProviderEngine,
    pub engine_args: Vec<String>,
    pub abox_profile: String,
    pub allow_all_tools: bool,
    pub timeout_secs: u64,
    pub max_output_bytes: usize,
    pub memory_mib: Option<u32>,
    pub cpus: Option<u8>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderEngine {
    ClaudeCode,
    Codex,
    OpenCode,
    Gemini,
    Exec,
}

#[derive(Debug, Clone)]
pub struct WakeBudget {
    pub tool_calls: u32,
    pub wall_clock: Duration,
    pub debounce: Duration,
}

impl Default for WakeBudget {
    fn default() -> Self {
        Self {
            tool_calls: 30,
            wall_clock: Duration::from_secs(5 * 60),
            debounce: Duration::from_millis(1500),
        }
    }
}

#[derive(Debug, Clone)]
pub struct ContractSyncReport {
    pub version: u32,
    pub updated_files: Vec<String>,
    pub forced: bool,
}

#[derive(Debug, Clone)]
pub struct ProviderCatalog {
    root: PathBuf,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ContractSyncMode {
    Ensure,
    Force,
}

impl ProviderCatalog {
    pub fn new(repo_root: impl Into<PathBuf>) -> Self {
        Self {
            root: repo_root.into(),
        }
    }

    pub fn bakudo_dir(&self) -> PathBuf {
        self.root.join(".bakudo")
    }

    pub fn providers_dir(&self) -> PathBuf {
        self.bakudo_dir().join("providers")
    }

    pub fn prompts_dir(&self) -> PathBuf {
        self.bakudo_dir().join("prompts")
    }

    pub fn lessons_dir(&self) -> PathBuf {
        self.bakudo_dir().join("lessons")
    }

    pub fn provenance_dir(&self) -> PathBuf {
        self.bakudo_dir().join("provenance")
    }

    pub fn contract_manifest_path(&self) -> PathBuf {
        self.bakudo_dir().join(CONTRACT_MANIFEST_FILE)
    }

    pub fn ensure_defaults(&self) -> Result<()> {
        self.sync_contract(ContractSyncMode::Ensure).map(|_| ())
    }

    pub fn sync_mission_contract(&self) -> Result<ContractSyncReport> {
        self.sync_contract(ContractSyncMode::Force)
    }

    pub fn load_for(&self, base_provider: &str, posture: Posture) -> Result<ProviderRuntimeConfig> {
        self.ensure_defaults()?;
        let posture_name = posture_name(posture);
        let candidates = [
            format!("{base_provider}-{posture_name}.toml"),
            format!("{base_provider}.toml"),
        ];
        for candidate in candidates {
            let path = self.providers_dir().join(&candidate);
            if path.exists() {
                return self.load_path(&path);
            }
        }
        Err(anyhow!(
            "no provider config found for provider '{}' posture '{}'",
            base_provider,
            posture_name
        ))
    }

    fn sync_contract(&self, mode: ContractSyncMode) -> Result<ContractSyncReport> {
        std::fs::create_dir_all(self.providers_dir())
            .with_context(|| format!("failed to create '{}'", self.providers_dir().display()))?;
        std::fs::create_dir_all(self.prompts_dir())
            .with_context(|| format!("failed to create '{}'", self.prompts_dir().display()))?;
        std::fs::create_dir_all(self.lessons_dir())
            .with_context(|| format!("failed to create '{}'", self.lessons_dir().display()))?;
        std::fs::create_dir_all(self.provenance_dir())
            .with_context(|| format!("failed to create '{}'", self.provenance_dir().display()))?;

        let manifest_path = self.contract_manifest_path();
        let manifest = read_manifest(&manifest_path)?;
        let assets = default_contract_files();
        let mut updated_files = Vec::new();

        if mode == ContractSyncMode::Ensure
            && manifest
                .as_ref()
                .map(|item| item.version == MISSION_CONTRACT_VERSION)
                .unwrap_or(false)
        {
            for asset in &assets {
                let path = self.bakudo_dir().join(asset.relative_path);
                if !path.exists() {
                    write_text(&path, asset.contents)?;
                    updated_files.push(asset.relative_path.to_string());
                }
            }
            if !updated_files.is_empty() {
                write_manifest(&manifest_path, &contract_manifest())?;
            }
            return Ok(ContractSyncReport {
                version: MISSION_CONTRACT_VERSION,
                updated_files,
                forced: false,
            });
        }

        if mode == ContractSyncMode::Ensure {
            let mut blocked = Vec::new();
            for asset in &assets {
                let path = self.bakudo_dir().join(asset.relative_path);
                if path.exists() {
                    blocked.push(asset.relative_path.to_string());
                }
            }
            if !blocked.is_empty() {
                let rel = blocked.join(", ");
                return Err(anyhow!(
                    "mission contract is out of date for repo-local defaults: {}. \
run `bakudo doctor --sync-mission-contract` to overwrite the shipped mission prompts/providers with the current contract",
                    rel
                ));
            }
        }

        for asset in &assets {
            let path = self.bakudo_dir().join(asset.relative_path);
            let changed = match std::fs::read_to_string(&path) {
                Ok(existing) => existing != asset.contents,
                Err(_) => true,
            };
            if changed {
                write_text(&path, asset.contents)?;
                updated_files.push(asset.relative_path.to_string());
            }
        }
        write_manifest(&manifest_path, &contract_manifest())?;
        Ok(ContractSyncReport {
            version: MISSION_CONTRACT_VERSION,
            updated_files,
            forced: mode == ContractSyncMode::Force,
        })
    }

    fn load_path(&self, path: &Path) -> Result<ProviderRuntimeConfig> {
        let text = std::fs::read_to_string(path)
            .with_context(|| format!("failed to read provider config '{}'", path.display()))?;
        let raw: ProviderConfigFile = toml::from_str(&text)
            .with_context(|| format!("failed to parse provider config '{}'", path.display()))?;
        let system_prompt_file = resolve_relative(self.bakudo_dir(), &raw.system_prompt_file);
        Ok(ProviderRuntimeConfig {
            name: raw.name,
            engine: raw.engine.parse()?,
            posture: parse_posture(&raw.posture)?,
            engine_args: raw.engine_args,
            allow_all_tools: raw.allow_all_tools,
            abox_profile: raw.abox_profile,
            system_prompt_file,
            wake_budget: WakeBudget {
                tool_calls: raw.wake_budget.tool_calls.unwrap_or(30),
                wall_clock: raw
                    .wake_budget
                    .wall_clock
                    .as_deref()
                    .map(parse_duration_literal)
                    .transpose()?
                    .unwrap_or(Duration::from_secs(5 * 60)),
                debounce: raw
                    .wake_budget
                    .debounce
                    .as_deref()
                    .map(parse_duration_literal)
                    .transpose()?
                    .unwrap_or(Duration::from_millis(1500)),
            },
            env: raw.env,
            worker: match raw.worker {
                Some(worker) => Some(WorkerRuntimeConfig {
                    engine: worker.engine.parse()?,
                    engine_args: worker.engine_args,
                    abox_profile: worker.abox_profile,
                    allow_all_tools: worker.allow_all_tools,
                    timeout_secs: worker.timeout_secs.unwrap_or(1800),
                    max_output_bytes: worker.max_output_bytes.unwrap_or(1024 * 1024),
                    memory_mib: worker.memory_mib,
                    cpus: worker.cpus,
                }),
                None => None,
            },
        })
    }
}

#[derive(Debug, Deserialize)]
struct ProviderConfigFile {
    name: String,
    engine: String,
    posture: String,
    engine_args: Vec<String>,
    #[serde(default)]
    allow_all_tools: bool,
    abox_profile: String,
    system_prompt_file: String,
    #[serde(default)]
    wake_budget: WakeBudgetFile,
    #[serde(default)]
    env: BTreeMap<String, String>,
    #[serde(default)]
    worker: Option<WorkerRuntimeFile>,
}

#[derive(Debug, Default, Deserialize)]
struct WakeBudgetFile {
    tool_calls: Option<u32>,
    wall_clock: Option<String>,
    debounce: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct WorkerRuntimeFile {
    engine: String,
    #[serde(default)]
    engine_args: Vec<String>,
    abox_profile: String,
    #[serde(default)]
    allow_all_tools: bool,
    timeout_secs: Option<u64>,
    max_output_bytes: Option<usize>,
    memory_mib: Option<u32>,
    cpus: Option<u8>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
struct ContractManifest {
    version: u32,
}

impl ProviderEngine {
    pub fn binary(self) -> &'static str {
        match self {
            Self::ClaudeCode => "claude",
            Self::Codex => "codex",
            Self::OpenCode => "opencode",
            Self::Gemini => "gemini",
            Self::Exec => "",
        }
    }

    pub fn allow_all_flag(self) -> Option<&'static str> {
        match self {
            Self::ClaudeCode => Some("--dangerously-skip-permissions"),
            Self::Codex => Some("--full-auto"),
            Self::Gemini => Some("--yolo"),
            Self::OpenCode | Self::Exec => None,
        }
    }
}

impl std::str::FromStr for ProviderEngine {
    type Err = anyhow::Error;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "claude-code" => Ok(Self::ClaudeCode),
            "codex" => Ok(Self::Codex),
            "opencode" => Ok(Self::OpenCode),
            "gemini" => Ok(Self::Gemini),
            "exec" => Ok(Self::Exec),
            other => Err(anyhow!("unknown provider engine '{other}'")),
        }
    }
}

fn parse_duration_literal(value: &str) -> Result<Duration> {
    let trimmed = value.trim();
    if let Some(ms) = trimmed.strip_suffix("ms") {
        return Ok(Duration::from_millis(ms.parse()?));
    }
    if let Some(s) = trimmed.strip_suffix('s') {
        let secs: f64 = s.parse()?;
        return Ok(Duration::from_secs_f64(secs));
    }
    if let Some(m) = trimmed.strip_suffix('m') {
        let mins: f64 = m.parse()?;
        return Ok(Duration::from_secs_f64(mins * 60.0));
    }
    if let Some(h) = trimmed.strip_suffix('h') {
        let hours: f64 = h.parse()?;
        return Ok(Duration::from_secs_f64(hours * 60.0 * 60.0));
    }
    Err(anyhow!("unsupported duration literal '{trimmed}'"))
}

fn parse_posture(value: &str) -> Result<Posture> {
    match value {
        "mission" => Ok(Posture::Mission),
        "explore" => Ok(Posture::Explore),
        other => Err(anyhow!("unknown posture '{other}'")),
    }
}

fn posture_name(posture: Posture) -> &'static str {
    match posture {
        Posture::Mission => "mission",
        Posture::Explore => "explore",
    }
}

fn resolve_relative(base: PathBuf, value: &str) -> PathBuf {
    let path = PathBuf::from(value);
    if path.is_absolute() {
        path
    } else {
        base.join(path)
    }
}

fn write_text(path: &Path, contents: &str) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, contents)
        .with_context(|| format!("failed to write '{}'", path.display()))?;
    Ok(())
}

fn read_manifest(path: &Path) -> Result<Option<ContractManifest>> {
    if !path.exists() {
        return Ok(None);
    }
    let text = std::fs::read_to_string(path)
        .with_context(|| format!("failed to read '{}'", path.display()))?;
    let manifest =
        serde_json::from_str(&text).with_context(|| format!("invalid '{}'", path.display()))?;
    Ok(Some(manifest))
}

fn write_manifest(path: &Path, manifest: &ContractManifest) -> Result<()> {
    write_text(path, &serde_json::to_string_pretty(manifest)?)
}

fn contract_manifest() -> ContractManifest {
    ContractManifest {
        version: MISSION_CONTRACT_VERSION,
    }
}

struct DefaultContractFile {
    relative_path: &'static str,
    contents: &'static str,
}

fn default_contract_files() -> [DefaultContractFile; 10] {
    [
        DefaultContractFile {
            relative_path: "prompts/mission.md",
            contents: include_str!("../data/prompts/mission.md"),
        },
        DefaultContractFile {
            relative_path: "prompts/explore.md",
            contents: include_str!("../data/prompts/explore.md"),
        },
        DefaultContractFile {
            relative_path: "providers/claude-mission.toml",
            contents: include_str!("../data/providers/claude-mission.toml"),
        },
        DefaultContractFile {
            relative_path: "providers/claude-explore.toml",
            contents: include_str!("../data/providers/claude-explore.toml"),
        },
        DefaultContractFile {
            relative_path: "providers/codex-mission.toml",
            contents: include_str!("../data/providers/codex-mission.toml"),
        },
        DefaultContractFile {
            relative_path: "providers/codex-explore.toml",
            contents: include_str!("../data/providers/codex-explore.toml"),
        },
        DefaultContractFile {
            relative_path: "providers/opencode-mission.toml",
            contents: include_str!("../data/providers/opencode-mission.toml"),
        },
        DefaultContractFile {
            relative_path: "providers/opencode-explore.toml",
            contents: include_str!("../data/providers/opencode-explore.toml"),
        },
        DefaultContractFile {
            relative_path: "providers/gemini-mission.toml",
            contents: include_str!("../data/providers/gemini-mission.toml"),
        },
        DefaultContractFile {
            relative_path: "providers/gemini-explore.toml",
            contents: include_str!("../data/providers/gemini-explore.toml"),
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    fn temp_repo_root() -> PathBuf {
        let root = std::env::temp_dir().join(format!("bakudo-provider-catalog-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn catalog_writes_defaults_and_loads_posture_specific_provider() {
        let root = temp_repo_root();
        let catalog = ProviderCatalog::new(&root);
        let cfg = catalog.load_for("codex", Posture::Mission).unwrap();
        assert_eq!(cfg.name, "codex-mission");
        assert_eq!(cfg.posture, Posture::Mission);
        assert!(cfg.allow_all_tools);
        assert!(cfg.system_prompt_file.ends_with("mission.md"));
        assert!(cfg.worker.is_some());
        assert!(root.join(".bakudo/providers/codex-mission.toml").exists());
        assert!(root.join(".bakudo/prompts/explore.md").exists());
        assert!(root.join(".bakudo/mission-contract.json").exists());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn ensure_defaults_rejects_unknown_version_repo_defaults() {
        let root = temp_repo_root();
        let prompt_path = root.join(".bakudo/prompts/mission.md");
        write_text(&prompt_path, "custom repo-local mission prompt").unwrap();

        let catalog = ProviderCatalog::new(&root);
        let err = catalog.ensure_defaults().unwrap_err();
        assert!(err
            .to_string()
            .contains("bakudo doctor --sync-mission-contract"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn sync_mission_contract_overwrites_unknown_version_repo_defaults() {
        let root = temp_repo_root();
        let prompt_path = root.join(".bakudo/prompts/mission.md");
        write_text(&prompt_path, "custom repo-local mission prompt").unwrap();

        let catalog = ProviderCatalog::new(&root);
        let report = catalog.sync_mission_contract().unwrap();
        assert!(report
            .updated_files
            .iter()
            .any(|path| path == "prompts/mission.md"));
        let synced = std::fs::read_to_string(prompt_path).unwrap();
        assert_eq!(synced, include_str!("../data/prompts/mission.md"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn duration_parser_supports_fractional_seconds() {
        assert_eq!(
            parse_duration_literal("1.5s").unwrap(),
            Duration::from_millis(1500)
        );
        assert_eq!(
            parse_duration_literal("10m").unwrap(),
            Duration::from_secs(600)
        );
    }
}
