use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use bakudo_core::mission::Posture;
use serde::Deserialize;

#[derive(Debug, Clone)]
pub struct ProviderRuntimeConfig {
    pub name: String,
    pub engine: ProviderEngine,
    pub posture: Posture,
    pub engine_args: Vec<String>,
    pub abox_profile: String,
    pub system_prompt_file: PathBuf,
    pub wake_budget: WakeBudget,
    pub env: BTreeMap<String, String>,
    pub resume: ResumeConfig,
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
pub struct ResumeConfig {
    pub flag: Option<String>,
    pub session_id_file: Option<String>,
}

impl Default for ResumeConfig {
    fn default() -> Self {
        Self {
            flag: Some("--resume".to_string()),
            session_id_file: Some(".bakudo/sessions/{mission_id}.id".to_string()),
        }
    }
}

#[derive(Debug, Clone)]
pub struct ProviderCatalog {
    root: PathBuf,
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

    pub fn ensure_defaults(&self) -> Result<()> {
        std::fs::create_dir_all(self.providers_dir())
            .with_context(|| format!("failed to create '{}'", self.providers_dir().display()))?;
        std::fs::create_dir_all(self.prompts_dir())
            .with_context(|| format!("failed to create '{}'", self.prompts_dir().display()))?;
        std::fs::create_dir_all(self.lessons_dir())
            .with_context(|| format!("failed to create '{}'", self.lessons_dir().display()))?;
        std::fs::create_dir_all(self.provenance_dir())
            .with_context(|| format!("failed to create '{}'", self.provenance_dir().display()))?;

        write_if_missing(
            &self.prompts_dir().join("mission.md"),
            DEFAULT_MISSION_PROMPT,
        )?;
        write_if_missing(
            &self.prompts_dir().join("explore.md"),
            DEFAULT_EXPLORE_PROMPT,
        )?;

        for entry in default_provider_files() {
            write_if_missing(&self.providers_dir().join(entry.file_name), entry.contents)?;
        }
        Ok(())
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
            resume: ResumeConfig {
                flag: raw.resume.flag,
                session_id_file: raw.resume.session_id_file,
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
    abox_profile: String,
    system_prompt_file: String,
    #[serde(default)]
    wake_budget: WakeBudgetFile,
    #[serde(default)]
    env: BTreeMap<String, String>,
    #[serde(default)]
    resume: ResumeConfigFile,
}

#[derive(Debug, Default, Deserialize)]
struct WakeBudgetFile {
    tool_calls: Option<u32>,
    wall_clock: Option<String>,
    debounce: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct ResumeConfigFile {
    flag: Option<String>,
    session_id_file: Option<String>,
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

fn write_if_missing(path: &Path, contents: &str) -> Result<()> {
    if path.exists() {
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, contents)
        .with_context(|| format!("failed to write '{}'", path.display()))?;
    Ok(())
}

struct DefaultProviderFile {
    file_name: &'static str,
    contents: &'static str,
}

fn default_provider_files() -> [DefaultProviderFile; 8] {
    [
        DefaultProviderFile {
            file_name: "claude-mission.toml",
            contents: include_str!("../data/providers/claude-mission.toml"),
        },
        DefaultProviderFile {
            file_name: "claude-explore.toml",
            contents: include_str!("../data/providers/claude-explore.toml"),
        },
        DefaultProviderFile {
            file_name: "codex-mission.toml",
            contents: include_str!("../data/providers/codex-mission.toml"),
        },
        DefaultProviderFile {
            file_name: "codex-explore.toml",
            contents: include_str!("../data/providers/codex-explore.toml"),
        },
        DefaultProviderFile {
            file_name: "opencode-mission.toml",
            contents: include_str!("../data/providers/opencode-mission.toml"),
        },
        DefaultProviderFile {
            file_name: "opencode-explore.toml",
            contents: include_str!("../data/providers/opencode-explore.toml"),
        },
        DefaultProviderFile {
            file_name: "gemini-mission.toml",
            contents: include_str!("../data/providers/gemini-mission.toml"),
        },
        DefaultProviderFile {
            file_name: "gemini-explore.toml",
            contents: include_str!("../data/providers/gemini-explore.toml"),
        },
    ]
}

const DEFAULT_MISSION_PROMPT: &str = include_str!("../data/prompts/mission.md");
const DEFAULT_EXPLORE_PROMPT: &str = include_str!("../data/prompts/explore.md");

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
        assert!(cfg.system_prompt_file.ends_with("mission.md"));
        assert!(root.join(".bakudo/providers/codex-mission.toml").exists());
        assert!(root.join(".bakudo/prompts/explore.md").exists());
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
