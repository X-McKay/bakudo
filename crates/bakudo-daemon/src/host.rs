use std::cmp::Reverse;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use chrono::{DateTime, Utc};

use bakudo_core::mission::{MissionStatus, Posture, WakeReason, WakeWhen};
use bakudo_core::protocol::{WorkerProgressKind, WorkerStatus};
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
    pub active_mission: Option<HostMissionSnapshot>,
}

#[derive(Debug, Clone)]
pub struct HostMissionSnapshot {
    pub mission_id: String,
    pub goal: String,
    pub posture: Posture,
    pub status: MissionStatus,
    pub wake_running: bool,
    pub queued_wakes: usize,
    pub current_wake_reason: Option<WakeReason>,
    pub next_wake_at: Option<DateTime<Utc>>,
    pub timeout_streak: Option<u32>,
    pub active_wave: Option<HostActiveWaveSnapshot>,
    pub pending_user_messages: usize,
    pub pending_approvals: Vec<HostPendingApprovalSnapshot>,
    pub pending_questions: Vec<HostPendingQuestionSnapshot>,
    pub latest_tool_call_error: Option<String>,
    pub latest_change: Option<String>,
}

#[derive(Debug, Clone)]
pub struct HostActiveWaveSnapshot {
    pub total: usize,
    pub running: usize,
    pub queued: usize,
    pub completed: usize,
    pub failed: usize,
    pub concurrency_limit: u32,
    pub wake_when: WakeWhen,
    pub wake_sent: bool,
}

#[derive(Debug, Clone)]
pub struct HostPendingApprovalSnapshot {
    pub request_id: String,
    pub command: String,
    pub reason: String,
    pub requested_at: DateTime<Utc>,
}

#[derive(Debug, Clone)]
pub struct HostPendingQuestionSnapshot {
    pub request_id: String,
    pub question: String,
    pub choices: Vec<String>,
    pub asked_at: DateTime<Utc>,
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
    completion_announced: bool,
}

struct TaskTelemetry {
    label: Option<String>,
    last_note: String,
    finished_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum HostIntent {
    StatusSummary,
    RunningWorkers,
    MissionBlockers,
    Candidates,
    MissionSteering,
    MissionStart,
    ClarifyStart,
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
        let has_active_mission =
            state.active_mission.is_some() || snapshot.active_mission.as_ref().is_some();
        match classify_intent(trimmed, has_active_mission) {
            HostIntent::StatusSummary => HostAction::Reply(render_status_summary(&state, snapshot)),
            HostIntent::RunningWorkers => {
                HostAction::Reply(render_running_workers(&state, snapshot))
            }
            HostIntent::MissionBlockers => {
                HostAction::Reply(render_mission_blockers(&state, snapshot))
            }
            HostIntent::Candidates => HostAction::Reply(render_candidates(&state, snapshot)),
            HostIntent::MissionSteering => {
                let urgent = trimmed.starts_with('!');
                let text = if urgent {
                    trimmed.trim_start_matches('!').trim().to_string()
                } else {
                    trimmed.to_string()
                };
                HostAction::SteerMission { text, urgent }
            }
            HostIntent::MissionStart => {
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
                let posture = infer_posture(trimmed);
                HostAction::StartMission {
                    posture,
                    objective: trimmed.to_string(),
                    done_contract: None,
                    constraints: None,
                    announcement: start_announcement(posture, trimmed),
                }
            }
            HostIntent::ClarifyStart => {
                state.pending_intake = Some(PendingIntake {
                    objective: trimmed.to_string(),
                });
                HostAction::Reply(
                    "What does done look like? Include acceptance criteria or constraints in one reply, and I’ll start the mission."
                        .to_string(),
                )
            }
        }
    }

    pub fn mark_mission_started(&self, mission_id: &str, objective: &str, posture: Posture) {
        self.focus_mission(mission_id, objective, posture);
    }

    pub fn focus_mission(&self, mission_id: &str, objective: &str, _posture: Posture) {
        let mut state = self.inner.lock().expect("host runtime mutex poisoned");
        state.pending_intake = None;
        state.active_mission = Some(ActiveMission {
            mission_id: mission_id.to_string(),
            objective: objective.to_string(),
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
            RunnerEvent::Progress(progress) => {
                if matches!(progress.kind, WorkerProgressKind::Heartbeat) {
                    String::new()
                } else {
                    truncate(progress.message.trim())
                }
            }
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

fn render_status_summary(state: &HostRuntimeState, snapshot: &HostSnapshot) -> String {
    let running = running_worker_count(state, snapshot);
    let candidates = review_candidates(snapshot).len();
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
        "Host status: provider {}  model {}  base {}  running {}  candidates {}  failed/timed_out {}",
        snapshot.provider_id,
        model_label(snapshot.model.as_deref()),
        snapshot.base_branch,
        running,
        candidates,
        failed
    )];

    if let Some(pending) = &state.pending_intake {
        lines.push(format!(
            "Pending mission intake: '{}' is waiting for a done contract.",
            pending.objective
        ));
    }

    if let Some(mission) = snapshot.active_mission.as_ref() {
        lines.push(format!(
            "Active mission [{}] {} '{}' ({:?}, {}).",
            short_mission_id(&mission.mission_id),
            mission_status_label(mission),
            mission.goal,
            mission.posture,
            mission_state_overview(mission)
        ));
        if let Some(blocker) = mission_blocker_summary(mission) {
            lines.push(format!("Waiting on {blocker}."));
        } else {
            lines.push(format!("Next: {}.", mission_next_action_summary(mission)));
        }
        if let Some(issue) = mission.latest_tool_call_error.as_deref() {
            lines.push(format!("Latest issue: {issue}"));
        }
        if let Some(change) = mission.latest_change.as_deref() {
            lines.push(format!("Latest change: {change}"));
        }
    } else {
        lines.push("No active mission is focused right now.".to_string());
    }

    lines.extend(render_running_worker_lines(state, snapshot, 3));

    if running == 0 {
        lines.extend(render_recent_outcome_lines(state, snapshot, 3));
    }

    if candidates > 0 {
        lines.push(format!(
            "{} preserved worktree{} need review.",
            candidates,
            if candidates == 1 { "" } else { "s" }
        ));
    }

    lines.join("\n")
}

fn render_running_workers(state: &HostRuntimeState, snapshot: &HostSnapshot) -> String {
    let running = running_worker_count(state, snapshot);
    let mut lines = vec![if running == 0 {
        "No workers are running right now.".to_string()
    } else {
        format!(
            "{} worker{} running right now.",
            running,
            if running == 1 { "" } else { "s" }
        )
    }];
    if let Some(mission) = snapshot.active_mission.as_ref() {
        lines.push(format!(
            "Mission [{}] {} '{}' ({:?}).",
            short_mission_id(&mission.mission_id),
            mission_status_label(mission),
            mission.goal,
            mission.posture
        ));
    }
    lines.extend(render_running_worker_lines(state, snapshot, 5));
    if running == 0 {
        lines.extend(render_recent_outcome_lines(state, snapshot, 3));
    }
    lines.join("\n")
}

fn render_mission_blockers(state: &HostRuntimeState, snapshot: &HostSnapshot) -> String {
    let Some(mission) = snapshot.active_mission.as_ref() else {
        return match &state.pending_intake {
            Some(pending) => format!(
                "No active mission is running yet. Intake is waiting for a done contract for '{}'.",
                pending.objective
            ),
            None => "No active mission is waiting on anything right now.".to_string(),
        };
    };

    let mut lines = vec![format!(
        "Mission [{}] {} '{}' ({:?}).",
        short_mission_id(&mission.mission_id),
        mission_status_label(mission),
        mission.goal,
        mission.posture
    )];

    if !mission.pending_approvals.is_empty() {
        lines.push(format!(
            "Waiting on {} approval{}.",
            mission.pending_approvals.len(),
            if mission.pending_approvals.len() == 1 {
                ""
            } else {
                "s"
            }
        ));
        for approval in mission.pending_approvals.iter().take(3) {
            lines.push(format!(
                "- approval [{}] {} — {}",
                approval.request_id.chars().take(8).collect::<String>(),
                truncate(&approval.reason),
                truncate(&approval.command)
            ));
        }
    } else if !mission.pending_questions.is_empty() {
        lines.push(format!(
            "Waiting on {} user question{}.",
            mission.pending_questions.len(),
            if mission.pending_questions.len() == 1 {
                ""
            } else {
                "s"
            }
        ));
        for question in mission.pending_questions.iter().take(3) {
            lines.push(format!(
                "- question [{}] {}",
                question.request_id.chars().take(8).collect::<String>(),
                truncate(&question.question)
            ));
        }
    } else {
        lines.push(format!("No blocker. {}.", mission_state_overview(mission)));
        lines.push(format!("Next: {}.", mission_next_action_summary(mission)));
    }

    if let Some(issue) = mission.latest_tool_call_error.as_deref() {
        lines.push(format!("Latest issue: {issue}"));
    }

    lines.join("\n")
}

fn render_candidates(state: &HostRuntimeState, snapshot: &HostSnapshot) -> String {
    let mut candidates = review_candidates(snapshot);
    candidates.sort_by(|left, right| {
        right
            .finished_at
            .cmp(&left.finished_at)
            .then_with(|| right.started_at.cmp(&left.started_at))
    });
    if candidates.is_empty() {
        return "No preserved worktrees need review right now.".to_string();
    }

    let mut lines = vec![format!(
        "{} preserved worktree{} need review.",
        candidates.len(),
        if candidates.len() == 1 { "" } else { "s" }
    )];
    for entry in candidates.into_iter().take(5) {
        let note = task_note(state, &entry);
        let location = entry
            .worktree_path
            .as_deref()
            .filter(|path| !path.trim().is_empty())
            .unwrap_or("worktree path unavailable");
        lines.push(format!(
            "- [{}] {} — {} — {}",
            short_task_id(&entry.task_id),
            shelf_state_note(&entry.state),
            truncate(task_label(state, &entry)),
            truncate(location)
        ));
        if note != shelf_state_note(&entry.state) {
            lines.push(format!("  note: {}", truncate(note)));
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

fn running_worker_count(state: &HostRuntimeState, snapshot: &HostSnapshot) -> usize {
    let running_ids: HashSet<&str> = snapshot
        .entries
        .iter()
        .filter(|entry| entry.is_active())
        .map(|entry| entry.task_id.as_str())
        .collect();
    let live_only = state
        .task_notes
        .iter()
        .filter(|(task_id, note)| {
            note.finished_at.is_none() && !running_ids.contains(task_id.as_str())
        })
        .count();
    running_ids.len() + live_only
}

fn render_running_worker_lines(
    state: &HostRuntimeState,
    snapshot: &HostSnapshot,
    limit: usize,
) -> Vec<String> {
    let mut running_entries: Vec<_> = snapshot
        .entries
        .iter()
        .filter(|entry| entry.is_active())
        .collect();
    running_entries.sort_by_key(|entry| Reverse(entry.started_at));
    let mut lines: Vec<String> = running_entries
        .into_iter()
        .take(limit)
        .map(|entry| {
            format!(
                "- [{}] {} — {}",
                short_task_id(&entry.task_id),
                truncate(task_label(state, entry)),
                truncate(task_note(state, entry))
            )
        })
        .collect();

    let running_ids: HashSet<&str> = snapshot
        .entries
        .iter()
        .filter(|entry| entry.is_active())
        .map(|entry| entry.task_id.as_str())
        .collect();
    let mut live_only_ids: Vec<_> = state
        .task_notes
        .iter()
        .filter(|(task_id, note)| {
            note.finished_at.is_none() && !running_ids.contains(task_id.as_str())
        })
        .map(|(task_id, note)| (task_id.as_str(), note))
        .collect();
    live_only_ids.sort_by_key(|(task_id, _)| *task_id);
    for (task_id, note) in live_only_ids
        .into_iter()
        .take(limit.saturating_sub(lines.len()))
    {
        lines.push(format!(
            "- [{}] {} — {}",
            short_task_id(task_id),
            truncate(note.label.as_deref().unwrap_or("running task")),
            truncate(note.last_note.as_str())
        ));
    }
    lines
}

fn render_recent_outcome_lines(
    state: &HostRuntimeState,
    snapshot: &HostSnapshot,
    limit: usize,
) -> Vec<String> {
    let mut recent: Vec<_> = snapshot.entries.iter().collect();
    recent.sort_by(|left, right| {
        right
            .finished_at
            .cmp(&left.finished_at)
            .then_with(|| right.started_at.cmp(&left.started_at))
    });
    recent
        .into_iter()
        .take(limit)
        .map(|entry| {
            format!(
                "- [{}] {} — {}",
                short_task_id(&entry.task_id),
                shelf_state_note(&entry.state),
                truncate(task_note(state, entry))
            )
        })
        .collect()
}

fn review_candidates(snapshot: &HostSnapshot) -> Vec<SandboxRecord> {
    snapshot
        .entries
        .iter()
        .filter(|entry| {
            matches!(
                entry.state,
                SandboxState::Preserved | SandboxState::MergeConflicts
            )
        })
        .cloned()
        .collect()
}

fn task_label<'a>(state: &'a HostRuntimeState, entry: &'a SandboxRecord) -> &'a str {
    state
        .task_notes
        .get(&entry.task_id)
        .and_then(|note| note.label.as_deref())
        .unwrap_or(entry.prompt_summary.as_str())
}

fn task_note<'a>(state: &'a HostRuntimeState, entry: &'a SandboxRecord) -> &'a str {
    state
        .task_notes
        .get(&entry.task_id)
        .map(|note| note.last_note.as_str())
        .unwrap_or_else(|| shelf_state_note(&entry.state))
}

fn classify_intent(text: &str, has_active_mission: bool) -> HostIntent {
    let normalized = normalize(text);
    if matches_candidate_query(&normalized) {
        return HostIntent::Candidates;
    }
    if matches_running_query(&normalized) {
        return HostIntent::RunningWorkers;
    }
    if matches_blocker_query(&normalized) {
        return HostIntent::MissionBlockers;
    }
    if matches_status_query(&normalized) {
        return HostIntent::StatusSummary;
    }
    if has_active_mission {
        return HostIntent::MissionSteering;
    }
    if should_clarify_before_start(text) {
        HostIntent::ClarifyStart
    } else {
        HostIntent::MissionStart
    }
}

fn mission_status_label(mission: &HostMissionSnapshot) -> &'static str {
    if !mission.pending_approvals.is_empty() || !mission.pending_questions.is_empty() {
        return "blocked";
    }
    match mission.status {
        MissionStatus::Pending
        | MissionStatus::AwaitingDeliberator
        | MissionStatus::Deliberating => "working",
        MissionStatus::Sleeping => {
            if mission.wake_running
                || mission.queued_wakes > 0
                || mission
                    .active_wave
                    .as_ref()
                    .is_some_and(|wave| wave.running > 0 || wave.queued > 0)
                || mission.pending_user_messages > 0
            {
                "working"
            } else {
                "waiting"
            }
        }
        MissionStatus::Completed => "completed",
        MissionStatus::Cancelled => "cancelled",
        MissionStatus::Failed => "failed",
    }
}

fn mission_state_overview(mission: &HostMissionSnapshot) -> String {
    if let Some(blocker) = mission_blocker_summary(mission) {
        return blocker;
    }
    if mission.wake_running {
        let running = match mission.current_wake_reason {
            Some(reason) => format!("wake running: {}", wake_reason_label(reason)),
            None => "wake running".to_string(),
        };
        if mission.queued_wakes > 0 {
            return format!(
                "{running}; {} additional wake{} queued",
                mission.queued_wakes,
                if mission.queued_wakes == 1 { "" } else { "s" }
            );
        }
        return running;
    }
    if mission.current_wake_reason == Some(WakeReason::Timeout) {
        if let Some(deadline) = mission.next_wake_at {
            let mut summary = format!("timeout backoff until {}", format_wake_deadline(deadline));
            if let Some(streak) = mission.timeout_streak {
                summary.push_str(&format!(" (streak {streak})"));
            }
            return summary;
        }
    }
    if mission.queued_wakes > 0 {
        return match mission.current_wake_reason {
            Some(reason) => format!(
                "{} wake{} queued: {}",
                mission.queued_wakes,
                if mission.queued_wakes == 1 { "" } else { "s" },
                wake_reason_label(reason)
            ),
            None => format!(
                "{} wake{} queued",
                mission.queued_wakes,
                if mission.queued_wakes == 1 { "" } else { "s" }
            ),
        };
    }
    if let Some(wave) = mission.active_wave.as_ref() {
        let mut parts = Vec::new();
        if wave.running > 0 {
            parts.push(format!("{} active", wave.running));
        }
        if wave.queued > 0 {
            parts.push(format!("{} queued", wave.queued));
        }
        if wave.completed > 0 {
            parts.push(format!("{} done", wave.completed));
        }
        if wave.failed > 0 {
            parts.push(format!("{} failed", wave.failed));
        }
        if parts.is_empty() {
            parts.push(format!(
                "{} worker{} tracked",
                wave.total,
                if wave.total == 1 { "" } else { "s" }
            ));
        }
        let tail = if wave.wake_sent {
            "follow-up wake queued".to_string()
        } else {
            format!("wake on {}", wake_when_label(wave.wake_when))
        };
        return format!("wave {} ({tail})", parts.join(", "));
    }
    if mission.pending_user_messages > 0 {
        return format!(
            "{} user message{} queued",
            mission.pending_user_messages,
            if mission.pending_user_messages == 1 {
                ""
            } else {
                "s"
            }
        );
    }
    match mission.status {
        MissionStatus::Pending => "mission is starting".to_string(),
        MissionStatus::AwaitingDeliberator => "waiting for the deliberator".to_string(),
        MissionStatus::Deliberating => "deliberator is planning the next step".to_string(),
        MissionStatus::Sleeping => "mission is idle between wakes".to_string(),
        MissionStatus::Completed => "mission completed".to_string(),
        MissionStatus::Cancelled => "mission cancelled".to_string(),
        MissionStatus::Failed => "mission failed".to_string(),
    }
}

fn mission_blocker_summary(mission: &HostMissionSnapshot) -> Option<String> {
    if !mission.pending_approvals.is_empty() {
        return Some(format!(
            "{} approval{} pending",
            mission.pending_approvals.len(),
            if mission.pending_approvals.len() == 1 {
                ""
            } else {
                "s"
            }
        ));
    }
    if !mission.pending_questions.is_empty() {
        return Some(format!(
            "{} question{} pending",
            mission.pending_questions.len(),
            if mission.pending_questions.len() == 1 {
                ""
            } else {
                "s"
            }
        ));
    }
    None
}

fn mission_next_action_summary(mission: &HostMissionSnapshot) -> &'static str {
    if !mission.pending_approvals.is_empty() {
        return "approve or deny the pending host command";
    }
    if !mission.pending_questions.is_empty() {
        return "answer the pending user question";
    }
    if mission.current_wake_reason == Some(WakeReason::Timeout) && mission.next_wake_at.is_some() {
        return "wait for timeout backoff or send steering";
    }
    if !mission.wake_running
        && mission.queued_wakes == 0
        && mission
            .active_wave
            .as_ref()
            .map_or(true, |wave| wave.running == 0 && wave.queued == 0)
    {
        return "send steering or use /wake";
    }
    "wait for the next mission event"
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

fn matches_status_query(normalized: &str) -> bool {
    contains_any(
        normalized,
        &[
            "status",
            "progress",
            "how is it going",
            "how are things going",
            "what is going on",
            "what's going on",
            "where are things at",
            "summary",
            "what happened",
        ],
    )
}

fn matches_running_query(normalized: &str) -> bool {
    contains_any(
        normalized,
        &[
            "what is running",
            "what's running",
            "running right now",
            "running now",
            "active workers",
            "workers are active",
            "how many workers",
            "sandboxes",
        ],
    )
}

fn matches_blocker_query(normalized: &str) -> bool {
    contains_any(
        normalized,
        &[
            "waiting on",
            "waiting for",
            "blocked",
            "blocker",
            "why did we stop",
            "why are we stopped",
            "why did it stop",
            "why are we idle",
            "why is it idle",
            "mission waiting",
        ],
    )
}

fn matches_candidate_query(normalized: &str) -> bool {
    contains_any(
        normalized,
        &[
            "candidate",
            "candidates",
            "preserved worktree",
            "preserved worktrees",
            "worktree review",
            "worktrees need review",
            "need review",
            "review queue",
        ],
    )
}

fn contains_any(normalized: &str, phrases: &[&str]) -> bool {
    phrases.iter().any(|phrase| normalized.contains(phrase))
}

fn model_label(model: Option<&str>) -> &str {
    model.filter(|model| !model.is_empty()).unwrap_or("default")
}

fn wake_reason_label(reason: WakeReason) -> &'static str {
    match reason {
        WakeReason::UserMessage => "user message",
        WakeReason::ExperimentsComplete => "experiments complete",
        WakeReason::ExperimentFailed => "experiment failure",
        WakeReason::BudgetWarning => "budget warning",
        WakeReason::BudgetExhausted => "budget exhausted",
        WakeReason::SchedulerTick => "scheduler tick",
        WakeReason::Timeout => "timeout",
        WakeReason::ManualResume => "manual resume",
    }
}

fn format_wake_deadline(deadline: DateTime<Utc>) -> String {
    deadline.to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

fn wake_when_label(wake_when: WakeWhen) -> &'static str {
    match wake_when {
        WakeWhen::AllComplete => "all complete",
        WakeWhen::FirstComplete => "first complete",
        WakeWhen::AnyFailure => "any failure",
    }
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

fn short_mission_id(mission_id: &str) -> String {
    mission_id.chars().take(8).collect()
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
            active_mission: None,
        }
    }

    fn active_mission_snapshot() -> HostMissionSnapshot {
        HostMissionSnapshot {
            mission_id: "mission-12345678".to_string(),
            goal: "Ship the runtime improvements".to_string(),
            posture: Posture::Mission,
            status: MissionStatus::Sleeping,
            wake_running: false,
            queued_wakes: 1,
            current_wake_reason: Some(WakeReason::ManualResume),
            next_wake_at: None,
            timeout_streak: None,
            active_wave: Some(HostActiveWaveSnapshot {
                total: 2,
                running: 0,
                queued: 2,
                completed: 0,
                failed: 0,
                concurrency_limit: 2,
                wake_when: WakeWhen::AllComplete,
                wake_sent: false,
            }),
            pending_user_messages: 0,
            pending_approvals: Vec::new(),
            pending_questions: Vec::new(),
            latest_tool_call_error: None,
            latest_change: Some("mission created: Ship the runtime improvements".to_string()),
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
    fn host_runtime_reports_timeout_backoff_from_mission_state() {
        let host = HostRuntime::new();
        let mut snapshot = snapshot(Vec::new());
        let mut mission = active_mission_snapshot();
        mission.current_wake_reason = Some(WakeReason::Timeout);
        mission.next_wake_at = Some(
            chrono::DateTime::parse_from_rfc3339("2026-04-26T15:04:05Z")
                .unwrap()
                .with_timezone(&Utc),
        );
        mission.timeout_streak = Some(2);
        snapshot.active_mission = Some(mission);

        match host.handle_input("What is the mission waiting on right now?", &snapshot) {
            HostAction::Reply(message) => {
                assert!(message.contains("timeout backoff until 2026-04-26T15:04:05Z"));
                assert!(message.contains("streak 2"));
            }
            other => panic!("expected status reply, got {other:?}"),
        }
    }

    #[test]
    fn host_runtime_classifies_natural_language_status_queries() {
        assert_eq!(
            classify_intent("what is running right now?", true),
            HostIntent::RunningWorkers
        );
        assert_eq!(
            classify_intent("what is the mission waiting on?", true),
            HostIntent::MissionBlockers
        );
        assert_eq!(
            classify_intent("what preserved worktrees need review?", true),
            HostIntent::Candidates
        );
        assert_eq!(
            classify_intent("where are things at overall?", true),
            HostIntent::StatusSummary
        );
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
            "What is running right now?",
            &snapshot(vec![make_record("bakudo-task-1", SandboxState::Running)]),
        ) {
            HostAction::Reply(message) => message,
            other => panic!("expected status reply, got {other:?}"),
        };

        assert!(response.contains("1 worker"));
        assert!(response.contains("indexing relevant files"));
    }

    #[test]
    fn host_runtime_renders_blocked_mission_status_from_snapshot() {
        let host = HostRuntime::new();
        let mut snapshot = snapshot(Vec::new());
        let mut mission = active_mission_snapshot();
        mission.pending_approvals.push(HostPendingApprovalSnapshot {
            request_id: "approval-1".to_string(),
            command: "echo host-ok".to_string(),
            reason: "verify approval".to_string(),
            requested_at: Utc::now(),
        });
        snapshot.active_mission = Some(mission);

        let response = match host.handle_input("What is the mission waiting on?", &snapshot) {
            HostAction::Reply(message) => message,
            other => panic!("expected blocker reply, got {other:?}"),
        };

        assert!(response.contains("Waiting on 1 approval"));
        assert!(response.contains("verify approval"));
    }

    #[test]
    fn host_runtime_renders_preserved_candidates() {
        let host = HostRuntime::new();
        let mut entry = make_record("bakudo-task-2", SandboxState::Preserved);
        entry.prompt_summary = "worker hand-off candidate".to_string();
        entry.worktree_path = Some("/tmp/abox/worktrees/bakudo-task-2".to_string());
        let response = match host.handle_input(
            "What preserved worktrees need review?",
            &snapshot(vec![entry]),
        ) {
            HostAction::Reply(message) => message,
            other => panic!("expected candidate reply, got {other:?}"),
        };

        assert!(response.contains("need review"));
        assert!(response.contains("worker hand-off candidate"));
        assert!(response.contains("/tmp/abox/worktrees/bakudo-task-2"));
    }
}
