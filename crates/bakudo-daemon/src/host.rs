use std::cmp::Reverse;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use chrono::{DateTime, Utc};

use bakudo_core::mission::Posture;
use bakudo_core::protocol::WorkerStatus;
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

#[derive(Debug)]
pub enum HostAction {
    Reply(String),
    StartMission {
        posture: Posture,
        objective: String,
        done_contract: Option<String>,
        constraints: Option<String>,
        announcement: String,
    },
    SteerMission {
        text: String,
        urgent: bool,
    },
}

#[derive(Default)]
struct HostRuntimeState {
    pending_intake: Option<PendingIntake>,
    active_mission: Option<ActiveMission>,
    task_notes: HashMap<String, TaskTelemetry>,
}

struct PendingIntake {
    objective: String,
}

struct ActiveMission {
    mission_id: String,
    objective: String,
    posture: Posture,
    started_at: DateTime<Utc>,
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
                "Give me an objective, steer the active mission, or ask for status.".to_string(),
            );
        }

        let mut state = self.inner.lock().expect("host runtime mutex poisoned");

        if is_status_query(trimmed) {
            return HostAction::Reply(render_status(&state, snapshot));
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

        if let Some(pending) = state.pending_intake.take() {
            let posture = infer_posture(&pending.objective);
            let announcement = start_announcement(posture, &pending.objective);
            return HostAction::StartMission {
                posture,
                objective: pending.objective,
                done_contract: Some(trimmed.to_string()),
                constraints: None,
                announcement,
            };
        }

        if should_clarify_before_start(trimmed) {
            state.pending_intake = Some(PendingIntake {
                objective: trimmed.to_string(),
            });
            return HostAction::Reply(
                "What does done look like? Include acceptance criteria or constraints in one reply, and I’ll start the mission."
                    .to_string(),
            );
        }

        let posture = infer_posture(trimmed);
        HostAction::StartMission {
            posture,
            objective: trimmed.to_string(),
            done_contract: None,
            constraints: None,
            announcement: start_announcement(posture, trimmed),
        }
    }

    pub fn mark_mission_started(&self, mission_id: &str, objective: &str, posture: Posture) {
        self.focus_mission(mission_id, objective, posture);
    }

    pub fn focus_mission(&self, mission_id: &str, objective: &str, posture: Posture) {
        let mut state = self.inner.lock().expect("host runtime mutex poisoned");
        state.pending_intake = None;
        state.active_mission = Some(ActiveMission {
            mission_id: mission_id.to_string(),
            objective: objective.to_string(),
            posture,
            started_at: Utc::now(),
            completion_announced: false,
        });
    }

    pub fn mark_mission_completed(&self, mission_id: &str) {
        let mut state = self.inner.lock().expect("host runtime mutex poisoned");
        if state
            .active_mission
            .as_ref()
            .is_some_and(|mission| mission.mission_id == mission_id)
        {
            state.active_mission = None;
        }
    }

    pub fn clear_active_mission(&self) {
        let mut state = self.inner.lock().expect("host runtime mutex poisoned");
        state.active_mission = None;
    }

    pub fn note_task_started(&self, task_id: &str) {
        self.note_task_started_with_label(task_id, None);
    }

    pub fn note_task_started_with_label(&self, task_id: &str, label: Option<String>) {
        let mut state = self.inner.lock().expect("host runtime mutex poisoned");
        state
            .task_notes
            .entry(task_id.to_string())
            .and_modify(|note| {
                note.label = label.clone().or_else(|| note.label.clone());
                note.last_note = "Booting sandbox".to_string();
                note.finished_at = None;
            })
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
        state
            .task_notes
            .entry(task_id.to_string())
            .and_modify(|telemetry| telemetry.last_note = note.clone())
            .or_insert(TaskTelemetry {
                label: None,
                last_note: note,
                finished_at: None,
            });
    }

    pub fn note_task_finished(&self, task_id: &str, state_view: &SandboxState) {
        let mut state = self.inner.lock().expect("host runtime mutex poisoned");
        let note = truncate(shelf_state_note(state_view));
        state
            .task_notes
            .entry(task_id.to_string())
            .and_modify(|telemetry| {
                telemetry.last_note = note.clone();
                telemetry.finished_at = Some(Utc::now());
            })
            .or_insert(TaskTelemetry {
                label: None,
                last_note: note,
                finished_at: Some(Utc::now()),
            });
    }

    pub fn maybe_render_completion_note(&self, snapshot: &HostSnapshot) -> Option<String> {
        let mut state = self.inner.lock().expect("host runtime mutex poisoned");
        let mission = state.active_mission.as_mut()?;
        if mission.completion_announced {
            return None;
        }
        if active_running_count(snapshot) > 0 {
            return None;
        }
        mission.completion_announced = true;
        Some(format!(
            "Mission '{}' is idle. Review the latest outcomes or send new steering for the next wake.",
            mission.objective
        ))
    }
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

    if let Some(pending) = &state.pending_intake {
        lines.push(format!(
            "Pending mission intake: '{}' (waiting for done contract).",
            pending.objective
        ));
    }

    if let Some(mission) = &state.active_mission {
        let age = (Utc::now() - mission.started_at).num_seconds().max(0);
        lines.push(format!(
            "Active mission {} [{}] '{}' — {} running after {}s.",
            mission.mission_id,
            mission.posture,
            mission.objective,
            active_running_count(snapshot),
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
    }

    lines.join("\n")
}

fn active_running_count(snapshot: &HostSnapshot) -> usize {
    snapshot
        .entries
        .iter()
        .filter(|entry| entry.is_active())
        .count()
}

fn should_clarify_before_start(text: &str) -> bool {
    let word_count = text.split_whitespace().count();
    word_count < 5 && !text.contains('\n') && !text.contains(':')
}

fn infer_posture(objective: &str) -> Posture {
    let normalized = normalize(objective);
    if [
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
        "explore",
    ]
    .iter()
    .any(|needle| normalized.contains(needle))
    {
        Posture::Explore
    } else {
        Posture::Mission
    }
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

fn start_announcement(posture: Posture, objective: &str) -> String {
    format!(
        "Starting {} mission '{}'. I’ll hand the request to the conductor and keep later messages conversational.",
        posture,
        objective
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
    fn host_runtime_requests_one_intake_turn_for_short_objective() {
        let host = HostRuntime::new();

        match host.handle_input("Fix daemon", &snapshot(Vec::new())) {
            HostAction::Reply(message) => {
                assert!(message.contains("What does done look like"));
            }
            other => panic!("expected intake reply, got {other:?}"),
        }

        match host.handle_input("Green tests and no planner loop", &snapshot(Vec::new())) {
            HostAction::StartMission {
                objective,
                done_contract,
                ..
            } => {
                assert_eq!(objective, "Fix daemon");
                assert_eq!(
                    done_contract.as_deref(),
                    Some("Green tests and no planner loop")
                );
            }
            other => panic!("expected mission start, got {other:?}"),
        }
    }

    #[test]
    fn host_runtime_starts_specific_requests_immediately() {
        let host = HostRuntime::new();

        match host.handle_input(
            "Implement the revised mission conductor and remove the staged host planner",
            &snapshot(Vec::new()),
        ) {
            HostAction::StartMission { posture, .. } => {
                assert_eq!(posture, Posture::Mission);
            }
            other => panic!("expected direct mission start, got {other:?}"),
        }
    }

    #[test]
    fn host_runtime_routes_active_input_as_steering() {
        let host = HostRuntime::new();
        host.mark_mission_started("mission-1", "Ship it", Posture::Mission);

        match host.handle_input("!Pause and run tests first", &snapshot(Vec::new())) {
            HostAction::SteerMission { text, urgent } => {
                assert!(urgent);
                assert_eq!(text, "Pause and run tests first");
            }
            other => panic!("expected steering, got {other:?}"),
        }
    }

    #[test]
    fn host_runtime_renders_progress_queries() {
        let host = HostRuntime::new();
        host.note_task_started_with_label("bakudo-task-1", Some("mission worker".to_string()));
        host.note_runner_event(
            "bakudo-task-1",
            &RunnerEvent::RawLine("indexing relevant files".to_string()),
        );

        let response = match host.handle_input(
            "Tell me about how things are progressing",
            &snapshot(vec![make_record("bakudo-task-1", SandboxState::Running)]),
        ) {
            HostAction::Reply(message) => message,
            other => panic!("expected status reply, got {other:?}"),
        };

        assert!(response.contains("running 1"));
        assert!(response.contains("indexing relevant files"));
    }
}
