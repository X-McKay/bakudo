//! Session management — a session is a single interactive bakudo shell run.
//! Sessions are identified by a UUID and stored in the data directory.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

use crate::error::SessionError;
use crate::protocol::SessionId;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionRecord {
    pub session_id: SessionId,
    pub started_at: DateTime<Utc>,
    pub provider_id: String,
    pub model: Option<String>,
    pub repo_root: Option<String>,
}

impl SessionRecord {
    pub fn new(
        provider_id: impl Into<String>,
        model: Option<String>,
        repo_root: Option<String>,
    ) -> Self {
        Self {
            session_id: SessionId::new(),
            started_at: Utc::now(),
            provider_id: provider_id.into(),
            model,
            repo_root,
        }
    }

    pub fn with_id(
        session_id: SessionId,
        provider_id: impl Into<String>,
        model: Option<String>,
        repo_root: Option<String>,
    ) -> Self {
        Self {
            session_id,
            started_at: Utc::now(),
            provider_id: provider_id.into(),
            model,
            repo_root,
        }
    }

    pub fn load(data_dir: &Path, session_id: &str) -> Result<Self, SessionError> {
        let path = session_path(data_dir, session_id);
        if !path.exists() {
            return Err(SessionError::NotFound {
                session_id: session_id.to_string(),
            });
        }
        Self::read_from_path(&path)
    }

    pub fn save(&self, data_dir: &Path) -> Result<(), SessionError> {
        let path = session_path(data_dir, &self.session_id.0);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let tmp = path.with_extension("json.tmp");
        let json = serde_json::to_string_pretty(self)
            .map_err(|e| SessionError::Store(format!("failed to serialize session: {e}")))?;
        std::fs::write(&tmp, json)?;
        std::fs::rename(&tmp, &path)?;
        Ok(())
    }

    pub fn list(data_dir: &Path) -> Result<Vec<Self>, SessionError> {
        let dir = session_dir(data_dir);
        if !dir.exists() {
            return Ok(Vec::new());
        }

        let mut sessions = Vec::new();
        for entry in std::fs::read_dir(&dir)? {
            let entry = entry?;
            let path = entry.path();
            if !entry.file_type()?.is_file()
                || path.extension().and_then(|ext| ext.to_str()) != Some("json")
            {
                continue;
            }
            sessions.push(Self::read_from_path(&path)?);
        }

        sessions.sort_by(|left, right| {
            right
                .started_at
                .cmp(&left.started_at)
                .then_with(|| left.session_id.0.cmp(&right.session_id.0))
        });
        Ok(sessions)
    }

    fn read_from_path(path: &Path) -> Result<Self, SessionError> {
        let text = std::fs::read_to_string(path)?;
        serde_json::from_str(&text)
            .map_err(|e| SessionError::Store(format!("failed to parse '{}': {e}", path.display())))
    }
}

fn session_path(data_dir: &Path, session_id: &str) -> PathBuf {
    session_dir(data_dir).join(format!("{session_id}.json"))
}

fn session_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("sessions")
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;
    use uuid::Uuid;

    #[test]
    fn session_record_roundtrips_to_disk() {
        let data_dir = std::env::temp_dir().join(format!("bakudo-session-{}", Uuid::new_v4()));
        let record = SessionRecord::with_id(
            SessionId("session-test".to_string()),
            "codex",
            Some("gpt-5".to_string()),
            Some("/tmp/repo".to_string()),
        );

        record.save(&data_dir).unwrap();
        let loaded = SessionRecord::load(&data_dir, "session-test").unwrap();
        assert_eq!(loaded.session_id.0, "session-test");
        assert_eq!(loaded.provider_id, "codex");
        assert_eq!(loaded.model.as_deref(), Some("gpt-5"));
        assert_eq!(loaded.repo_root.as_deref(), Some("/tmp/repo"));

        let _ = std::fs::remove_dir_all(data_dir);
    }

    #[test]
    fn session_list_returns_newest_first() {
        let data_dir = std::env::temp_dir().join(format!("bakudo-session-{}", Uuid::new_v4()));
        let session_dir = data_dir.join("sessions");
        std::fs::create_dir_all(&session_dir).unwrap();
        std::fs::write(session_dir.join("ignore-me.txt"), "noop").unwrap();

        let older = SessionRecord {
            session_id: SessionId("session-older".to_string()),
            started_at: Utc.timestamp_opt(1_700_000_000, 0).single().unwrap(),
            provider_id: "codex".to_string(),
            model: None,
            repo_root: Some("/tmp/older".to_string()),
        };
        let newer = SessionRecord {
            session_id: SessionId("session-newer".to_string()),
            started_at: Utc.timestamp_opt(1_800_000_000, 0).single().unwrap(),
            provider_id: "claude".to_string(),
            model: Some("sonnet".to_string()),
            repo_root: Some("/tmp/newer".to_string()),
        };

        older.save(&data_dir).unwrap();
        newer.save(&data_dir).unwrap();

        let sessions = SessionRecord::list(&data_dir).unwrap();
        let ids: Vec<_> = sessions
            .into_iter()
            .map(|session| session.session_id.0)
            .collect();
        assert_eq!(ids, vec!["session-newer", "session-older"]);

        let _ = std::fs::remove_dir_all(data_dir);
    }

    #[test]
    fn session_list_returns_empty_when_store_is_missing() {
        let data_dir = std::env::temp_dir().join(format!("bakudo-session-{}", Uuid::new_v4()));
        let sessions = SessionRecord::list(&data_dir).unwrap();
        assert!(sessions.is_empty());
    }
}
