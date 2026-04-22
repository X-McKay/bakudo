//! Session management — a session is a single interactive bakudo shell run.
//! Sessions are identified by a UUID and stored in the data directory.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::protocol::SessionId;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionRecord {
    pub session_id: SessionId,
    pub started_at: DateTime<Utc>,
    pub provider_id: String,
    pub model: String,
    pub repo_root: Option<String>,
}

impl SessionRecord {
    pub fn new(provider_id: impl Into<String>, model: impl Into<String>) -> Self {
        Self {
            session_id: SessionId::new(),
            started_at: Utc::now(),
            provider_id: provider_id.into(),
            model: model.into(),
            repo_root: None,
        }
    }
}
