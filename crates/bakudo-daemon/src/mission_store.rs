use std::path::{Path, PathBuf};

use anyhow::{anyhow, Context, Result};
use bakudo_core::mission::{
    Experiment, ExperimentId, ExperimentStatus, LedgerEntry, LedgerKind, Mission, MissionId,
    MissionState, MissionStatus, Posture, UserMessage, WakeEvent, WakeId, WakeReason, WakeWhen,
};
use chrono::{DateTime, Utc};
use rusqlite::{params, Connection, OptionalExtension, Row};

#[derive(Debug, Clone)]
pub struct MissionStore {
    db_path: PathBuf,
}

#[derive(Debug, Clone)]
pub struct QueuedUserMessage {
    pub id: i64,
    pub message: UserMessage,
}

#[derive(Debug, Clone)]
pub struct PendingQuestionRecord {
    pub request_id: String,
    pub mission_id: MissionId,
    pub question: String,
    pub choices: Vec<String>,
    pub asked_at: DateTime<Utc>,
    pub answer: Option<String>,
    pub answered_at: Option<DateTime<Utc>>,
    pub resolved_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone)]
pub struct StoredWakeEvent {
    pub wake: WakeEvent,
    pub processed_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone)]
pub struct ActiveWaveRecord {
    pub mission_id: MissionId,
    pub experiment_ids: Vec<ExperimentId>,
    pub concurrency_limit: u32,
    pub wake_when: WakeWhen,
    pub wake_sent: bool,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct ActiveWavePayload {
    experiment_ids: Vec<ExperimentId>,
    concurrency_limit: u32,
}

impl MissionStore {
    pub fn open(path: impl Into<PathBuf>) -> Result<Self> {
        let db_path = path.into();
        init_schema(&db_path)?;
        Ok(Self { db_path })
    }

    pub fn db_path(&self) -> &Path {
        &self.db_path
    }

    pub fn repo_data_dir(&self) -> &Path {
        self.db_path
            .parent()
            .expect("mission store db path should live under repo data dir")
    }

    pub fn missions_dir(&self) -> PathBuf {
        self.repo_data_dir().join("missions")
    }

    pub fn mission_dir(&self, mission_id: MissionId) -> PathBuf {
        self.missions_dir().join(mission_id.to_string())
    }

    pub fn mission_plan_path(&self, mission_id: MissionId) -> PathBuf {
        self.mission_dir(mission_id).join("mission_plan.md")
    }

    pub async fn seed_mission_plan(&self, mission_id: MissionId, markdown: &str) -> Result<()> {
        self.write_mission_plan(mission_id, markdown)
            .await
            .map(|_| ())
    }

    pub async fn read_mission_plan(&self, mission_id: MissionId) -> Result<(PathBuf, String)> {
        let path = self.mission_plan_path(mission_id);
        let markdown = tokio::fs::read_to_string(&path)
            .await
            .with_context(|| format!("failed to read '{}'", path.display()))?;
        Ok((path, markdown))
    }

    pub async fn write_mission_plan(
        &self,
        mission_id: MissionId,
        markdown: &str,
    ) -> Result<PathBuf> {
        let path = self.mission_plan_path(mission_id);
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .with_context(|| format!("failed to create '{}'", parent.display()))?;
        }
        tokio::fs::write(&path, markdown)
            .await
            .with_context(|| format!("failed to write '{}'", path.display()))?;
        Ok(path)
    }

    pub async fn mission_plan_updated_at(
        &self,
        mission_id: MissionId,
    ) -> Result<Option<DateTime<Utc>>> {
        let path = self.mission_plan_path(mission_id);
        if !path.exists() {
            return Ok(None);
        }
        let metadata = tokio::fs::metadata(&path)
            .await
            .with_context(|| format!("failed to stat '{}'", path.display()))?;
        let modified = metadata
            .modified()
            .with_context(|| format!("failed to read modified time for '{}'", path.display()))?;
        Ok(Some(DateTime::<Utc>::from(modified)))
    }

    pub async fn upsert_mission(&self, mission: &Mission) -> Result<()> {
        let db_path = self.db_path.clone();
        let mission = mission.clone();
        tokio::task::spawn_blocking(move || {
            let conn = open_conn(&db_path)?;
            conn.execute(
                "INSERT INTO missions (
                    id, goal, posture, provider_name, abox_profile, wallet_json, status, created_at, completed_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                ON CONFLICT(id) DO UPDATE SET
                    goal = excluded.goal,
                    posture = excluded.posture,
                    provider_name = excluded.provider_name,
                    abox_profile = excluded.abox_profile,
                    wallet_json = excluded.wallet_json,
                    status = excluded.status,
                    created_at = excluded.created_at,
                    completed_at = excluded.completed_at",
                params![
                    mission.id.to_string(),
                    mission.goal,
                    posture_str(mission.posture),
                    mission.provider_name,
                    mission.abox_profile,
                    serde_json::to_string(&mission.wallet)?,
                    mission_status_str(mission.status),
                    mission.created_at.to_rfc3339(),
                    mission.completed_at.map(|at| at.to_rfc3339()),
                ],
            )
            .context("failed to upsert mission")?;
            Ok(())
        })
        .await
        .context("mission upsert join failed")?
    }

    pub async fn mission(&self, mission_id: MissionId) -> Result<Option<Mission>> {
        let db_path = self.db_path.clone();
        tokio::task::spawn_blocking(move || {
            let conn = open_conn(&db_path)?;
            let mut stmt = conn.prepare(
                "SELECT id, goal, posture, provider_name, abox_profile, wallet_json, status, created_at, completed_at
                 FROM missions WHERE id = ?1",
            )?;
            stmt.query_row(params![mission_id.to_string()], mission_from_row)
                .optional()
                .context("failed to load mission")
        })
        .await
        .context("mission load join failed")?
    }

    pub async fn list_missions(&self) -> Result<Vec<Mission>> {
        let db_path = self.db_path.clone();
        tokio::task::spawn_blocking(move || {
            let conn = open_conn(&db_path)?;
            let mut stmt = conn.prepare(
                "SELECT id, goal, posture, provider_name, abox_profile, wallet_json, status, created_at, completed_at
                 FROM missions ORDER BY created_at DESC",
            )?;
            let rows = stmt.query_map([], mission_from_row)?;
            let missions: rusqlite::Result<Vec<_>> = rows.collect();
            missions.context("failed to list missions")
        })
        .await
        .context("mission list join failed")?
    }

    pub async fn list_active_missions(&self) -> Result<Vec<Mission>> {
        let db_path = self.db_path.clone();
        tokio::task::spawn_blocking(move || {
            let conn = open_conn(&db_path)?;
            let mut stmt = conn.prepare(
                "SELECT id, goal, posture, provider_name, abox_profile, wallet_json, status, created_at, completed_at
                 FROM missions
                 WHERE status IN ('pending', 'awaiting_deliberator', 'deliberating', 'sleeping')
                 ORDER BY created_at DESC",
            )?;
            let rows = stmt.query_map([], mission_from_row)?;
            let missions: rusqlite::Result<Vec<_>> = rows.collect();
            missions.context("failed to list active missions")
        })
        .await
        .context("active mission list join failed")?
    }

    pub async fn save_mission_state(
        &self,
        mission_id: MissionId,
        mission_state: &MissionState,
    ) -> Result<()> {
        let db_path = self.db_path.clone();
        let mission_state = mission_state.clone();
        tokio::task::spawn_blocking(move || {
            let conn = open_conn(&db_path)?;
            conn.execute(
                "INSERT INTO mission_states (mission_id, state_json, updated_at)
                 VALUES (?1, ?2, ?3)
                 ON CONFLICT(mission_id) DO UPDATE SET
                    state_json = excluded.state_json,
                    updated_at = excluded.updated_at",
                params![
                    mission_id.to_string(),
                    serde_json::to_string(&mission_state)?,
                    Utc::now().to_rfc3339(),
                ],
            )
            .context("failed to save mission state")?;
            Ok(())
        })
        .await
        .context("mission state save join failed")?
    }

    pub async fn mission_state(&self, mission_id: MissionId) -> Result<MissionState> {
        let db_path = self.db_path.clone();
        tokio::task::spawn_blocking(move || {
            let conn = open_conn(&db_path)?;
            let json: Option<String> = conn
                .query_row(
                    "SELECT state_json FROM mission_states WHERE mission_id = ?1",
                    params![mission_id.to_string()],
                    |row| row.get(0),
                )
                .optional()
                .context("failed to load mission state")?;
            match json {
                Some(json) => serde_json::from_str(&json).context("invalid mission state json"),
                None => Ok(MissionState::default_layout()),
            }
        })
        .await
        .context("mission state load join failed")?
    }

    pub async fn append_ledger(&self, entry: &LedgerEntry) -> Result<()> {
        let db_path = self.db_path.clone();
        let entry = entry.clone();
        tokio::task::spawn_blocking(move || {
            let conn = open_conn(&db_path)?;
            conn.execute(
                "INSERT INTO ledger (mission_id, experiment_id, kind, summary, at)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    entry.mission_id.to_string(),
                    entry.experiment_id.map(|id| id.to_string()),
                    ledger_kind_str(entry.kind),
                    entry.summary,
                    entry.at.to_rfc3339(),
                ],
            )
            .context("failed to append ledger entry")?;
            Ok(())
        })
        .await
        .context("ledger append join failed")?
    }

    pub async fn recent_ledger(
        &self,
        mission_id: MissionId,
        limit: usize,
    ) -> Result<Vec<LedgerEntry>> {
        let db_path = self.db_path.clone();
        tokio::task::spawn_blocking(move || {
            let conn = open_conn(&db_path)?;
            let mut stmt = conn.prepare(
                "SELECT mission_id, experiment_id, kind, summary, at
                 FROM ledger
                 WHERE mission_id = ?1
                 ORDER BY at DESC
                 LIMIT ?2",
            )?;
            let rows = stmt.query_map(params![mission_id.to_string(), limit as i64], |row| {
                Ok(LedgerEntry {
                    mission_id: parse_mission_id(&row.get::<_, String>(0)?)
                        .map_err(to_sql_error)?,
                    experiment_id: row
                        .get::<_, Option<String>>(1)?
                        .map(|value| parse_experiment_id(&value))
                        .transpose()
                        .map_err(to_sql_error)?,
                    kind: parse_ledger_kind(&row.get::<_, String>(2)?).map_err(to_sql_error)?,
                    summary: row.get(3)?,
                    at: parse_datetime(&row.get::<_, String>(4)?).map_err(to_sql_error)?,
                })
            })?;
            let mut entries: Vec<_> = rows.collect::<rusqlite::Result<Vec<_>>>()?;
            entries.reverse();
            Ok(entries)
        })
        .await
        .context("recent ledger join failed")?
    }

    pub async fn enqueue_user_message(
        &self,
        mission_id: MissionId,
        message: &UserMessage,
    ) -> Result<()> {
        let db_path = self.db_path.clone();
        let message = message.clone();
        tokio::task::spawn_blocking(move || {
            let conn = open_conn(&db_path)?;
            conn.execute(
                "INSERT INTO user_messages (mission_id, text, urgent, at, delivered_at)
                 VALUES (?1, ?2, ?3, ?4, NULL)",
                params![
                    mission_id.to_string(),
                    message.text,
                    if message.urgent { 1_i64 } else { 0_i64 },
                    message.at.to_rfc3339(),
                ],
            )
            .context("failed to enqueue user message")?;
            Ok(())
        })
        .await
        .context("user message enqueue join failed")?
    }

    pub async fn undelivered_user_messages(
        &self,
        mission_id: MissionId,
    ) -> Result<Vec<QueuedUserMessage>> {
        let db_path = self.db_path.clone();
        tokio::task::spawn_blocking(move || {
            let conn = open_conn(&db_path)?;
            let mut stmt = conn.prepare(
                "SELECT id, text, urgent, at
                 FROM user_messages
                 WHERE mission_id = ?1 AND delivered_at IS NULL
                 ORDER BY at ASC, id ASC",
            )?;
            let rows = stmt.query_map(params![mission_id.to_string()], |row| {
                Ok(QueuedUserMessage {
                    id: row.get(0)?,
                    message: UserMessage {
                        text: row.get(1)?,
                        urgent: row.get::<_, i64>(2)? != 0,
                        at: parse_datetime(&row.get::<_, String>(3)?).map_err(to_sql_error)?,
                    },
                })
            })?;
            rows.collect::<rusqlite::Result<Vec<_>>>()
                .context("failed to load user messages")
        })
        .await
        .context("user message load join failed")?
    }

    pub async fn mark_user_messages_delivered(&self, ids: &[i64]) -> Result<()> {
        if ids.is_empty() {
            return Ok(());
        }
        let db_path = self.db_path.clone();
        let ids = ids.to_vec();
        tokio::task::spawn_blocking(move || {
            let conn = open_conn(&db_path)?;
            let now = Utc::now().to_rfc3339();
            let tx = conn.unchecked_transaction()?;
            for id in ids {
                tx.execute(
                    "UPDATE user_messages SET delivered_at = ?1 WHERE id = ?2",
                    params![now, id],
                )?;
            }
            tx.commit()
                .context("failed to mark user messages delivered")
        })
        .await
        .context("user message delivery join failed")?
    }

    pub async fn insert_pending_question(&self, question: &PendingQuestionRecord) -> Result<()> {
        let db_path = self.db_path.clone();
        let question = question.clone();
        tokio::task::spawn_blocking(move || {
            let conn = open_conn(&db_path)?;
            conn.execute(
                "INSERT INTO pending_questions (
                    request_id, mission_id, question, choices_json, asked_at, answer_text, answered_at, resolved_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                 ON CONFLICT(request_id) DO UPDATE SET
                    mission_id = excluded.mission_id,
                    question = excluded.question,
                    choices_json = excluded.choices_json,
                    asked_at = excluded.asked_at,
                    answer_text = excluded.answer_text,
                    answered_at = excluded.answered_at,
                    resolved_at = excluded.resolved_at",
                params![
                    question.request_id,
                    question.mission_id.to_string(),
                    question.question,
                    serde_json::to_string(&question.choices)?,
                    question.asked_at.to_rfc3339(),
                    question.answer,
                    question.answered_at.map(|at| at.to_rfc3339()),
                    question.resolved_at.map(|at| at.to_rfc3339()),
                ],
            )
            .context("failed to insert pending question")?;
            Ok(())
        })
        .await
        .context("pending question insert join failed")?
    }

    pub async fn pending_question(
        &self,
        request_id: &str,
    ) -> Result<Option<PendingQuestionRecord>> {
        let db_path = self.db_path.clone();
        let request_id = request_id.to_string();
        tokio::task::spawn_blocking(move || {
            let conn = open_conn(&db_path)?;
            let mut stmt = conn.prepare(
                "SELECT request_id, mission_id, question, choices_json, asked_at, answer_text, answered_at, resolved_at
                 FROM pending_questions
                 WHERE request_id = ?1",
            )?;
            stmt.query_row(params![request_id], pending_question_from_row)
                .optional()
                .context("failed to load pending question")
        })
        .await
        .context("pending question load join failed")?
    }

    pub async fn open_pending_questions(
        &self,
        mission_id: MissionId,
    ) -> Result<Vec<PendingQuestionRecord>> {
        let db_path = self.db_path.clone();
        tokio::task::spawn_blocking(move || {
            let conn = open_conn(&db_path)?;
            let mut stmt = conn.prepare(
                "SELECT request_id, mission_id, question, choices_json, asked_at, answer_text, answered_at, resolved_at
                 FROM pending_questions
                 WHERE mission_id = ?1 AND answered_at IS NULL AND resolved_at IS NULL
                 ORDER BY asked_at ASC, request_id ASC",
            )?;
            let rows = stmt.query_map(params![mission_id.to_string()], pending_question_from_row)?;
            rows.collect::<rusqlite::Result<Vec<_>>>()
                .context("failed to load open pending questions")
        })
        .await
        .context("open pending questions join failed")?
    }

    pub async fn recoverable_pending_questions(
        &self,
        mission_id: MissionId,
    ) -> Result<Vec<PendingQuestionRecord>> {
        let db_path = self.db_path.clone();
        tokio::task::spawn_blocking(move || {
            let conn = open_conn(&db_path)?;
            let mut stmt = conn.prepare(
                "SELECT request_id, mission_id, question, choices_json, asked_at, answer_text, answered_at, resolved_at
                 FROM pending_questions
                 WHERE mission_id = ?1 AND resolved_at IS NULL
                 ORDER BY asked_at ASC, request_id ASC",
            )?;
            let rows = stmt.query_map(params![mission_id.to_string()], pending_question_from_row)?;
            rows.collect::<rusqlite::Result<Vec<_>>>()
                .context("failed to load recoverable pending questions")
        })
        .await
        .context("recoverable pending questions join failed")?
    }

    pub async fn save_pending_question_answer(
        &self,
        request_id: &str,
        answer: &str,
        answered_at: DateTime<Utc>,
    ) -> Result<()> {
        let db_path = self.db_path.clone();
        let request_id = request_id.to_string();
        let answer = answer.to_string();
        tokio::task::spawn_blocking(move || {
            let conn = open_conn(&db_path)?;
            let affected = conn.execute(
                "UPDATE pending_questions
                 SET answer_text = ?1, answered_at = ?2
                 WHERE request_id = ?3 AND answered_at IS NULL AND resolved_at IS NULL",
                params![answer, answered_at.to_rfc3339(), request_id],
            )?;
            if affected == 1 {
                return Ok(());
            }

            let mut stmt = conn.prepare(
                "SELECT request_id, mission_id, question, choices_json, asked_at, answer_text, answered_at, resolved_at
                 FROM pending_questions
                 WHERE request_id = ?1",
            )?;
            let question = stmt
                .query_row(params![request_id], pending_question_from_row)
                .optional()
                .context("failed to inspect pending question answer state")?;
            match question {
                Some(question) if question.resolved_at.is_some() => {
                    Err(anyhow!("question request '{}' was already resolved", question.request_id))
                }
                Some(question) if question.answered_at.is_some() => {
                    Err(anyhow!("question request '{}' was already answered", question.request_id))
                }
                Some(question) => Err(anyhow!(
                    "question request '{}' could not be answered",
                    question.request_id
                )),
                None => Err(anyhow!("unknown question request '{}'", request_id)),
            }
        })
        .await
        .context("pending question answer join failed")?
    }

    pub async fn resolve_pending_question(
        &self,
        request_id: &str,
        resolved_at: DateTime<Utc>,
    ) -> Result<()> {
        let db_path = self.db_path.clone();
        let request_id = request_id.to_string();
        tokio::task::spawn_blocking(move || {
            let conn = open_conn(&db_path)?;
            let affected = conn.execute(
                "UPDATE pending_questions
                 SET resolved_at = COALESCE(resolved_at, ?1)
                 WHERE request_id = ?2",
                params![resolved_at.to_rfc3339(), request_id],
            )?;
            if affected == 0 {
                Err(anyhow!("unknown question request '{}'", request_id))
            } else {
                Ok(())
            }
        })
        .await
        .context("pending question resolve join failed")?
    }

    pub async fn promote_answered_pending_question_to_user_message(
        &self,
        request_id: &str,
        urgent: bool,
    ) -> Result<Option<PendingQuestionRecord>> {
        let db_path = self.db_path.clone();
        let request_id = request_id.to_string();
        tokio::task::spawn_blocking(move || {
            let conn = open_conn(&db_path)?;
            let tx = conn.unchecked_transaction()?;
            let question = {
                let mut stmt = tx.prepare(
                    "SELECT request_id, mission_id, question, choices_json, asked_at, answer_text, answered_at, resolved_at
                     FROM pending_questions
                     WHERE request_id = ?1",
                )?;
                stmt.query_row(params![request_id], pending_question_from_row)
                    .optional()
                    .context("failed to inspect answered pending question")?
            };
            let Some(question) = question else {
                return Ok(None);
            };
            if question.resolved_at.is_some() || question.answer.is_none() {
                return Ok(None);
            }
            let answer = question
                .answer
                .clone()
                .ok_or_else(|| anyhow!("pending question '{}' had no answer", question.request_id))?;
            let message_at = question.answered_at.unwrap_or(question.asked_at);
            tx.execute(
                "INSERT INTO user_messages (mission_id, text, urgent, at, delivered_at)
                 VALUES (?1, ?2, ?3, ?4, NULL)",
                params![
                    question.mission_id.to_string(),
                    answer,
                    if urgent { 1_i64 } else { 0_i64 },
                    message_at.to_rfc3339(),
                ],
            )
            .context("failed to promote answered question into user_messages")?;
            tx.execute(
                "UPDATE pending_questions
                 SET resolved_at = ?1
                 WHERE request_id = ?2 AND resolved_at IS NULL",
                params![Utc::now().to_rfc3339(), question.request_id],
            )
            .context("failed to resolve answered pending question")?;
            tx.commit()
                .context("failed to commit answered pending question promotion")?;
            Ok(Some(question))
        })
        .await
        .context("pending question promotion join failed")?
    }

    pub async fn latest_tool_call_error(&self, mission_id: MissionId) -> Result<Option<String>> {
        let db_path = self.db_path.clone();
        tokio::task::spawn_blocking(move || {
            let conn = open_conn(&db_path)?;
            conn.query_row(
                "SELECT summary
                 FROM ledger
                 WHERE mission_id = ?1 AND summary LIKE 'tool_call_error:%'
                 ORDER BY at DESC, id DESC
                 LIMIT 1",
                params![mission_id.to_string()],
                |row| row.get(0),
            )
            .optional()
            .context("failed to load latest tool call error")
        })
        .await
        .context("latest tool call error join failed")?
    }

    pub async fn insert_wake(&self, wake: &WakeEvent) -> Result<()> {
        let db_path = self.db_path.clone();
        let wake = wake.clone();
        tokio::task::spawn_blocking(move || {
            let conn = open_conn(&db_path)?;
            conn.execute(
                "INSERT INTO wake_events (id, mission_id, reason, payload_json, created_at, processed_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, NULL)
                 ON CONFLICT(id) DO UPDATE SET
                    mission_id = excluded.mission_id,
                    reason = excluded.reason,
                    payload_json = excluded.payload_json,
                    created_at = excluded.created_at",
                params![
                    wake.id.to_string(),
                    wake.mission_id.to_string(),
                    wake_reason_str(wake.reason),
                    serde_json::to_string(&wake)?,
                    wake.created_at.to_rfc3339(),
                ],
            )
            .context("failed to insert wake")?;
            Ok(())
        })
        .await
        .context("wake insert join failed")?
    }

    pub async fn mark_wake_processed(&self, wake_id: WakeId) -> Result<()> {
        let db_path = self.db_path.clone();
        tokio::task::spawn_blocking(move || {
            let conn = open_conn(&db_path)?;
            conn.execute(
                "UPDATE wake_events SET processed_at = ?1 WHERE id = ?2",
                params![Utc::now().to_rfc3339(), wake_id.to_string()],
            )
            .context("failed to mark wake processed")?;
            Ok(())
        })
        .await
        .context("wake processed join failed")?
    }

    pub async fn unprocessed_wakes(
        &self,
        mission_id: Option<MissionId>,
    ) -> Result<Vec<StoredWakeEvent>> {
        let db_path = self.db_path.clone();
        tokio::task::spawn_blocking(move || {
            let conn = open_conn(&db_path)?;
            let sql = if mission_id.is_some() {
                "SELECT payload_json, processed_at
                 FROM wake_events
                 WHERE processed_at IS NULL AND mission_id = ?1
                 ORDER BY created_at ASC"
            } else {
                "SELECT payload_json, processed_at
                 FROM wake_events
                 WHERE processed_at IS NULL
                 ORDER BY created_at ASC"
            };
            let mut stmt = conn.prepare(sql)?;
            let mut rows = if let Some(mission_id) = mission_id {
                stmt.query(params![mission_id.to_string()])?
            } else {
                stmt.query([])?
            };
            let mut wakes = Vec::new();
            while let Some(row) = rows.next()? {
                let wake_json: String = row.get(0)?;
                let processed_at = row
                    .get::<_, Option<String>>(1)?
                    .map(|value| parse_datetime(&value))
                    .transpose()?;
                let wake: WakeEvent =
                    serde_json::from_str(&wake_json).context("invalid wake json in store")?;
                wakes.push(StoredWakeEvent { wake, processed_at });
            }
            Ok(wakes)
        })
        .await
        .context("wake load join failed")?
    }

    pub async fn save_active_wave(&self, wave: &ActiveWaveRecord) -> Result<()> {
        let db_path = self.db_path.clone();
        let wave = wave.clone();
        tokio::task::spawn_blocking(move || {
            let conn = open_conn(&db_path)?;
            conn.execute(
                "INSERT INTO active_waves (mission_id, experiment_ids_json, wake_when, wake_sent, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(mission_id) DO UPDATE SET
                    experiment_ids_json = excluded.experiment_ids_json,
                    wake_when = excluded.wake_when,
                    wake_sent = excluded.wake_sent,
                    updated_at = excluded.updated_at",
                params![
                    wave.mission_id.to_string(),
                    serde_json::to_string(&ActiveWavePayload {
                        experiment_ids: wave.experiment_ids.clone(),
                        concurrency_limit: wave.concurrency_limit,
                    })?,
                    wake_when_str(wave.wake_when),
                    if wave.wake_sent { 1 } else { 0 },
                    wave.updated_at.to_rfc3339(),
                ],
            )
            .context("failed to save active wave")?;
            Ok(())
        })
        .await
        .context("active wave save join failed")?
    }

    pub async fn active_wave(&self, mission_id: MissionId) -> Result<Option<ActiveWaveRecord>> {
        let db_path = self.db_path.clone();
        tokio::task::spawn_blocking(move || {
            let conn = open_conn(&db_path)?;
            let mut stmt = conn.prepare(
                "SELECT mission_id, experiment_ids_json, wake_when, wake_sent, updated_at
                 FROM active_waves
                 WHERE mission_id = ?1",
            )?;
            stmt.query_row(params![mission_id.to_string()], active_wave_from_row)
                .optional()
                .context("failed to load active wave")
        })
        .await
        .context("active wave load join failed")?
    }

    pub async fn clear_active_wave(&self, mission_id: MissionId) -> Result<()> {
        let db_path = self.db_path.clone();
        tokio::task::spawn_blocking(move || {
            let conn = open_conn(&db_path)?;
            conn.execute(
                "DELETE FROM active_waves WHERE mission_id = ?1",
                params![mission_id.to_string()],
            )
            .context("failed to clear active wave")?;
            Ok(())
        })
        .await
        .context("active wave clear join failed")?
    }

    pub async fn upsert_experiment(&self, experiment: &Experiment) -> Result<()> {
        let db_path = self.db_path.clone();
        let experiment = experiment.clone();
        tokio::task::spawn_blocking(move || {
            let conn = open_conn(&db_path)?;
            conn.execute(
                "INSERT INTO experiments (
                    id, mission_id, label, hypothesis, spec_json, status, abox_pid, started_at, finished_at, summary_json
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, ?7, ?8, ?9)
                 ON CONFLICT(id) DO UPDATE SET
                    mission_id = excluded.mission_id,
                    label = excluded.label,
                    hypothesis = excluded.hypothesis,
                    spec_json = excluded.spec_json,
                    status = excluded.status,
                    started_at = excluded.started_at,
                    finished_at = excluded.finished_at,
                    summary_json = excluded.summary_json",
                params![
                    experiment.id.to_string(),
                    experiment.mission_id.to_string(),
                    experiment.label,
                    experiment.spec.hypothesis.clone(),
                    serde_json::to_string(&experiment.spec)?,
                    experiment_status_str(experiment.status),
                    experiment.started_at.map(|at| at.to_rfc3339()),
                    experiment.finished_at.map(|at| at.to_rfc3339()),
                    experiment
                        .summary
                        .as_ref()
                        .map(serde_json::to_string)
                        .transpose()?,
                ],
            )
            .context("failed to upsert experiment")?;
            Ok(())
        })
        .await
        .context("experiment upsert join failed")?
    }

    pub async fn experiments_for_mission(&self, mission_id: MissionId) -> Result<Vec<Experiment>> {
        let db_path = self.db_path.clone();
        tokio::task::spawn_blocking(move || {
            let conn = open_conn(&db_path)?;
            let mut stmt = conn.prepare(
                "SELECT id, mission_id, label, spec_json, status, started_at, finished_at, summary_json
                 FROM experiments
                 WHERE mission_id = ?1
                 ORDER BY label ASC, id ASC",
            )?;
            let rows = stmt.query_map(params![mission_id.to_string()], experiment_from_row)?;
            rows.collect::<rusqlite::Result<Vec<_>>>()
                .context("failed to load experiments")
        })
        .await
        .context("experiment load join failed")?
    }

    pub async fn running_experiments(&self, mission_id: MissionId) -> Result<Vec<Experiment>> {
        let db_path = self.db_path.clone();
        tokio::task::spawn_blocking(move || {
            let conn = open_conn(&db_path)?;
            let mut stmt = conn.prepare(
                "SELECT id, mission_id, label, spec_json, status, started_at, finished_at, summary_json
                 FROM experiments
                 WHERE mission_id = ?1 AND status = 'running'
                 ORDER BY started_at ASC, id ASC",
            )?;
            let rows = stmt.query_map(params![mission_id.to_string()], experiment_from_row)?;
            rows.collect::<rusqlite::Result<Vec<_>>>()
                .context("failed to load running experiments")
        })
        .await
        .context("running experiment load join failed")?
    }
}

fn init_schema(path: &Path) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("failed to create '{}'", parent.display()))?;
    }
    let conn = Connection::open(path)
        .with_context(|| format!("failed to open mission store '{}'", path.display()))?;
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         CREATE TABLE IF NOT EXISTS missions (
           id TEXT PRIMARY KEY,
           goal TEXT NOT NULL,
           posture TEXT NOT NULL,
           provider_name TEXT NOT NULL,
           abox_profile TEXT NOT NULL,
           wallet_json TEXT NOT NULL,
           status TEXT NOT NULL,
           created_at TEXT NOT NULL,
           completed_at TEXT
         );
         CREATE TABLE IF NOT EXISTS experiments (
           id TEXT PRIMARY KEY,
           mission_id TEXT NOT NULL,
           label TEXT NOT NULL,
           hypothesis TEXT NOT NULL,
           spec_json TEXT NOT NULL,
           status TEXT NOT NULL,
           abox_pid INTEGER,
           started_at TEXT,
           finished_at TEXT,
           summary_json TEXT
         );
         CREATE INDEX IF NOT EXISTS experiments_mission ON experiments(mission_id);
         CREATE TABLE IF NOT EXISTS wake_events (
           id TEXT PRIMARY KEY,
           mission_id TEXT NOT NULL,
           reason TEXT NOT NULL,
           payload_json TEXT NOT NULL,
           created_at TEXT NOT NULL,
           processed_at TEXT
         );
         CREATE INDEX IF NOT EXISTS wake_events_mission ON wake_events(mission_id, created_at);
         CREATE TABLE IF NOT EXISTS active_waves (
           mission_id TEXT PRIMARY KEY,
           experiment_ids_json TEXT NOT NULL,
           wake_when TEXT NOT NULL,
           wake_sent INTEGER NOT NULL DEFAULT 0,
           updated_at TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS mission_states (
           mission_id TEXT PRIMARY KEY,
           state_json TEXT NOT NULL,
           updated_at TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS ledger (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           mission_id TEXT NOT NULL,
           experiment_id TEXT,
           kind TEXT NOT NULL,
           summary TEXT NOT NULL,
           at TEXT NOT NULL
         );
         CREATE INDEX IF NOT EXISTS ledger_mission_at ON ledger(mission_id, at DESC);
         CREATE TABLE IF NOT EXISTS user_messages (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           mission_id TEXT NOT NULL,
           text TEXT NOT NULL,
           urgent INTEGER NOT NULL DEFAULT 0,
           at TEXT NOT NULL,
           delivered_at TEXT
         );
         CREATE INDEX IF NOT EXISTS user_messages_undelivered ON user_messages(mission_id, delivered_at);
         CREATE TABLE IF NOT EXISTS pending_questions (
           request_id TEXT PRIMARY KEY,
           mission_id TEXT NOT NULL,
           question TEXT NOT NULL,
           choices_json TEXT NOT NULL,
           asked_at TEXT NOT NULL,
           answer_text TEXT,
           answered_at TEXT,
           resolved_at TEXT
         );
         CREATE INDEX IF NOT EXISTS pending_questions_mission_open
           ON pending_questions(mission_id, resolved_at, answered_at, asked_at);",
    )
    .context("failed to initialize mission store schema")?;
    Ok(())
}

fn open_conn(path: &Path) -> Result<Connection> {
    Connection::open(path)
        .with_context(|| format!("failed to open mission store '{}'", path.display()))
}

fn mission_from_row(row: &Row<'_>) -> rusqlite::Result<Mission> {
    Ok(Mission {
        id: parse_mission_id(&row.get::<_, String>(0)?).map_err(to_sql_error)?,
        goal: row.get(1)?,
        posture: parse_posture(&row.get::<_, String>(2)?).map_err(to_sql_error)?,
        provider_name: row.get(3)?,
        abox_profile: row.get(4)?,
        wallet: serde_json::from_str(&row.get::<_, String>(5)?).map_err(to_sql_error)?,
        status: parse_mission_status(&row.get::<_, String>(6)?).map_err(to_sql_error)?,
        created_at: parse_datetime(&row.get::<_, String>(7)?).map_err(to_sql_error)?,
        completed_at: row
            .get::<_, Option<String>>(8)?
            .map(|value| parse_datetime(&value))
            .transpose()
            .map_err(to_sql_error)?,
    })
}

fn experiment_from_row(row: &Row<'_>) -> rusqlite::Result<Experiment> {
    let spec: bakudo_core::mission::ExperimentSpec =
        serde_json::from_str(&row.get::<_, String>(3)?).map_err(to_sql_error)?;
    let summary_json: Option<String> = row.get(7)?;
    Ok(Experiment {
        id: parse_experiment_id(&row.get::<_, String>(0)?).map_err(to_sql_error)?,
        mission_id: parse_mission_id(&row.get::<_, String>(1)?).map_err(to_sql_error)?,
        label: row.get(2)?,
        spec,
        status: parse_experiment_status(&row.get::<_, String>(4)?).map_err(to_sql_error)?,
        started_at: row
            .get::<_, Option<String>>(5)?
            .map(|value| parse_datetime(&value))
            .transpose()
            .map_err(to_sql_error)?,
        finished_at: row
            .get::<_, Option<String>>(6)?
            .map(|value| parse_datetime(&value))
            .transpose()
            .map_err(to_sql_error)?,
        summary: summary_json
            .map(|json| serde_json::from_str(&json))
            .transpose()
            .map_err(to_sql_error)?,
    })
}

fn active_wave_from_row(row: &Row<'_>) -> rusqlite::Result<ActiveWaveRecord> {
    let payload: ActiveWavePayload =
        serde_json::from_str(&row.get::<_, String>(1)?).map_err(to_sql_error)?;
    Ok(ActiveWaveRecord {
        mission_id: parse_mission_id(&row.get::<_, String>(0)?).map_err(to_sql_error)?,
        experiment_ids: payload.experiment_ids,
        concurrency_limit: payload.concurrency_limit,
        wake_when: parse_wake_when(&row.get::<_, String>(2)?).map_err(to_sql_error)?,
        wake_sent: row.get::<_, i64>(3)? != 0,
        updated_at: parse_datetime(&row.get::<_, String>(4)?).map_err(to_sql_error)?,
    })
}

fn pending_question_from_row(row: &Row<'_>) -> rusqlite::Result<PendingQuestionRecord> {
    Ok(PendingQuestionRecord {
        request_id: row.get(0)?,
        mission_id: parse_mission_id(&row.get::<_, String>(1)?).map_err(to_sql_error)?,
        question: row.get(2)?,
        choices: serde_json::from_str(&row.get::<_, String>(3)?).map_err(to_sql_error)?,
        asked_at: parse_datetime(&row.get::<_, String>(4)?).map_err(to_sql_error)?,
        answer: row.get(5)?,
        answered_at: row
            .get::<_, Option<String>>(6)?
            .map(|value| parse_datetime(&value))
            .transpose()
            .map_err(to_sql_error)?,
        resolved_at: row
            .get::<_, Option<String>>(7)?
            .map(|value| parse_datetime(&value))
            .transpose()
            .map_err(to_sql_error)?,
    })
}

fn parse_mission_id(value: &str) -> Result<MissionId> {
    Ok(MissionId(uuid::Uuid::parse_str(value)?))
}

fn parse_experiment_id(value: &str) -> Result<ExperimentId> {
    Ok(ExperimentId(uuid::Uuid::parse_str(value)?))
}

fn parse_datetime(value: &str) -> Result<DateTime<Utc>> {
    Ok(DateTime::parse_from_rfc3339(value)?.with_timezone(&Utc))
}

fn to_sql_error(err: impl std::fmt::Display) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(
        0,
        rusqlite::types::Type::Text,
        Box::new(std::io::Error::other(err.to_string())),
    )
}

fn posture_str(posture: Posture) -> &'static str {
    match posture {
        Posture::Mission => "mission",
        Posture::Explore => "explore",
    }
}

fn parse_posture(value: &str) -> Result<Posture> {
    match value {
        "mission" => Ok(Posture::Mission),
        "explore" => Ok(Posture::Explore),
        other => Err(anyhow!("unknown posture '{other}'")),
    }
}

fn mission_status_str(status: MissionStatus) -> &'static str {
    match status {
        MissionStatus::Pending => "pending",
        MissionStatus::AwaitingDeliberator => "awaiting_deliberator",
        MissionStatus::Deliberating => "deliberating",
        MissionStatus::Sleeping => "sleeping",
        MissionStatus::Completed => "completed",
        MissionStatus::Cancelled => "cancelled",
        MissionStatus::Failed => "failed",
    }
}

fn parse_mission_status(value: &str) -> Result<MissionStatus> {
    match value {
        "pending" => Ok(MissionStatus::Pending),
        "awaiting_deliberator" => Ok(MissionStatus::AwaitingDeliberator),
        "deliberating" => Ok(MissionStatus::Deliberating),
        "sleeping" => Ok(MissionStatus::Sleeping),
        "completed" => Ok(MissionStatus::Completed),
        "cancelled" => Ok(MissionStatus::Cancelled),
        "failed" => Ok(MissionStatus::Failed),
        other => Err(anyhow!("unknown mission status '{other}'")),
    }
}

fn experiment_status_str(status: ExperimentStatus) -> &'static str {
    match status {
        ExperimentStatus::Queued => "queued",
        ExperimentStatus::Running => "running",
        ExperimentStatus::Succeeded => "succeeded",
        ExperimentStatus::Failed => "failed",
        ExperimentStatus::Cancelled => "cancelled",
        ExperimentStatus::Timeout => "timeout",
    }
}

fn parse_experiment_status(value: &str) -> Result<ExperimentStatus> {
    match value {
        "queued" => Ok(ExperimentStatus::Queued),
        "running" => Ok(ExperimentStatus::Running),
        "succeeded" => Ok(ExperimentStatus::Succeeded),
        "failed" => Ok(ExperimentStatus::Failed),
        "cancelled" => Ok(ExperimentStatus::Cancelled),
        "timeout" => Ok(ExperimentStatus::Timeout),
        other => Err(anyhow!("unknown experiment status '{other}'")),
    }
}

fn wake_reason_str(reason: WakeReason) -> &'static str {
    match reason {
        WakeReason::UserMessage => "user_message",
        WakeReason::ExperimentsComplete => "experiments_complete",
        WakeReason::ExperimentFailed => "experiment_failed",
        WakeReason::BudgetWarning => "budget_warning",
        WakeReason::BudgetExhausted => "budget_exhausted",
        WakeReason::SchedulerTick => "scheduler_tick",
        WakeReason::Timeout => "timeout",
        WakeReason::ManualResume => "manual_resume",
    }
}

fn wake_when_str(wake_when: WakeWhen) -> &'static str {
    match wake_when {
        WakeWhen::AllComplete => "all_complete",
        WakeWhen::FirstComplete => "first_complete",
        WakeWhen::AnyFailure => "any_failure",
    }
}

fn parse_wake_when(value: &str) -> Result<WakeWhen> {
    match value {
        "all_complete" => Ok(WakeWhen::AllComplete),
        "first_complete" => Ok(WakeWhen::FirstComplete),
        "any_failure" => Ok(WakeWhen::AnyFailure),
        other => Err(anyhow!("unknown wake_when '{other}'")),
    }
}

fn ledger_kind_str(kind: LedgerKind) -> &'static str {
    match kind {
        LedgerKind::Decision => "decision",
        LedgerKind::ExperimentSummary => "experiment_summary",
        LedgerKind::UserSteering => "user_steering",
        LedgerKind::Lesson => "lesson",
    }
}

fn parse_ledger_kind(value: &str) -> Result<LedgerKind> {
    match value {
        "decision" => Ok(LedgerKind::Decision),
        "experiment_summary" => Ok(LedgerKind::ExperimentSummary),
        "user_steering" => Ok(LedgerKind::UserSteering),
        "lesson" => Ok(LedgerKind::Lesson),
        other => Err(anyhow!("unknown ledger kind '{other}'")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use bakudo_core::mission::{MissionState, Wallet};
    use std::time::Duration;
    use uuid::Uuid;

    struct TempStoreDir {
        path: PathBuf,
    }

    impl TempStoreDir {
        fn new() -> Self {
            let path =
                std::env::temp_dir().join(format!("bakudo-mission-store-{}", Uuid::new_v4()));
            std::fs::create_dir_all(&path).unwrap();
            Self { path }
        }

        fn db_path(&self) -> PathBuf {
            self.path.join("state.db")
        }
    }

    impl Drop for TempStoreDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }

    fn temp_store_dir() -> TempStoreDir {
        TempStoreDir::new()
    }

    fn sample_mission() -> Mission {
        Mission {
            id: MissionId::new(),
            goal: "Ship wake runtime".to_string(),
            posture: Posture::Mission,
            provider_name: "exec-mission".to_string(),
            abox_profile: "dev-strict".to_string(),
            wallet: Wallet {
                wall_clock_remaining: Duration::from_secs(600),
                abox_workers_remaining: 5,
                abox_workers_in_flight: 0,
                concurrent_max: 2,
            },
            status: MissionStatus::Pending,
            created_at: Utc::now(),
            completed_at: None,
        }
    }

    #[tokio::test]
    async fn mission_store_roundtrips_mission_state_and_ledger() {
        let dir = temp_store_dir();
        let path = dir.db_path();
        let store = MissionStore::open(&path).unwrap();
        let mission = sample_mission();
        let mission_state = MissionState::default_layout();

        store.upsert_mission(&mission).await.unwrap();
        store
            .save_mission_state(mission.id, &mission_state)
            .await
            .unwrap();
        store
            .append_ledger(&LedgerEntry {
                at: Utc::now(),
                kind: LedgerKind::Decision,
                summary: "created mission".to_string(),
                mission_id: mission.id,
                experiment_id: None,
            })
            .await
            .unwrap();

        let loaded = store.mission(mission.id).await.unwrap().unwrap();
        assert_eq!(loaded.goal, mission.goal);
        assert_eq!(
            store.mission_state(mission.id).await.unwrap().0,
            mission_state.0
        );
        assert_eq!(store.recent_ledger(mission.id, 8).await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn mission_store_tracks_undelivered_user_messages() {
        let dir = temp_store_dir();
        let path = dir.db_path();
        let store = MissionStore::open(&path).unwrap();
        let mission = sample_mission();
        store.upsert_mission(&mission).await.unwrap();

        store
            .enqueue_user_message(
                mission.id,
                &UserMessage {
                    at: Utc::now(),
                    text: "focus on the wake flow".to_string(),
                    urgent: true,
                },
            )
            .await
            .unwrap();

        let queued = store.undelivered_user_messages(mission.id).await.unwrap();
        assert_eq!(queued.len(), 1);
        assert!(queued[0].message.urgent);

        store
            .mark_user_messages_delivered(&[queued[0].id])
            .await
            .unwrap();
        assert!(store
            .undelivered_user_messages(mission.id)
            .await
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn mission_store_reads_and_writes_plan_markdown() {
        let dir = temp_store_dir();
        let path = dir.db_path();
        let store = MissionStore::open(&path).unwrap();
        let mission = sample_mission();
        store.upsert_mission(&mission).await.unwrap();

        let plan = "# Mission Plan\n\n## Objective\nShip it.\n";
        store.seed_mission_plan(mission.id, plan).await.unwrap();
        let (plan_path, markdown) = store.read_mission_plan(mission.id).await.unwrap();
        assert!(plan_path.ends_with("mission_plan.md"));
        assert_eq!(markdown, plan);
        assert!(store
            .mission_plan_updated_at(mission.id)
            .await
            .unwrap()
            .is_some());
    }

    #[tokio::test]
    async fn mission_store_roundtrips_active_wave_payload() {
        let dir = temp_store_dir();
        let path = dir.db_path();
        let store = MissionStore::open(&path).unwrap();
        let mission = sample_mission();
        store.upsert_mission(&mission).await.unwrap();

        let wave = ActiveWaveRecord {
            mission_id: mission.id,
            experiment_ids: vec![ExperimentId::new(), ExperimentId::new()],
            concurrency_limit: 2,
            wake_when: WakeWhen::FirstComplete,
            wake_sent: false,
            updated_at: Utc::now(),
        };
        store.save_active_wave(&wave).await.unwrap();

        let loaded = store.active_wave(mission.id).await.unwrap().unwrap();
        assert_eq!(loaded.experiment_ids, wave.experiment_ids);
        assert_eq!(loaded.concurrency_limit, 2);
        assert_eq!(loaded.wake_when, WakeWhen::FirstComplete);

        let _ = std::fs::remove_file(path);
    }

    #[tokio::test]
    async fn mission_store_roundtrips_pending_questions() {
        let dir = temp_store_dir();
        let path = dir.db_path();
        let store = MissionStore::open(&path).unwrap();
        let mission = sample_mission();
        let asked_at = Utc::now();
        store.upsert_mission(&mission).await.unwrap();

        store
            .insert_pending_question(&PendingQuestionRecord {
                request_id: "question-1".to_string(),
                mission_id: mission.id,
                question: "Choose the next step".to_string(),
                choices: vec!["wave-1".to_string(), "wave-2".to_string()],
                asked_at,
                answer: None,
                answered_at: None,
                resolved_at: None,
            })
            .await
            .unwrap();

        let open = store.open_pending_questions(mission.id).await.unwrap();
        assert_eq!(open.len(), 1);
        assert_eq!(open[0].question, "Choose the next step");
        assert_eq!(open[0].choices, vec!["wave-1", "wave-2"]);
    }

    #[tokio::test]
    async fn mission_store_promotes_answered_pending_questions() {
        let dir = temp_store_dir();
        let path = dir.db_path();
        let store = MissionStore::open(&path).unwrap();
        let mission = sample_mission();
        let asked_at = Utc::now();
        store.upsert_mission(&mission).await.unwrap();
        store
            .insert_pending_question(&PendingQuestionRecord {
                request_id: "question-1".to_string(),
                mission_id: mission.id,
                question: "Choose the next step".to_string(),
                choices: vec!["wave-1".to_string(), "wave-2".to_string()],
                asked_at,
                answer: None,
                answered_at: None,
                resolved_at: None,
            })
            .await
            .unwrap();
        store
            .save_pending_question_answer("question-1", "wave-2", asked_at)
            .await
            .unwrap();

        let promoted = store
            .promote_answered_pending_question_to_user_message("question-1", true)
            .await
            .unwrap();
        assert!(promoted.is_some());
        let queued = store.undelivered_user_messages(mission.id).await.unwrap();
        assert_eq!(queued.len(), 1);
        assert_eq!(queued[0].message.text, "wave-2");
        assert!(queued[0].message.urgent);
        assert!(store
            .open_pending_questions(mission.id)
            .await
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn mission_store_reads_latest_tool_call_error_summary() {
        let dir = temp_store_dir();
        let path = dir.db_path();
        let store = MissionStore::open(&path).unwrap();
        let mission = sample_mission();
        store.upsert_mission(&mission).await.unwrap();
        store
            .append_ledger(&LedgerEntry {
                at: Utc::now(),
                kind: LedgerKind::Decision,
                summary: "tool_call_error: read_plan: boom".to_string(),
                mission_id: mission.id,
                experiment_id: None,
            })
            .await
            .unwrap();
        store
            .append_ledger(&LedgerEntry {
                at: Utc::now(),
                kind: LedgerKind::Decision,
                summary: "tool_call_error: update_plan: missing field".to_string(),
                mission_id: mission.id,
                experiment_id: None,
            })
            .await
            .unwrap();

        assert_eq!(
            store.latest_tool_call_error(mission.id).await.unwrap(),
            Some("tool_call_error: update_plan: missing field".to_string())
        );
    }
}
