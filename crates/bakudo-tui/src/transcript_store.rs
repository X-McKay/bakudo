use std::collections::VecDeque;
use std::path::PathBuf;

use crate::app::ChatMessage;

#[derive(Debug, Clone)]
pub struct TranscriptStore {
    path: PathBuf,
}

impl TranscriptStore {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }

    pub fn load(&self) -> std::io::Result<VecDeque<ChatMessage>> {
        if !self.path.exists() {
            return Ok(VecDeque::new());
        }
        let text = std::fs::read_to_string(&self.path)?;
        let mut messages = VecDeque::new();
        for line in text.lines() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let message = serde_json::from_str::<ChatMessage>(line)
                .map_err(|err| std::io::Error::other(err.to_string()))?;
            messages.push_back(message);
        }
        Ok(messages)
    }

    pub fn append(&self, message: &ChatMessage) -> std::io::Result<()> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)?;
        serde_json::to_writer(&mut file, message).map_err(std::io::Error::other)?;
        use std::io::Write;
        file.write_all(b"\n")
    }
}
