//! Codex-style top-strip status rendering adapted from
//! `codex-rs/tui/src/status_indicator_widget.rs` (Apache-2.0).
//!
//! Bakudo uses the same single-line strip to surface both active sandbox work
//! and mission-runtime state, so the UI does not look idle while the
//! deliberator is still processing a request.

use chrono::Local;
use ratatui::{
    style::{Color, Modifier, Style},
    text::{Line, Span},
};
use unicode_width::{UnicodeWidthChar, UnicodeWidthStr};

use bakudo_core::mission::{MissionStatus, WakeReason, WakeWhen};
use bakudo_daemon::session_controller::{MissionBanner, MissionWakeState};

use crate::{
    app::{App, ShelfColor, short_task_id},
    palette,
    shimmer::shimmer_spans,
};

pub(crate) fn fmt_elapsed_compact(elapsed_secs: u64) -> String {
    if elapsed_secs < 60 {
        return format!("{elapsed_secs}s");
    }
    if elapsed_secs < 3600 {
        let minutes = elapsed_secs / 60;
        let seconds = elapsed_secs % 60;
        return format!("{minutes}m {seconds:02}s");
    }

    let hours = elapsed_secs / 3600;
    let minutes = (elapsed_secs % 3600) / 60;
    let seconds = elapsed_secs % 60;
    format!("{hours}h {minutes:02}m {seconds:02}s")
}

pub(crate) fn shows_top_strip(app: &App) -> bool {
    if app.pending_runtime_work.is_some() {
        return true;
    }

    if app.active_task_count > 0
        || app
            .shelf
            .iter()
            .any(|entry| entry.state_color == ShelfColor::Running)
    {
        return true;
    }

    let Some(banner) = app.mission_banner.as_ref() else {
        return false;
    };
    !matches!(
        banner.status,
        MissionStatus::Completed | MissionStatus::Cancelled | MissionStatus::Failed
    )
}

pub(crate) fn render_top_line(app: &App, width: u16) -> Option<Line<'static>> {
    render_status_line(app, width)
        .or_else(|| render_mission_line(app, width))
        .or_else(|| render_pending_line(app, width))
}

pub(crate) fn render_status_line(app: &App, width: u16) -> Option<Line<'static>> {
    let running_entries: Vec<_> = app
        .shelf
        .iter()
        .filter(|entry| entry.state_color == ShelfColor::Running)
        .collect();
    let count = app.active_task_count.max(running_entries.len());
    if count == 0 {
        return None;
    }

    let elapsed_secs = running_entries
        .iter()
        .min_by_key(|entry| entry.started_at)
        .map(|entry| {
            Local::now()
                .signed_duration_since(entry.started_at)
                .num_seconds()
                .max(0) as u64
        })
        .unwrap_or(0);
    let elapsed = fmt_elapsed_compact(elapsed_secs);

    let mut spans = vec![Span::styled(
        "• ",
        Style::default()
            .fg(palette::shelf_running())
            .add_modifier(Modifier::BOLD),
    )];
    spans.extend(shimmer_spans("Running"));
    spans.push(Span::styled(format!(" ({elapsed})"), palette::dim_style()));

    if let Some(entry) = running_entries.first() {
        spans.push(Span::styled(" · ", palette::dim_style()));
        if count > 1 {
            spans.push(Span::styled(
                format!("{count} sandboxes active"),
                palette::dim_style(),
            ));
            spans.push(Span::styled(" · ", palette::dim_style()));
        }
        spans.push(Span::styled(
            format!("[{}]", short_task_id(&entry.task_id)),
            Style::default()
                .fg(palette::role_info_fg())
                .add_modifier(Modifier::BOLD),
        ));
        if !entry.last_note.trim().is_empty() {
            spans.push(Span::raw(" "));
            spans.push(Span::styled(
                entry.last_note.trim().to_string(),
                Style::default().fg(palette::role_agent_fg()),
            ));
        }
    }

    Some(truncate_line_with_ellipsis(Line::from(spans), width))
}

fn render_mission_line(app: &App, width: u16) -> Option<Line<'static>> {
    let banner = app.mission_banner.as_ref()?;
    if matches!(
        banner.status,
        MissionStatus::Completed | MissionStatus::Cancelled | MissionStatus::Failed
    ) {
        return None;
    }

    let mut spans = vec![Span::styled(
        "• ",
        Style::default()
            .fg(palette::shelf_running())
            .add_modifier(Modifier::BOLD),
    )];

    let (label, shimmers, lead_style) = mission_label(banner.status, banner);
    if shimmers {
        spans.extend(shimmer_spans(label));
    } else {
        spans.push(Span::styled(label.to_string(), lead_style));
    }

    for detail in mission_details(banner) {
        spans.push(Span::styled(" · ", palette::dim_style()));
        spans.push(Span::styled(
            detail,
            Style::default().fg(palette::role_agent_fg()),
        ));
    }

    spans.push(Span::styled(" · ", palette::dim_style()));
    spans.push(Span::styled(
        format!("mission {}", banner.goal),
        Style::default().fg(Color::White),
    ));

    Some(truncate_line_with_ellipsis(Line::from(spans), width))
}

fn render_pending_line(app: &App, width: u16) -> Option<Line<'static>> {
    let pending = app.pending_runtime_work.as_ref()?;
    let elapsed = fmt_elapsed_compact(pending.elapsed_secs());
    let mut spans = vec![Span::styled(
        "• ",
        Style::default()
            .fg(palette::shelf_running())
            .add_modifier(Modifier::BOLD),
    )];
    spans.extend(shimmer_spans(pending.label()));
    spans.push(Span::styled(format!(" ({elapsed})"), palette::dim_style()));
    spans.push(Span::styled(" · ", palette::dim_style()));
    spans.push(Span::styled(
        pending.detail().to_string(),
        Style::default().fg(palette::role_agent_fg()),
    ));
    if !pending.summary.trim().is_empty() {
        spans.push(Span::styled(" · ", palette::dim_style()));
        spans.push(Span::styled(
            pending.summary.trim().to_string(),
            Style::default().fg(Color::White),
        ));
    }
    Some(truncate_line_with_ellipsis(Line::from(spans), width))
}

fn mission_label(status: MissionStatus, banner: &MissionBanner) -> (&'static str, bool, Style) {
    if matches!(
        status,
        MissionStatus::Completed | MissionStatus::Cancelled | MissionStatus::Failed
    ) {
        return (
            "Idle",
            false,
            Style::default()
                .fg(Color::White)
                .add_modifier(Modifier::BOLD),
        );
    }

    if mission_blocked_reason(banner).is_some() {
        return (
            "Blocked",
            false,
            Style::default()
                .fg(palette::role_error_fg())
                .add_modifier(Modifier::BOLD),
        );
    }

    match status {
        MissionStatus::Pending
        | MissionStatus::AwaitingDeliberator
        | MissionStatus::Deliberating => (
            "Working",
            true,
            Style::default()
                .fg(palette::shelf_running())
                .add_modifier(Modifier::BOLD),
        ),
        MissionStatus::Sleeping => {
            let has_pending_work = banner.pending_user_messages > 0
                || banner.fleet.queued > 0
                || banner.fleet.active > 0
                || !matches!(banner.wake.state, MissionWakeState::Idle);
            if has_pending_work {
                (
                    "Working",
                    true,
                    Style::default()
                        .fg(palette::shelf_running())
                        .add_modifier(Modifier::BOLD),
                )
            } else {
                (
                    "Waiting",
                    false,
                    Style::default()
                        .fg(Color::White)
                        .add_modifier(Modifier::BOLD),
                )
            }
        }
        MissionStatus::Completed | MissionStatus::Cancelled | MissionStatus::Failed => {
            unreachable!()
        }
    }
}

pub(crate) fn mission_details(banner: &MissionBanner) -> Vec<String> {
    let mut details = Vec::new();

    if let Some(reason) = mission_blocked_reason(banner) {
        details.push(reason);
    }

    if let Some(summary) = mission_wake_summary(banner) {
        details.push(summary);
    }

    if let Some(summary) = mission_wave_summary(banner) {
        details.push(summary);
    }

    if banner.pending_user_messages > 0 {
        details.push(format!(
            "{} message{} queued",
            banner.pending_user_messages,
            if banner.pending_user_messages == 1 {
                ""
            } else {
                "s"
            }
        ));
    }

    if let Some(issue) = banner.latest_issue.as_deref() {
        details.push(format!("issue: {issue}"));
    }

    if let Some(change) = banner.latest_change.as_deref() {
        details.push(format!("latest: {change}"));
    }

    if banner.abox_workers_in_flight > 0 {
        details.push(format!(
            "{} / {} workers in flight",
            banner.abox_workers_in_flight, banner.concurrent_max
        ));
    } else if banner.abox_workers_remaining < banner.concurrent_max || banner.active_wave.is_some()
    {
        details.push(format!(
            "{} workers remaining",
            banner.abox_workers_remaining
        ));
    }

    if details.is_empty() {
        details.push(match banner.status {
            MissionStatus::Pending => "starting mission".to_string(),
            MissionStatus::AwaitingDeliberator => "wake queued".to_string(),
            MissionStatus::Deliberating => "planning next wake".to_string(),
            MissionStatus::Sleeping => "sleeping until next wake".to_string(),
            MissionStatus::Completed | MissionStatus::Cancelled | MissionStatus::Failed => {
                "mission finished".to_string()
            }
        });
    }

    details
}

pub(crate) fn mission_blocked_reason(banner: &MissionBanner) -> Option<String> {
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

pub(crate) fn mission_next_action(banner: &MissionBanner) -> &'static str {
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
        return "send steering or use /wake";
    }
    "wait for the next mission event"
}

pub(crate) fn mission_wake_summary(banner: &MissionBanner) -> Option<String> {
    match banner.wake.state {
        MissionWakeState::Running => Some(match banner.wake.current_reason {
            Some(reason) => format!("wake running: {}", wake_reason_label(reason)),
            None => "wake running".to_string(),
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

pub(crate) fn mission_wave_summary(banner: &MissionBanner) -> Option<String> {
    let wave = banner.active_wave.as_ref()?;
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
            "{} worker{}",
            wave.total,
            if wave.total == 1 { "" } else { "s" }
        ));
    }
    let mut summary = format!("wave {}", parts.join(", "));
    if wave.wake_sent {
        summary.push_str(", follow-up wake queued");
    } else {
        summary.push_str(&format!(", wake on {}", wake_when_label(wave.wake_when)));
    }
    Some(summary)
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

fn format_wake_deadline(deadline: chrono::DateTime<chrono::Utc>) -> String {
    deadline.to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

fn wake_when_label(wake_when: WakeWhen) -> &'static str {
    match wake_when {
        WakeWhen::AllComplete => "all complete",
        WakeWhen::FirstComplete => "first complete",
        WakeWhen::AnyFailure => "any failure",
    }
}

fn truncate_line_with_ellipsis(line: Line<'static>, width: u16) -> Line<'static> {
    let max_width = usize::from(width);
    if max_width == 0 {
        return Line::default();
    }

    let line_width: usize = line
        .spans
        .iter()
        .map(|span| UnicodeWidthStr::width(span.content.as_ref()))
        .sum();
    if line_width <= max_width {
        return line;
    }
    if max_width == 1 {
        return Line::from("…");
    }

    let mut spans = Vec::new();
    let mut used = 0usize;

    'outer: for span in line.spans {
        let mut content = String::new();
        for ch in span.content.chars() {
            let ch_width = UnicodeWidthChar::width(ch).unwrap_or(0);
            if used + ch_width > max_width - 1 {
                break 'outer;
            }
            content.push(ch);
            used += ch_width;
        }
        if !content.is_empty() {
            spans.push(Span::styled(content, span.style));
        }
    }

    trim_trailing_whitespace(&mut spans);
    spans.push(Span::raw("…"));
    Line::from(spans)
}

fn trim_trailing_whitespace(spans: &mut Vec<Span<'static>>) {
    while let Some(last) = spans.last_mut() {
        let trimmed = last
            .content
            .trim_end_matches(char::is_whitespace)
            .to_string();
        if trimmed.is_empty() {
            spans.pop();
            continue;
        }
        if trimmed.len() != last.content.len() {
            *last = Span::styled(trimmed, last.style);
        }
        break;
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use chrono::{Duration, Local};
    use tokio::sync::mpsc;

    use bakudo_core::{
        config::BakudoConfig,
        mission::{MissionStatus, Posture, WakeReason, WakeWhen},
        provider::ProviderRegistry,
        state::SandboxLedger,
    };
    use bakudo_daemon::session_controller::{
        ActiveWaveSummary, FleetCounts, MissionBanner, MissionWakeBanner, MissionWakeState,
    };

    use crate::app::{App, PendingRuntimeWorkKind, ShelfColor, ShelfEntry};

    use super::{fmt_elapsed_compact, render_status_line, render_top_line, shows_top_strip};

    #[test]
    fn fmt_elapsed_compact_formats_seconds_minutes_and_hours() {
        assert_eq!(fmt_elapsed_compact(0), "0s");
        assert_eq!(fmt_elapsed_compact(59), "59s");
        assert_eq!(fmt_elapsed_compact(60), "1m 00s");
        assert_eq!(fmt_elapsed_compact(61), "1m 01s");
        assert_eq!(fmt_elapsed_compact(59 * 60 + 59), "59m 59s");
        assert_eq!(fmt_elapsed_compact(3600), "1h 00m 00s");
        assert_eq!(fmt_elapsed_compact(3600 + 62), "1h 01m 02s");
    }

    #[test]
    fn render_status_line_includes_elapsed_and_inline_context() {
        let mut app = fresh_app();
        app.active_task_count = 2;
        app.shelf.push_back(running_entry(
            "bakudo-attempt-02bf30c1-newest",
            "Booting sandbox",
            Local::now() - Duration::seconds(7),
        ));
        app.shelf.push_back(running_entry(
            "bakudo-attempt-9f8e7d6c-oldest",
            "Older note",
            Local::now() - Duration::minutes(2) - Duration::seconds(3),
        ));

        let line = render_status_line(&app, 140).expect("status line");
        let rendered = line_to_string(&line);

        assert!(rendered.contains("• Running (2m 03s)"));
        assert!(rendered.contains("2 sandboxes active"));
        assert!(rendered.contains("[02bf30c1]"));
        assert!(rendered.contains("Booting sandbox"));
    }

    #[test]
    fn render_status_line_truncates_with_ellipsis() {
        let mut app = fresh_app();
        app.active_task_count = 1;
        app.shelf.push_back(running_entry(
            "bakudo-attempt-02bf30c1-abcd",
            "Booting sandbox for a much longer status note",
            Local::now() - Duration::seconds(7),
        ));

        let line = render_status_line(&app, 32).expect("status line");
        let rendered = line_to_string(&line);

        assert!(rendered.ends_with('…'), "rendered={rendered}");
        assert!(rendered.contains("Running"));
    }

    #[test]
    fn render_status_line_falls_back_to_zero_seconds_when_shelf_lags() {
        let mut app = fresh_app();
        app.active_task_count = 1;

        let line = render_status_line(&app, 140).expect("status line");
        let rendered = line_to_string(&line);

        assert_eq!(rendered, "• Running (0s)");
    }

    #[test]
    fn render_top_line_surfaces_deliberating_mission_work() {
        let mut app = fresh_app();
        app.mission_banner = Some(mission_banner(
            MissionStatus::Deliberating,
            0,
            0,
            0,
            "Refine the inline status row",
        ));

        let line = render_top_line(&app, 140).expect("top line");
        let rendered = line_to_string(&line);

        assert!(rendered.contains("• Working"));
        assert!(rendered.contains("wake running: manual resume"));
        assert!(rendered.contains("mission Refine the inline status row"));
    }

    #[test]
    fn render_top_line_surfaces_pending_runtime_work_before_banner_arrives() {
        let mut app = fresh_app();
        app.begin_pending_runtime_work(
            PendingRuntimeWorkKind::RoutingInput,
            "Explore how to surface background progress",
        );

        let line = render_top_line(&app, 140).expect("top line");
        let rendered = line_to_string(&line);

        assert!(rendered.contains("• Working (0s)"));
        assert!(rendered.contains("routing request"));
        assert!(rendered.contains("Explore how to surface background progress"));
    }

    #[test]
    fn render_top_line_surfaces_sleeping_mission_state() {
        let mut app = fresh_app();
        app.mission_banner = Some(mission_banner(
            MissionStatus::Sleeping,
            0,
            0,
            0,
            "Wait for the next host update",
        ));

        let line = render_top_line(&app, 140).expect("top line");
        let rendered = line_to_string(&line);

        assert!(rendered.contains("• Waiting"));
        assert!(rendered.contains("sleeping until next wake"));
    }

    #[test]
    fn render_top_line_surfaces_blocked_mission_state() {
        let mut app = fresh_app();
        let mut banner = mission_banner(MissionStatus::Sleeping, 0, 0, 0, "Wait for an answer");
        banner.pending_questions = 1;
        banner.wake = MissionWakeBanner {
            state: MissionWakeState::Idle,
            current_reason: None,
            queued_count: 0,
            next_wake_at: None,
            timeout_streak: None,
        };
        app.mission_banner = Some(banner);

        let line = render_top_line(&app, 140).expect("top line");
        let rendered = line_to_string(&line);

        assert!(rendered.contains("• Blocked"));
        assert!(rendered.contains("1 question pending"));
    }

    #[test]
    fn render_top_line_surfaces_wave_state() {
        let mut app = fresh_app();
        let mut banner =
            mission_banner(MissionStatus::Sleeping, 1, 2, 0, "Coordinate a worker wave");
        banner.active_wave = Some(ActiveWaveSummary {
            total: 3,
            running: 1,
            queued: 2,
            completed: 0,
            failed: 0,
            concurrency_limit: 2,
            wake_when: WakeWhen::FirstComplete,
            wake_sent: false,
        });
        banner.wake = MissionWakeBanner {
            state: MissionWakeState::Idle,
            current_reason: None,
            queued_count: 0,
            next_wake_at: None,
            timeout_streak: None,
        };
        app.mission_banner = Some(banner);

        let line = render_top_line(&app, 140).expect("top line");
        let rendered = line_to_string(&line);

        assert!(rendered.contains("wave 1 active, 2 queued, wake on first complete"));
    }

    #[test]
    fn shows_top_strip_hides_terminal_mission_states() {
        let mut app = fresh_app();
        app.mission_banner = Some(mission_banner(MissionStatus::Completed, 0, 0, 0, "Done"));
        assert!(!shows_top_strip(&app));
    }

    fn line_to_string(line: &ratatui::text::Line<'static>) -> String {
        line.spans
            .iter()
            .map(|span| span.content.as_ref())
            .collect::<String>()
    }

    fn fresh_app() -> App {
        let (cmd_tx, _cmd_rx) = mpsc::channel(4);
        let (_event_tx, event_rx) = mpsc::channel(4);
        App::new(
            Arc::new(BakudoConfig::default()),
            Arc::new(ProviderRegistry::with_defaults()),
            Arc::new(SandboxLedger::new()),
            cmd_tx,
            event_rx,
            None,
            true,
        )
    }

    fn running_entry(
        task_id: &str,
        last_note: &str,
        started_at: chrono::DateTime<Local>,
    ) -> ShelfEntry {
        ShelfEntry {
            task_id: task_id.to_string(),
            provider: "codex".to_string(),
            model: Some("gpt-5".to_string()),
            prompt_summary: "Test prompt".to_string(),
            last_note: last_note.to_string(),
            state_label: "running".to_string(),
            state_color: ShelfColor::Running,
            started_at,
            updated_at: started_at,
            pending_action: None,
        }
    }

    fn mission_banner(
        status: MissionStatus,
        active: usize,
        queued: usize,
        pending_user_messages: usize,
        goal: &str,
    ) -> MissionBanner {
        MissionBanner {
            mission_id: "mission-test".to_string(),
            goal: goal.to_string(),
            posture: Posture::Mission,
            status,
            wake: MissionWakeBanner {
                state: match status {
                    MissionStatus::Deliberating => MissionWakeState::Running,
                    MissionStatus::AwaitingDeliberator => MissionWakeState::Queued,
                    _ => MissionWakeState::Idle,
                },
                current_reason: match status {
                    MissionStatus::Deliberating => Some(WakeReason::ManualResume),
                    MissionStatus::AwaitingDeliberator => Some(WakeReason::ManualResume),
                    _ => None,
                },
                queued_count: usize::from(matches!(status, MissionStatus::AwaitingDeliberator)),
                next_wake_at: None,
                timeout_streak: None,
            },
            active_wave: None,
            wall_clock_remaining_secs: 900,
            abox_workers_remaining: 4,
            abox_workers_in_flight: active as u32,
            concurrent_max: 4,
            pending_user_messages,
            pending_questions: 0,
            pending_approvals: 0,
            latest_issue: None,
            latest_change: None,
            fleet: FleetCounts {
                active,
                queued,
                completed: 0,
                failed: 0,
            },
        }
    }
}
