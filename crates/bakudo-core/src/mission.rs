use std::collections::{HashMap, HashSet};
use std::path::{Component, Path, PathBuf};
use std::time::Duration;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::protocol::{CandidatePolicy, SandboxLifecycle};

fn default_concurrent_max() -> usize {
    2
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SwarmPlan {
    #[serde(default)]
    pub mission_id: Option<String>,
    #[serde(default)]
    pub goal: Option<String>,
    #[serde(default = "default_concurrent_max")]
    pub concurrent_max: usize,
    pub tasks: Vec<SwarmTaskPlan>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SwarmTaskPlan {
    pub id: String,
    pub prompt: String,
    #[serde(default)]
    pub provider: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub approve_execution: bool,
    #[serde(default)]
    pub parent_task_id: Option<String>,
    #[serde(default)]
    pub depends_on: Vec<String>,
    #[serde(default)]
    pub role: Option<String>,
    #[serde(default)]
    pub goal: Option<String>,
    #[serde(default)]
    pub artifact_path: Option<String>,
    #[serde(default)]
    pub candidate_policy: Option<CandidatePolicy>,
    #[serde(default)]
    pub sandbox_lifecycle: Option<SandboxLifecycle>,
}

impl SwarmPlan {
    pub fn validate(&self) -> Result<(), String> {
        if self.concurrent_max == 0 {
            return Err("swarm plan concurrent_max must be at least 1".to_string());
        }
        if self.tasks.is_empty() {
            return Err("swarm plan must contain at least one task".to_string());
        }

        let mut seen = HashSet::new();
        for task in &self.tasks {
            let id = task.id.trim();
            if id.is_empty() {
                return Err("swarm task ids must not be empty".to_string());
            }
            if task.prompt.trim().is_empty() {
                return Err(format!("swarm task '{id}' must include a non-empty prompt"));
            }
            if !seen.insert(id.to_string()) {
                return Err(format!("swarm task id '{id}' is duplicated"));
            }
            if let Some(parent) = task.parent_task_id.as_deref() {
                if parent == id {
                    return Err(format!(
                        "swarm task '{id}' cannot use itself as parent_task_id"
                    ));
                }
            }
            if task.depends_on.iter().any(|dep| dep == id) {
                return Err(format!("swarm task '{id}' cannot depend on itself"));
            }
            if let Some(path) = task.artifact_path.as_deref() {
                normalize_artifact_path(path)
                    .map_err(|err| format!("swarm task '{id}' has invalid artifact_path: {err}"))?;
            }
        }

        for task in &self.tasks {
            if let Some(parent) = task.parent_task_id.as_deref() {
                if !seen.contains(parent) {
                    return Err(format!(
                        "swarm task '{}' references unknown parent_task_id '{}'",
                        task.id, parent
                    ));
                }
            }
            for dep in &task.depends_on {
                if !seen.contains(dep) {
                    return Err(format!(
                        "swarm task '{}' depends on unknown task '{}'",
                        task.id, dep
                    ));
                }
            }
        }

        let edges: HashMap<&str, Vec<&str>> = self
            .tasks
            .iter()
            .map(|task| {
                (
                    task.id.as_str(),
                    task.depends_on.iter().map(|dep| dep.as_str()).collect(),
                )
            })
            .collect();

        let mut visiting = HashSet::new();
        let mut visited = HashSet::new();
        for task in &self.tasks {
            if has_cycle(task.id.as_str(), &edges, &mut visiting, &mut visited) {
                return Err(format!(
                    "swarm plan contains a dependency cycle involving '{}'",
                    task.id
                ));
            }
        }

        Ok(())
    }
}

pub fn normalize_artifact_path(path: &str) -> Result<PathBuf, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("artifact_path must not be empty".to_string());
    }

    let candidate = Path::new(trimmed);
    if candidate.is_absolute() {
        return Err("artifact_path must be relative".to_string());
    }

    let mut normalized = PathBuf::new();
    for component in candidate.components() {
        match component {
            Component::Normal(part) => normalized.push(part),
            Component::CurDir => {
                return Err("artifact_path must not contain '.' path segments".to_string());
            }
            Component::ParentDir => {
                return Err("artifact_path must not contain '..' path segments".to_string());
            }
            Component::RootDir | Component::Prefix(_) => {
                return Err("artifact_path must be relative".to_string());
            }
        }
    }

    if normalized.as_os_str().is_empty() {
        return Err("artifact_path must contain at least one normal path segment".to_string());
    }

    Ok(normalized)
}

fn has_cycle<'a>(
    node: &'a str,
    edges: &HashMap<&'a str, Vec<&'a str>>,
    visiting: &mut HashSet<&'a str>,
    visited: &mut HashSet<&'a str>,
) -> bool {
    if visited.contains(node) {
        return false;
    }
    if !visiting.insert(node) {
        return true;
    }
    if let Some(children) = edges.get(node) {
        for child in children {
            if has_cycle(child, edges, visiting, visited) {
                return true;
            }
        }
    }
    visiting.remove(node);
    visited.insert(node);
    false
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct MissionId(pub Uuid);

impl MissionId {
    pub fn new() -> Self {
        Self(Uuid::new_v4())
    }
}

impl Default for MissionId {
    fn default() -> Self {
        Self::new()
    }
}

impl std::fmt::Display for MissionId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct ExperimentId(pub Uuid);

impl ExperimentId {
    pub fn new() -> Self {
        Self(Uuid::new_v4())
    }
}

impl Default for ExperimentId {
    fn default() -> Self {
        Self::new()
    }
}

impl std::fmt::Display for ExperimentId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct WakeId(pub Uuid);

impl WakeId {
    pub fn new() -> Self {
        Self(Uuid::new_v4())
    }
}

impl Default for WakeId {
    fn default() -> Self {
        Self::new()
    }
}

impl std::fmt::Display for WakeId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Posture {
    Mission,
    Explore,
}

impl std::fmt::Display for Posture {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Mission => f.write_str("mission"),
            Self::Explore => f.write_str("explore"),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Wallet {
    pub wall_clock_remaining: Duration,
    pub abox_workers_remaining: u32,
    pub abox_workers_in_flight: u32,
    pub concurrent_max: u32,
}

impl Wallet {
    pub fn can_dispatch(&self, n: u32) -> bool {
        n <= self.abox_workers_remaining
            && self.abox_workers_in_flight.saturating_add(n) <= self.concurrent_max
            && !self.wall_clock_remaining.is_zero()
    }

    pub fn debit_workers(&mut self, n: u32) -> bool {
        if !self.can_dispatch(n) {
            return false;
        }
        self.abox_workers_remaining = self.abox_workers_remaining.saturating_sub(n);
        self.abox_workers_in_flight = self.abox_workers_in_flight.saturating_add(n);
        true
    }

    pub fn mark_finished(&mut self, n: u32) {
        self.abox_workers_in_flight = self.abox_workers_in_flight.saturating_sub(n);
    }
}

impl Default for Wallet {
    fn default() -> Self {
        Self {
            wall_clock_remaining: Duration::from_secs(30 * 60),
            abox_workers_remaining: 12,
            abox_workers_in_flight: 0,
            concurrent_max: 4,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Mission {
    pub id: MissionId,
    pub goal: String,
    pub posture: Posture,
    pub provider_name: String,
    pub abox_profile: String,
    pub wallet: Wallet,
    pub status: MissionStatus,
    pub created_at: DateTime<Utc>,
    pub completed_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MissionStatus {
    Pending,
    AwaitingDeliberator,
    Deliberating,
    Sleeping,
    Completed,
    Cancelled,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Experiment {
    pub id: ExperimentId,
    pub mission_id: MissionId,
    pub label: String,
    pub spec: ExperimentSpec,
    pub status: ExperimentStatus,
    pub started_at: Option<DateTime<Utc>>,
    pub finished_at: Option<DateTime<Utc>>,
    pub summary: Option<ExperimentSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExperimentSpec {
    pub base_branch: String,
    pub script: ExperimentScript,
    pub skill: Option<String>,
    pub hypothesis: String,
    #[serde(default)]
    pub metric_keys: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ExperimentScript {
    Inline { source: String },
    File { path: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExperimentStatus {
    Queued,
    Running,
    Succeeded,
    Failed,
    Cancelled,
    Timeout,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExperimentSummary {
    pub exit_code: i32,
    pub duration: Duration,
    pub stdout_tail: String,
    pub stderr_tail: String,
    #[serde(default)]
    pub metrics: serde_json::Map<String, serde_json::Value>,
    pub patch_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WakeEvent {
    pub id: WakeId,
    pub mission_id: MissionId,
    pub reason: WakeReason,
    pub created_at: DateTime<Utc>,
    pub payload: serde_json::Value,
    pub blackboard: Blackboard,
    pub wallet: Wallet,
    #[serde(default)]
    pub user_inbox: Vec<UserMessage>,
    #[serde(default)]
    pub recent_ledger: Vec<LedgerEntry>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WakeReason {
    UserMessage,
    ExperimentsComplete,
    ExperimentFailed,
    BudgetWarning,
    BudgetExhausted,
    SchedulerTick,
    Timeout,
    ManualResume,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserMessage {
    pub at: DateTime<Utc>,
    pub text: String,
    pub urgent: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Blackboard(pub serde_json::Value);

impl Blackboard {
    pub fn default_layout() -> Self {
        Self(serde_json::json!({
            "version": 1,
            "objective": null,
            "posture": "mission",
            "done_contract": {
                "metrics": [],
                "constraints": [],
                "stop_conditions": []
            },
            "hypotheses": [],
            "active_experiments": [],
            "best_known": null,
            "things_tried": [],
            "next_steps": []
        }))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LedgerEntry {
    pub at: DateTime<Utc>,
    pub kind: LedgerKind,
    pub summary: String,
    pub mission_id: MissionId,
    pub experiment_id: Option<ExperimentId>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LedgerKind {
    Decision,
    ExperimentSummary,
    SkillUsed,
    UserSteering,
    Lesson,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum WakeWhen {
    #[default]
    AllComplete,
    FirstComplete,
    AnyFailure,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base_plan() -> SwarmPlan {
        SwarmPlan {
            mission_id: Some("mission-test".to_string()),
            goal: Some("test goal".to_string()),
            concurrent_max: 2,
            tasks: vec![
                SwarmTaskPlan {
                    id: "prepare".to_string(),
                    prompt: "prepare".to_string(),
                    provider: None,
                    model: None,
                    approve_execution: false,
                    parent_task_id: None,
                    depends_on: Vec::new(),
                    role: Some("builder".to_string()),
                    goal: Some("prepare repo".to_string()),
                    artifact_path: Some("artifacts/prepare.json".to_string()),
                    candidate_policy: None,
                    sandbox_lifecycle: None,
                },
                SwarmTaskPlan {
                    id: "verify".to_string(),
                    prompt: "verify".to_string(),
                    provider: None,
                    model: None,
                    approve_execution: false,
                    parent_task_id: Some("prepare".to_string()),
                    depends_on: vec!["prepare".to_string()],
                    role: Some("verifier".to_string()),
                    goal: Some("verify output".to_string()),
                    artifact_path: Some("artifacts/verify.json".to_string()),
                    candidate_policy: None,
                    sandbox_lifecycle: None,
                },
            ],
        }
    }

    #[test]
    fn swarm_plan_validation_accepts_valid_graph() {
        let plan = base_plan();
        assert!(plan.validate().is_ok());
    }

    #[test]
    fn swarm_plan_validation_rejects_unknown_dependency() {
        let mut plan = base_plan();
        plan.tasks[1].depends_on = vec!["missing".to_string()];
        let err = plan.validate().unwrap_err();
        assert!(err.contains("depends on unknown task"));
    }

    #[test]
    fn swarm_plan_validation_rejects_cycles() {
        let mut plan = base_plan();
        plan.tasks[0].depends_on = vec!["verify".to_string()];
        let err = plan.validate().unwrap_err();
        assert!(err.contains("dependency cycle"));
    }

    #[test]
    fn swarm_plan_validation_rejects_absolute_artifact_paths() {
        let mut plan = base_plan();
        plan.tasks[0].artifact_path = Some("/tmp/out.json".to_string());
        let err = plan.validate().unwrap_err();
        assert!(err.contains("artifact_path"));
        assert!(err.contains("relative"));
    }

    #[test]
    fn normalize_artifact_path_rejects_parent_segments() {
        let err = normalize_artifact_path("../out.json").unwrap_err();
        assert!(err.contains(".."));
    }

    #[test]
    fn wallet_can_dispatch_respects_budget_and_concurrency() {
        let mut wallet = Wallet {
            wall_clock_remaining: Duration::from_secs(60),
            abox_workers_remaining: 3,
            abox_workers_in_flight: 1,
            concurrent_max: 2,
        };

        assert!(wallet.can_dispatch(1));
        assert!(!wallet.can_dispatch(2));
        assert!(wallet.debit_workers(1));
        assert_eq!(wallet.abox_workers_remaining, 2);
        assert_eq!(wallet.abox_workers_in_flight, 2);
        wallet.mark_finished(1);
        assert_eq!(wallet.abox_workers_in_flight, 1);
    }

    #[test]
    fn blackboard_default_layout_contains_required_keys() {
        let board = Blackboard::default_layout();
        let obj = board.0.as_object().unwrap();
        assert!(obj.contains_key("objective"));
        assert!(obj.contains_key("done_contract"));
        assert!(obj.contains_key("best_known"));
        assert!(obj.contains_key("things_tried"));
    }
}
