use std::collections::{HashMap, HashSet};
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};

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
}
