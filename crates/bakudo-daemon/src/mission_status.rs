use bakudo_core::mission::{
    Experiment, ExperimentStatus, MissionStatus, Posture, WakeReason, WakeWhen,
};
use chrono::{DateTime, Utc};
use serde_json::Value;

use crate::mission_store::{ActiveWaveRecord, StoredWakeEvent};

#[derive(Debug, Clone)]
pub struct FleetCounts {
    pub active: usize,
    pub queued: usize,
    pub completed: usize,
    pub failed: usize,
}

#[derive(Debug, Clone)]
pub struct MissionBanner {
    pub mission_id: String,
    pub goal: String,
    pub posture: Posture,
    pub status: MissionStatus,
    pub wake: MissionWakeBanner,
    pub active_wave: Option<ActiveWaveSummary>,
    pub wall_clock_remaining_secs: u64,
    pub abox_workers_remaining: u32,
    pub abox_workers_in_flight: u32,
    pub concurrent_max: u32,
    pub pending_user_messages: usize,
    pub pending_questions: usize,
    pub pending_approvals: usize,
    pub latest_issue: Option<String>,
    pub latest_change: Option<String>,
    pub fleet: FleetCounts,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MissionWakeState {
    Idle,
    Queued,
    Running,
}

#[derive(Debug, Clone)]
pub struct MissionWakeBanner {
    pub state: MissionWakeState,
    pub current_reason: Option<WakeReason>,
    pub queued_count: usize,
    pub next_wake_at: Option<DateTime<Utc>>,
    pub timeout_streak: Option<u32>,
}

#[derive(Debug, Clone)]
pub struct ActiveWaveSummary {
    pub total: usize,
    pub running: usize,
    pub queued: usize,
    pub completed: usize,
    pub failed: usize,
    pub concurrency_limit: u32,
    pub wake_when: WakeWhen,
    pub wake_sent: bool,
}

pub(crate) fn mission_operator_state_label(banner: &MissionBanner) -> &'static str {
    if mission_blocker_summary(banner).is_some() {
        return "blocked";
    }
    match banner.status {
        MissionStatus::Pending
        | MissionStatus::AwaitingDeliberator
        | MissionStatus::Deliberating => "working",
        MissionStatus::Sleeping => {
            if banner.fleet.active > 0
                || banner.fleet.queued > 0
                || !matches!(banner.wake.state, MissionWakeState::Idle)
                || banner.pending_user_messages > 0
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

pub(crate) fn mission_blocker_summary(banner: &MissionBanner) -> Option<String> {
    if banner.pending_approvals > 0 {
        return Some(format!(
            "{} approval{} pending",
            banner.pending_approvals,
            if banner.pending_approvals == 1 {
                ""
            } else {
                "s"
            }
        ));
    }
    if banner.pending_questions > 0 {
        return Some(format!(
            "{} question{} pending",
            banner.pending_questions,
            if banner.pending_questions == 1 {
                ""
            } else {
                "s"
            }
        ));
    }
    None
}

pub(crate) fn mission_wake_summary_line(banner: &MissionBanner) -> Option<String> {
    match banner.wake.state {
        MissionWakeState::Running => Some(match banner.wake.current_reason {
            Some(reason) => format!("running: {}", wake_reason_label(reason)),
            None => "running".to_string(),
        }),
        MissionWakeState::Queued => {
            let prefix = format!(
                "{} wake{} queued",
                banner.wake.queued_count,
                if banner.wake.queued_count == 1 {
                    ""
                } else {
                    "s"
                }
            );
            if banner.wake.current_reason == Some(WakeReason::Timeout) {
                if let Some(deadline) = banner.wake.next_wake_at {
                    let mut summary = format!(
                        "{prefix}: timeout backoff until {}",
                        format_wake_deadline(deadline)
                    );
                    if let Some(streak) = banner.wake.timeout_streak {
                        summary.push_str(&format!(" (streak {streak})"));
                    }
                    return Some(summary);
                }
            }
            Some(match banner.wake.current_reason {
                Some(reason) => format!("{prefix}: {}", wake_reason_label(reason)),
                None => prefix,
            })
        }
        MissionWakeState::Idle => None,
    }
}

pub(crate) fn mission_wave_summary_line(banner: &MissionBanner) -> Option<String> {
    let wave = banner.active_wave.as_ref()?;
    let mut summary = format!(
        "{} active, {} queued, {} done, {} failed",
        wave.running, wave.queued, wave.completed, wave.failed
    );
    if wave.wake_sent {
        summary.push_str(", follow-up wake queued");
    } else {
        summary.push_str(&format!(", wake on {}", wake_when_label(wave.wake_when)));
    }
    Some(summary)
}

pub(crate) fn mission_next_action_summary(banner: &MissionBanner) -> &'static str {
    if banner.pending_approvals > 0 {
        return "approve or deny the pending host command";
    }
    if banner.pending_questions > 0 {
        return "answer the pending user question";
    }
    if banner.wake.current_reason == Some(WakeReason::Timeout) && banner.wake.next_wake_at.is_some()
    {
        return "wait for timeout backoff or send steering";
    }
    if matches!(banner.wake.state, MissionWakeState::Idle)
        && banner.fleet.active == 0
        && banner.fleet.queued == 0
    {
        return "send steering or /wake the mission";
    }
    "wait for the next mission event"
}

pub(crate) fn mission_terminal_label(status: MissionStatus) -> &'static str {
    match status {
        MissionStatus::Completed => "completed",
        MissionStatus::Cancelled => "cancelled",
        MissionStatus::Failed => "failed",
        MissionStatus::Pending
        | MissionStatus::AwaitingDeliberator
        | MissionStatus::Deliberating
        | MissionStatus::Sleeping => "active",
    }
}

pub(crate) fn short_mission_id(mission_id: &str) -> String {
    mission_id.chars().take(8).collect()
}

pub(crate) fn wake_reason_label(reason: WakeReason) -> &'static str {
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

pub(crate) fn wake_when_label(wake_when: WakeWhen) -> &'static str {
    match wake_when {
        WakeWhen::AllComplete => "all complete",
        WakeWhen::FirstComplete => "first complete",
        WakeWhen::AnyFailure => "any failure",
    }
}

pub(crate) fn summarize_wake_banner(
    queued_wakes: &[StoredWakeEvent],
    deliberating: bool,
) -> MissionWakeBanner {
    let now = Utc::now();
    let current_reason = queued_wakes.first().map(|record| record.wake.reason);
    let next_wake_at = queued_wakes
        .first()
        .map(|record| record.wake.ready_at())
        .filter(|deadline| *deadline > now);
    let timeout_streak = queued_wakes
        .first()
        .and_then(|record| timeout_streak_from_payload(&record.wake.payload));
    if deliberating {
        return MissionWakeBanner {
            state: MissionWakeState::Running,
            current_reason,
            queued_count: queued_wakes.len().saturating_sub(1),
            next_wake_at: None,
            timeout_streak,
        };
    }
    if queued_wakes.is_empty() {
        return MissionWakeBanner {
            state: MissionWakeState::Idle,
            current_reason: None,
            queued_count: 0,
            next_wake_at: None,
            timeout_streak: None,
        };
    }
    MissionWakeBanner {
        state: MissionWakeState::Queued,
        current_reason,
        queued_count: queued_wakes.len(),
        next_wake_at,
        timeout_streak,
    }
}

pub(crate) fn summarize_active_wave(
    wave: &ActiveWaveRecord,
    experiments: &[Experiment],
) -> ActiveWaveSummary {
    let mut summary = ActiveWaveSummary {
        total: wave.experiment_ids.len(),
        running: 0,
        queued: 0,
        completed: 0,
        failed: 0,
        concurrency_limit: wave.concurrency_limit,
        wake_when: wave.wake_when,
        wake_sent: wave.wake_sent,
    };

    for experiment in experiments
        .iter()
        .filter(|experiment| wave.experiment_ids.contains(&experiment.id))
    {
        match experiment.status {
            ExperimentStatus::Queued => summary.queued += 1,
            ExperimentStatus::Running => summary.running += 1,
            ExperimentStatus::Succeeded => summary.completed += 1,
            ExperimentStatus::Failed | ExperimentStatus::Cancelled | ExperimentStatus::Timeout => {
                summary.failed += 1;
            }
        }
    }

    summary
}

pub(crate) fn timeout_streak_from_payload(payload: &Value) -> Option<u32> {
    payload
        .get("timeout_streak")
        .and_then(Value::as_u64)
        .and_then(|value| u32::try_from(value).ok())
}

pub(crate) fn format_wake_deadline(deadline: DateTime<Utc>) -> String {
    deadline.to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::timeout_streak_from_payload;

    #[test]
    fn timeout_streak_reads_u32_payload_values() {
        assert_eq!(
            timeout_streak_from_payload(&json!({ "timeout_streak": 3 })),
            Some(3)
        );
        assert_eq!(timeout_streak_from_payload(&json!({})), None);
    }
}
