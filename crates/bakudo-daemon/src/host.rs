use std::cmp::Reverse;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use chrono::{DateTime, Utc};

use bakudo_core::mission::{SwarmPlan, SwarmTaskPlan};
use bakudo_core::protocol::{CandidatePolicy, SandboxLifecycle, WorkerStatus};
use bakudo_core::state::{SandboxRecord, SandboxState};

use crate::task_runner::RunnerEvent;

#[derive(Clone, Default)]
pub struct HostRuntime {
    inner: Arc<Mutex<HostRuntimeState>>,
}

pub struct HostSnapshot {
    pub entries: Vec<SandboxRecord>,
    pub provider_id: String,
    pub model: Option<String>,
    pub base_branch: String,
}

pub enum HostAction {
    Reply(String),
    LaunchPlan {
        plan: PlannedMission,
        announcement: String,
    },
    SteerMission {
        text: String,
        urgent: bool,
    },
}

#[derive(Debug, Clone)]
pub struct PlannedMission {
    pub mission_id: String,
    pub objective: String,
    pub done_contract: String,
    pub constraints: String,
    pub mode: MissionMode,
    pub plan: SwarmPlan,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MissionMode {
    Discovery,
    Implementation,
}

#[derive(Debug, Clone)]
pub struct DispatchedMissionTask {
    pub task_id: String,
    pub label: String,
}

#[derive(Default)]
struct HostRuntimeState {
    next_mission_seq: usize,
    pending_objective: Option<PendingObjective>,
    proposed_plan: Option<PlannedMission>,
    active_mission: Option<ActiveMission>,
    task_notes: HashMap<String, TaskTelemetry>,
}

struct PendingObjective {
    objective: String,
    done_contract: Option<String>,
    constraints: Option<String>,
}

struct ActiveMission {
    mission_id: String,
    objective: String,
    mode: MissionMode,
    started_at: DateTime<Utc>,
    task_labels: HashMap<String, String>,
    completion_announced: bool,
}

struct TaskTelemetry {
    label: Option<String>,
    last_note: String,
    finished_at: Option<DateTime<Utc>>,
}

impl HostRuntime {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn handle_input(&self, text: &str, snapshot: &HostSnapshot) -> HostAction {
        let trimmed = text.trim();
        if trimmed.is_empty() {
            return HostAction::Reply(
                "Give me an objective or ask about the current session state.".to_string(),
            );
        }

        let mut state = self.inner.lock().expect("host runtime mutex poisoned");

        if is_status_query(trimmed) {
            return HostAction::Reply(render_status(&state, snapshot));
        }

        if let Some(plan) = state.proposed_plan.clone() {
            if is_yes_like(trimmed) {
                return HostAction::LaunchPlan {
                    announcement: launch_announcement(&plan),
                    plan,
                };
            }

            if is_no_like(trimmed) {
                state.proposed_plan = None;
                state.pending_objective = Some(PendingObjective {
                    objective: plan.objective.clone(),
                    done_contract: Some(plan.done_contract.clone()),
                    constraints: Some(plan.constraints.clone()),
                });
                return HostAction::Reply(
                    "Plan cancelled. Tell me what to change and I will restage it.".to_string(),
                );
            }

            let revised_constraints = format!(
                "{}\nAdditional steering: {}",
                plan.constraints.trim(),
                trimmed
            );
            let revised = build_plan(
                &mut state,
                &plan.objective,
                &plan.done_contract,
                &revised_constraints,
            );
            let message = render_plan(&revised, snapshot);
            state.proposed_plan = Some(revised);
            return HostAction::Reply(message);
        }

        if let Some(pending) = state.pending_objective.as_mut() {
            if pending.done_contract.is_none() {
                pending.done_contract = Some(trimmed.to_string());
                return HostAction::Reply(
                    "What constraints should I respect? Mention scope limits, risk tolerance, provider preference, or things I should avoid."
                        .to_string(),
                );
            }

            if pending.constraints.is_none() {
                let objective = pending.objective.clone();
                let done_contract = pending
                    .done_contract
                    .clone()
                    .unwrap_or_else(|| "Make measurable progress.".to_string());
                let constraints = trimmed.to_string();
                let plan = build_plan(&mut state, &objective, &done_contract, &constraints);
                let message = render_plan(&plan, snapshot);
                state.pending_objective = None;
                state.proposed_plan = Some(plan);
                return HostAction::Reply(message);
            }
        }

        if state.active_mission.is_some() {
            let urgent = trimmed.starts_with('!');
            let text = if urgent {
                trimmed.trim_start_matches('!').trim().to_string()
            } else {
                trimmed.to_string()
            };
            return HostAction::SteerMission { text, urgent };
        }

        state.pending_objective = Some(PendingObjective {
            objective: trimmed.to_string(),
            done_contract: None,
            constraints: None,
        });
        HostAction::Reply(format!(
            "I’ll treat that as a new objective:\n{}\n\nBefore I queue workers, what does success look like? Give me the acceptance criteria or stop condition.",
            trimmed
        ))
    }

    pub fn mark_plan_dispatched(&self, plan: &PlannedMission, tasks: Vec<DispatchedMissionTask>) {
        if tasks.is_empty() {
            return;
        }

        let mut state = self.inner.lock().expect("host runtime mutex poisoned");
        let mut task_labels = HashMap::new();
        for task in tasks {
            task_labels.insert(task.task_id.clone(), task.label.clone());
            state
                .task_notes
                .entry(task.task_id)
                .and_modify(|note| note.label = Some(task.label.clone()));
        }
        state.pending_objective = None;
        state.proposed_plan = None;
        state.active_mission = Some(ActiveMission {
            mission_id: plan.mission_id.clone(),
            objective: plan.objective.clone(),
            mode: plan.mode,
            started_at: Utc::now(),
            task_labels,
            completion_announced: false,
        });
    }

    pub fn note_task_started(&self, task_id: &str) {
        let mut state = self.inner.lock().expect("host runtime mutex poisoned");
        let label = state
            .active_mission
            .as_ref()
            .and_then(|mission| mission.task_labels.get(task_id).cloned());
        state
            .task_notes
            .entry(task_id.to_string())
            .and_modify(|note| note.last_note = "Booting sandbox".to_string())
            .or_insert(TaskTelemetry {
                label,
                last_note: "Booting sandbox".to_string(),
                finished_at: None,
            });
    }

    pub fn note_runner_event(&self, task_id: &str, event: &RunnerEvent) {
        let mut state = self.inner.lock().expect("host runtime mutex poisoned");
        let note = match event {
            RunnerEvent::RawLine(line) => truncate(line.trim()),
            RunnerEvent::Progress(progress) => truncate(progress.message.trim()),
            RunnerEvent::InfraError(err) => truncate(&format!("Infrastructure error: {err}")),
            RunnerEvent::Finished(result) => truncate(&format!(
                "{} ({})",
                result.summary.trim(),
                render_worker_status(&result.status)
            )),
        };
        if note.is_empty() {
            return;
        }
        let label = state
            .active_mission
            .as_ref()
            .and_then(|mission| mission.task_labels.get(task_id).cloned());
        state
            .task_notes
            .entry(task_id.to_string())
            .and_modify(|telemetry| telemetry.last_note = note.clone())
            .or_insert(TaskTelemetry {
                label,
                last_note: note,
                finished_at: None,
            });
    }

    pub fn note_task_finished(&self, task_id: &str, state_view: &SandboxState) {
        let mut state = self.inner.lock().expect("host runtime mutex poisoned");
        let note = truncate(shelf_state_note(state_view));
        let label = state
            .active_mission
            .as_ref()
            .and_then(|mission| mission.task_labels.get(task_id).cloned());
        state
            .task_notes
            .entry(task_id.to_string())
            .and_modify(|telemetry| {
                telemetry.last_note = note.clone();
                telemetry.finished_at = Some(Utc::now());
            })
            .or_insert(TaskTelemetry {
                label,
                last_note: note,
                finished_at: Some(Utc::now()),
            });
    }

    pub fn maybe_render_completion_note(&self, snapshot: &HostSnapshot) -> Option<String> {
        let mut state = self.inner.lock().expect("host runtime mutex poisoned");
        let mission = state.active_mission.as_mut()?;
        if mission.completion_announced || mission.task_labels.is_empty() {
            return None;
        }

        if active_running_count(mission, snapshot) > 0 {
            return None;
        }

        mission.completion_announced = true;
        Some(format!(
            "Mission wave complete for '{}'. Ask for progress to review the outcomes or give new steering for the next wave.",
            mission.objective
        ))
    }
}

fn build_plan(
    state: &mut HostRuntimeState,
    objective: &str,
    done_contract: &str,
    constraints: &str,
) -> PlannedMission {
    state.next_mission_seq += 1;
    let mission_id = format!("interactive-mission-{}", state.next_mission_seq);
    let mode = if looks_investigative(objective) {
        MissionMode::Discovery
    } else {
        MissionMode::Implementation
    };
    let tasks = match mode {
        MissionMode::Discovery => discovery_tasks(objective, done_contract, constraints),
        MissionMode::Implementation => implementation_tasks(objective, done_contract, constraints),
    };
    PlannedMission {
        mission_id: mission_id.clone(),
        objective: objective.to_string(),
        done_contract: done_contract.to_string(),
        constraints: constraints.to_string(),
        mode,
        plan: SwarmPlan {
            mission_id: Some(mission_id),
            goal: Some(objective.to_string()),
            concurrent_max: tasks.len().max(1),
            tasks,
        },
    }
}

fn discovery_tasks(objective: &str, done_contract: &str, constraints: &str) -> Vec<SwarmTaskPlan> {
    vec![
        SwarmTaskPlan {
            id: "codebase_scout".to_string(),
            prompt: format!(
                "You are the codebase scout for a Bakudo-hosted mission.\nObjective: {objective}\nSuccess criteria: {done_contract}\nConstraints: {constraints}\n\nInspect the current implementation and identify the smallest set of files, tests, and architectural seams involved. Do not make code changes. Deliver a concise report with recommended next edits and verification targets."
            ),
            provider: None,
            model: None,
            approve_execution: false,
            parent_task_id: None,
            depends_on: Vec::new(),
            role: Some("codebase_scout".to_string()),
            goal: Some("Map relevant files and implementation seams".to_string()),
            artifact_path: None,
            candidate_policy: Some(CandidatePolicy::Discard),
            sandbox_lifecycle: Some(SandboxLifecycle::Ephemeral),
        },
        SwarmTaskPlan {
            id: "state_scout".to_string(),
            prompt: format!(
                "You are the runtime and state scout for a Bakudo-hosted mission.\nObjective: {objective}\nSuccess criteria: {done_contract}\nConstraints: {constraints}\n\nInspect runtime state, historical clues in the repo, and likely operational edges. Do not make code changes. Deliver a concise report about current behavior, likely failure modes, and which existing runtime pieces can be reused."
            ),
            provider: None,
            model: None,
            approve_execution: false,
            parent_task_id: None,
            depends_on: Vec::new(),
            role: Some("state_scout".to_string()),
            goal: Some("Map runtime behavior and reusable infrastructure".to_string()),
            artifact_path: None,
            candidate_policy: Some(CandidatePolicy::Discard),
            sandbox_lifecycle: Some(SandboxLifecycle::Ephemeral),
        },
        SwarmTaskPlan {
            id: "verification_scout".to_string(),
            prompt: format!(
                "You are the verification scout for a Bakudo-hosted mission.\nObjective: {objective}\nSuccess criteria: {done_contract}\nConstraints: {constraints}\n\nInspect the existing tests and likely regression surface. Do not make code changes. Deliver a targeted verification plan, including which tests are missing or too weak and which commands should validate the work."
            ),
            provider: None,
            model: None,
            approve_execution: false,
            parent_task_id: None,
            depends_on: Vec::new(),
            role: Some("verification_scout".to_string()),
            goal: Some("Map verification coverage and missing tests".to_string()),
            artifact_path: None,
            candidate_policy: Some(CandidatePolicy::Discard),
            sandbox_lifecycle: Some(SandboxLifecycle::Ephemeral),
        },
    ]
}

fn implementation_tasks(
    objective: &str,
    done_contract: &str,
    constraints: &str,
) -> Vec<SwarmTaskPlan> {
    vec![
        SwarmTaskPlan {
            id: "implement_primary".to_string(),
            prompt: format!(
                "You are the primary implementation worker for a Bakudo-hosted mission.\nObjective: {objective}\nSuccess criteria: {done_contract}\nConstraints: {constraints}\n\nMake the change directly in the repo, keep the diff focused, and add or update targeted tests when needed. Leave the worktree preserved for host review and include a short summary of what changed and what remains risky."
            ),
            provider: None,
            model: None,
            approve_execution: false,
            parent_task_id: None,
            depends_on: Vec::new(),
            role: Some("implement_primary".to_string()),
            goal: Some("Produce the main candidate implementation".to_string()),
            artifact_path: None,
            candidate_policy: Some(CandidatePolicy::Review),
            sandbox_lifecycle: Some(SandboxLifecycle::Preserved),
        },
        SwarmTaskPlan {
            id: "implement_low_risk".to_string(),
            prompt: format!(
                "You are the low-risk implementation worker for a Bakudo-hosted mission.\nObjective: {objective}\nSuccess criteria: {done_contract}\nConstraints: {constraints}\n\nAim for the smallest safe change that meaningfully advances the objective. Prefer narrow edits over broad refactors. Add only the tests needed to defend the change. Leave the worktree preserved for host review."
            ),
            provider: None,
            model: None,
            approve_execution: false,
            parent_task_id: None,
            depends_on: Vec::new(),
            role: Some("implement_low_risk".to_string()),
            goal: Some("Produce a narrower fallback candidate".to_string()),
            artifact_path: None,
            candidate_policy: Some(CandidatePolicy::Review),
            sandbox_lifecycle: Some(SandboxLifecycle::Preserved),
        },
        SwarmTaskPlan {
            id: "verification_scout".to_string(),
            prompt: format!(
                "You are the verification worker for a Bakudo-hosted mission.\nObjective: {objective}\nSuccess criteria: {done_contract}\nConstraints: {constraints}\n\nIndependently inspect the relevant tests, commands, and regression risks. Run focused validation where appropriate, but do not perform broad refactors. If you edit anything, keep it minimal and explain why. Leave the worktree preserved only if you made a meaningful change."
            ),
            provider: None,
            model: None,
            approve_execution: false,
            parent_task_id: None,
            depends_on: Vec::new(),
            role: Some("verification_scout".to_string()),
            goal: Some("Surface regressions and validation gaps".to_string()),
            artifact_path: None,
            candidate_policy: Some(CandidatePolicy::Review),
            sandbox_lifecycle: Some(SandboxLifecycle::Preserved),
        },
    ]
}

fn render_plan(plan: &PlannedMission, snapshot: &HostSnapshot) -> String {
    let mode = match plan.mode {
        MissionMode::Discovery => "discovery",
        MissionMode::Implementation => "implementation",
    };
    let model = snapshot
        .model
        .as_deref()
        .filter(|model| !model.is_empty())
        .unwrap_or("default");
    let mut lines = vec![
        format!("Plan ready for '{}'.", plan.objective),
        format!(
            "Mode: {mode}  provider: {}  model: {}  base branch: {}",
            snapshot.provider_id, model, snapshot.base_branch
        ),
        format!("Success criteria: {}", plan.done_contract.trim()),
        format!("Constraints: {}", plan.constraints.trim()),
        format!("I would dispatch {} worker(s):", plan.plan.tasks.len()),
    ];
    for task in &plan.plan.tasks {
        lines.push(format!(
            "- {}: {} [{} / {}]",
            task.id,
            task.goal.as_deref().unwrap_or("no goal"),
            task.candidate_policy.unwrap_or(CandidatePolicy::Review),
            task.sandbox_lifecycle
                .unwrap_or(SandboxLifecycle::Preserved),
        ));
    }
    lines.push(
        "Reply 'yes' to dispatch this plan, or reply with changes and I will restage it."
            .to_string(),
    );
    lines.join("\n")
}

fn render_status(state: &HostRuntimeState, snapshot: &HostSnapshot) -> String {
    let model = snapshot
        .model
        .as_deref()
        .filter(|model| !model.is_empty())
        .unwrap_or("default");
    let running_entries: Vec<_> = snapshot
        .entries
        .iter()
        .filter(|entry| entry.is_active())
        .collect();
    let running_ids: HashSet<&str> = running_entries
        .iter()
        .map(|entry| entry.task_id.as_str())
        .collect();
    let mut live_only_ids: Vec<&str> = state
        .task_notes
        .iter()
        .filter(|(task_id, note)| {
            note.finished_at.is_none() && !running_ids.contains(task_id.as_str())
        })
        .map(|(task_id, _)| task_id.as_str())
        .collect();
    live_only_ids.sort_unstable();
    let preserved = snapshot
        .entries
        .iter()
        .filter(|entry| matches!(entry.state, SandboxState::Preserved))
        .count();
    let failed = snapshot
        .entries
        .iter()
        .filter(|entry| {
            matches!(
                entry.state,
                SandboxState::Failed { .. } | SandboxState::TimedOut
            )
        })
        .count();

    let mut lines = vec![format!(
        "Host status: provider {}  model {}  running {}  preserved {}  failed/timed_out {}",
        snapshot.provider_id,
        model,
        running_entries.len() + live_only_ids.len(),
        preserved,
        failed
    )];

    if let Some(pending) = &state.pending_objective {
        let step = if pending.done_contract.is_none() {
            "waiting for success criteria"
        } else {
            "waiting for constraints"
        };
        lines.push(format!(
            "Staged objective: '{}' ({step})",
            pending.objective.trim()
        ));
    }

    if let Some(plan) = &state.proposed_plan {
        lines.push(format!(
            "Plan ready for '{}' with {} worker(s). Reply 'yes' to dispatch.",
            plan.objective,
            plan.plan.tasks.len()
        ));
    }

    if let Some(mission) = &state.active_mission {
        let running_count = active_running_count(mission, snapshot);
        let age = (Utc::now() - mission.started_at).num_seconds().max(0);
        lines.push(format!(
            "Active mission {} [{}] '{}' — {} running after {}s.",
            mission.mission_id,
            mission_mode_label(mission.mode),
            mission.objective,
            running_count,
            age
        ));
    }

    if running_entries.is_empty() && live_only_ids.is_empty() {
        let mut recent: Vec<_> = snapshot.entries.iter().collect();
        recent.sort_by(|left, right| {
            right
                .finished_at
                .cmp(&left.finished_at)
                .then_with(|| right.started_at.cmp(&left.started_at))
        });
        for entry in recent.into_iter().take(3) {
            let note = state
                .task_notes
                .get(&entry.task_id)
                .map(|note| note.last_note.as_str())
                .unwrap_or_else(|| shelf_state_note(&entry.state));
            lines.push(format!(
                "- [{}] {:?} — {}",
                short_task_id(&entry.task_id),
                entry.state,
                note
            ));
        }
        if snapshot.entries.is_empty() {
            lines.push("No sandboxes are active yet.".to_string());
        }
    } else {
        let mut ordered: Vec<_> = running_entries;
        ordered.sort_by_key(|entry| Reverse(entry.started_at));
        for entry in ordered.into_iter().take(5) {
            let label = state
                .task_notes
                .get(&entry.task_id)
                .and_then(|note| note.label.as_deref())
                .unwrap_or(entry.prompt_summary.as_str());
            let note = state
                .task_notes
                .get(&entry.task_id)
                .map(|note| note.last_note.as_str())
                .unwrap_or("Running");
            lines.push(format!(
                "- [{}] {} — {}",
                short_task_id(&entry.task_id),
                label,
                note
            ));
        }
        if snapshot
            .entries
            .iter()
            .filter(|entry| entry.is_active())
            .count()
            < 5
        {
            for task_id in live_only_ids.into_iter().take(
                5 - snapshot
                    .entries
                    .iter()
                    .filter(|entry| entry.is_active())
                    .count(),
            ) {
                let label = state
                    .task_notes
                    .get(task_id)
                    .and_then(|note| note.label.as_deref())
                    .unwrap_or("Pending task");
                let note = state
                    .task_notes
                    .get(task_id)
                    .map(|note| note.last_note.as_str())
                    .unwrap_or("Booting sandbox");
                lines.push(format!(
                    "- [{}] {} — {}",
                    short_task_id(task_id),
                    label,
                    note
                ));
            }
        }
    }

    lines.join("\n")
}

fn launch_announcement(plan: &PlannedMission) -> String {
    format!(
        "Dispatching mission '{}' with {} worker(s). I’ll keep the session conversational, so ask for progress at any time.",
        plan.objective,
        plan.plan.tasks.len()
    )
}

fn mission_mode_label(mode: MissionMode) -> &'static str {
    match mode {
        MissionMode::Discovery => "discovery",
        MissionMode::Implementation => "implementation",
    }
}

fn active_running_count(mission: &ActiveMission, snapshot: &HostSnapshot) -> usize {
    mission
        .task_labels
        .keys()
        .filter(|task_id| {
            snapshot
                .entries
                .iter()
                .find(|entry| &entry.task_id == *task_id)
                .map(|entry| entry.is_active())
                .unwrap_or(false)
        })
        .count()
}

fn looks_investigative(objective: &str) -> bool {
    let normalized = normalize(objective);
    [
        "investigate",
        "review",
        "analyze",
        "understand",
        "look at",
        "what happened",
        "why ",
        "when ",
        "where ",
        "tell me about",
        "find bugs",
    ]
    .iter()
    .any(|needle| normalized.contains(needle))
}

fn is_status_query(text: &str) -> bool {
    let normalized = normalize(text);
    [
        "status",
        "progress",
        "how are things progressing",
        "how things are progressing",
        "tell me about how things are progressing",
        "tell me about progress",
        "what's running",
        "whats running",
        "what is running",
        "how is it going",
        "what is going on",
        "what's going on",
        "show me the sandboxes",
        "show me candidates",
        "where are things at",
    ]
    .iter()
    .any(|phrase| normalized == *phrase || normalized.starts_with(phrase))
}

fn is_yes_like(text: &str) -> bool {
    matches!(
        normalize(text).as_str(),
        "yes"
            | "y"
            | "go ahead"
            | "run it"
            | "do it"
            | "dispatch it"
            | "dispatch"
            | "proceed"
            | "continue"
    )
}

fn is_no_like(text: &str) -> bool {
    matches!(
        normalize(text).as_str(),
        "no" | "n" | "cancel" | "stop" | "never mind" | "dont" | "don't"
    )
}

fn normalize(text: &str) -> String {
    text.trim()
        .trim_matches(|ch: char| matches!(ch, '.' | '!' | '?' | ',' | ';' | ':'))
        .to_ascii_lowercase()
}

fn truncate(text: &str) -> String {
    text.chars().take(160).collect()
}

fn short_task_id(task_id: &str) -> String {
    task_id
        .strip_prefix("bakudo-")
        .unwrap_or(task_id)
        .chars()
        .take(8)
        .collect()
}

fn shelf_state_note(state: &SandboxState) -> &'static str {
    match state {
        SandboxState::Starting => "Sandbox is starting",
        SandboxState::Running => "Sandbox is running",
        SandboxState::Preserved => "Worktree preserved for review",
        SandboxState::Merged => "Worktree merged into the base branch",
        SandboxState::Discarded => "Worktree discarded",
        SandboxState::Failed { .. } => "Run failed",
        SandboxState::TimedOut => "Run timed out",
        SandboxState::MergeConflicts => "Merge conflicts require manual resolution",
    }
}

fn render_worker_status(status: &WorkerStatus) -> &'static str {
    match status {
        WorkerStatus::Succeeded => "succeeded",
        WorkerStatus::Failed => "failed",
        WorkerStatus::TimedOut => "timed out",
        WorkerStatus::Cancelled => "cancelled",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use bakudo_core::protocol::{AttemptId, CandidatePolicy, SandboxLifecycle, SessionId};

    fn make_record(task_id: &str, state: SandboxState) -> SandboxRecord {
        SandboxRecord {
            attempt_id: AttemptId(format!("attempt-{task_id}")),
            session_id: SessionId("session-host".to_string()),
            task_id: task_id.to_string(),
            repo_root: None,
            provider_id: "claude".to_string(),
            model: None,
            prompt_summary: "host runtime test".to_string(),
            state,
            lifecycle: SandboxLifecycle::Preserved,
            candidate_policy: CandidatePolicy::Review,
            started_at: Utc::now(),
            finished_at: None,
            worktree_path: None,
            branch: None,
        }
    }

    fn snapshot(entries: Vec<SandboxRecord>) -> HostSnapshot {
        HostSnapshot {
            entries,
            provider_id: "claude".to_string(),
            model: None,
            base_branch: "main".to_string(),
        }
    }

    #[test]
    fn host_runtime_stages_objective_then_plan() {
        let host = HostRuntime::new();

        match host.handle_input("Restore the host layer", &snapshot(Vec::new())) {
            HostAction::Reply(message) => {
                assert!(message.contains("what does success look like"));
            }
            HostAction::LaunchPlan { .. } => panic!("unexpected launch"),
            HostAction::SteerMission { .. } => panic!("unexpected steering"),
        }

        match host.handle_input(
            "Chat-first orchestration with progress answers",
            &snapshot(Vec::new()),
        ) {
            HostAction::Reply(message) => {
                assert!(message.contains("What constraints should I respect"));
            }
            HostAction::LaunchPlan { .. } => panic!("unexpected launch"),
            HostAction::SteerMission { .. } => panic!("unexpected steering"),
        }

        match host.handle_input(
            "Keep the existing Rust execution core",
            &snapshot(Vec::new()),
        ) {
            HostAction::Reply(message) => {
                assert!(message.contains("Plan ready"));
                assert!(message.contains("Reply 'yes'"));
            }
            HostAction::LaunchPlan { .. } => panic!("unexpected launch"),
            HostAction::SteerMission { .. } => panic!("unexpected steering"),
        }
    }

    #[test]
    fn host_runtime_launches_staged_plan_on_yes() {
        let host = HostRuntime::new();
        let snap = snapshot(Vec::new());
        let _ = host.handle_input("Restore the host layer", &snap);
        let _ = host.handle_input("Chat-first orchestration", &snap);
        let _ = host.handle_input("No rewrite", &snap);

        match host.handle_input("yes", &snap) {
            HostAction::LaunchPlan { plan, announcement } => {
                assert_eq!(plan.plan.tasks.len(), 3);
                assert!(announcement.contains("Dispatching mission"));
            }
            HostAction::Reply(message) => panic!("expected launch, got reply: {message}"),
            HostAction::SteerMission { .. } => panic!("unexpected steering"),
        }
    }

    #[test]
    fn host_runtime_renders_progress_queries() {
        let host = HostRuntime::new();
        host.note_task_started("bakudo-task-1");
        host.note_runner_event(
            "bakudo-task-1",
            &RunnerEvent::RawLine("indexing relevant files".to_string()),
        );

        let response = match host.handle_input(
            "Tell me about how things are progressing",
            &snapshot(vec![make_record("bakudo-task-1", SandboxState::Running)]),
        ) {
            HostAction::Reply(message) => message,
            HostAction::LaunchPlan { .. } => panic!("unexpected launch"),
            HostAction::SteerMission { .. } => panic!("unexpected steering"),
        };

        assert!(response.contains("running 1"));
        assert!(response.contains("indexing relevant files"));
    }
}
