use std::cmp::Reverse;
use std::path::{Path, PathBuf};

use bakudo_core::mission::{ExperimentId, MissionId, WakeEvent, WakeId};
use chrono::Utc;
use serde::Serialize;
use serde_json::json;
use tracing::warn;

const MAX_ATTEMPT_TRACES: usize = 128;
const MAX_WAKE_TRACES_PER_MISSION: usize = 64;

#[derive(Debug, Clone)]
pub struct TraceRecorder {
    root: PathBuf,
}

impl TraceRecorder {
    pub fn new(repo_data_dir: impl Into<PathBuf>) -> Self {
        Self {
            root: repo_data_dir.into().join("traces"),
        }
    }

    pub fn attempts_dir(&self) -> PathBuf {
        self.root.join("attempts")
    }

    pub fn attempt_dir(&self, task_id: &str) -> PathBuf {
        self.attempts_dir().join(task_id)
    }

    pub fn attempt_trace_bundle_path(&self, task_id: &str) -> PathBuf {
        self.attempt_dir(task_id).join("trace_bundle.md")
    }

    pub fn experiment_trace_bundle_path(&self, experiment_id: ExperimentId) -> PathBuf {
        self.attempt_trace_bundle_path(&experiment_id.to_string())
    }

    pub fn mission_wakes_dir(&self, mission_id: MissionId) -> PathBuf {
        self.root
            .join("missions")
            .join(mission_id.to_string())
            .join("wakes")
    }

    pub fn wake_dir(&self, mission_id: MissionId, wake_id: WakeId) -> PathBuf {
        self.mission_wakes_dir(mission_id).join(wake_id.to_string())
    }

    pub async fn record_wake_start<T: Serialize>(
        &self,
        mission_id: MissionId,
        wake: &WakeEvent,
        provider_snapshot: &T,
    ) -> PathBuf {
        let dir = self.wake_dir(mission_id, wake.id);
        self.best_effort_prune(
            &self.mission_wakes_dir(mission_id),
            MAX_WAKE_TRACES_PER_MISSION,
        )
        .await;
        self.best_effort_write_json(
            &dir.join("wake.json"),
            &json!({
                "captured_at": Utc::now(),
                "wake": wake,
            }),
        )
        .await;
        self.best_effort_write_json(&dir.join("provider.json"), provider_snapshot)
            .await;
        dir
    }

    pub async fn record_wake_finish<T: Serialize>(
        &self,
        mission_id: MissionId,
        wake_id: WakeId,
        outcome: &T,
    ) {
        let dir = self.wake_dir(mission_id, wake_id);
        self.best_effort_write_json(&dir.join("outcome.json"), outcome)
            .await;
    }

    pub async fn append_wake_stdout(&self, mission_id: MissionId, wake_id: WakeId, line: &str) {
        self.best_effort_append_text(
            &self.wake_dir(mission_id, wake_id).join("stdout.log"),
            &format!("{line}\n"),
        )
        .await;
    }

    pub async fn append_wake_stderr(&self, mission_id: MissionId, wake_id: WakeId, line: &str) {
        self.best_effort_append_text(
            &self.wake_dir(mission_id, wake_id).join("stderr.log"),
            &format!("{line}\n"),
        )
        .await;
    }

    pub async fn append_wake_tool_call<T: Serialize>(
        &self,
        mission_id: MissionId,
        wake_id: WakeId,
        record: &T,
    ) {
        let value = match serde_json::to_string(record) {
            Ok(value) => format!("{value}\n"),
            Err(err) => {
                warn!("failed to serialize wake tool call trace: {err}");
                return;
            }
        };
        self.best_effort_append_text(
            &self.wake_dir(mission_id, wake_id).join("tool_calls.ndjson"),
            &value,
        )
        .await;
    }

    pub async fn record_attempt_start<T: Serialize>(&self, task_id: &str, snapshot: &T) -> PathBuf {
        let dir = self.attempt_dir(task_id);
        self.best_effort_prune(&self.attempts_dir(), MAX_ATTEMPT_TRACES)
            .await;
        self.best_effort_write_json(&dir.join("start.json"), snapshot)
            .await;
        dir
    }

    pub async fn append_attempt_stream(&self, task_id: &str, stream: &str, line: &str) {
        self.best_effort_append_text(
            &self.attempt_dir(task_id).join(format!("{stream}.log")),
            &format!("{line}\n"),
        )
        .await;
    }

    pub async fn record_attempt_finish<T: Serialize>(
        &self,
        task_id: &str,
        result: &T,
        trace_bundle_markdown: &str,
    ) -> PathBuf {
        let dir = self.attempt_dir(task_id);
        self.best_effort_write_json(&dir.join("result.json"), result)
            .await;
        let bundle_path = dir.join("trace_bundle.md");
        self.best_effort_write_text(&bundle_path, trace_bundle_markdown)
            .await;
        bundle_path
    }

    pub async fn append_attempt_outcome(&self, task_id: &str, markdown: &str) {
        self.best_effort_append_text(&self.attempt_dir(task_id).join("trace_bundle.md"), markdown)
            .await;
    }

    async fn best_effort_write_json<T: Serialize>(&self, path: &Path, value: &T) {
        match serde_json::to_vec_pretty(value) {
            Ok(bytes) => {
                if let Err(err) = write_bytes(path, &bytes).await {
                    warn!("trace write failed for '{}': {err}", path.display());
                }
            }
            Err(err) => warn!("trace serialization failed for '{}': {err}", path.display()),
        }
    }

    async fn best_effort_write_text(&self, path: &Path, contents: &str) {
        if let Err(err) = write_bytes(path, contents.as_bytes()).await {
            warn!("trace write failed for '{}': {err}", path.display());
        }
    }

    async fn best_effort_append_text(&self, path: &Path, contents: &str) {
        if let Err(err) = append_bytes(path, contents.as_bytes()).await {
            warn!("trace append failed for '{}': {err}", path.display());
        }
    }

    async fn best_effort_prune(&self, dir: &Path, keep: usize) {
        if let Err(err) = prune_directory(dir, keep).await {
            warn!(
                "trace retention prune failed for '{}': {err}",
                dir.display()
            );
        }
    }
}

async fn write_bytes(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    tokio::fs::write(path, bytes).await
}

async fn append_bytes(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let mut file = tokio::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .await?;
    tokio::io::AsyncWriteExt::write_all(&mut file, bytes).await?;
    tokio::io::AsyncWriteExt::flush(&mut file).await
}

async fn prune_directory(dir: &Path, keep: usize) -> std::io::Result<()> {
    if keep == 0 || !dir.exists() {
        return Ok(());
    }
    let mut entries = tokio::fs::read_dir(dir).await?;
    let mut children = Vec::new();
    while let Some(entry) = entries.next_entry().await? {
        let metadata = entry.metadata().await?;
        let modified = metadata.modified()?;
        children.push((modified, entry.path(), metadata.is_dir()));
    }
    children.sort_by_key(|(modified, path, _)| (Reverse(*modified), path.clone()));
    for (_, path, is_dir) in children.into_iter().skip(keep) {
        if is_dir {
            let _ = tokio::fs::remove_dir_all(path).await;
        } else {
            let _ = tokio::fs::remove_file(path).await;
        }
    }
    Ok(())
}
