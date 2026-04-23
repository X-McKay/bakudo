use thiserror::Error;

/// Top-level bakudo error type. All fallible public APIs return `Result<T, BakudoError>`.
#[derive(Debug, Error)]
pub enum BakudoError {
    #[error("abox error: {0}")]
    Abox(#[from] AboxError),
    #[error("config error: {0}")]
    Config(#[from] ConfigError),
    #[error("session error: {0}")]
    Session(#[from] SessionError),
    #[error("provider error: {0}")]
    Provider(#[from] ProviderError),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("{0}")]
    Other(#[from] anyhow::Error),
}

#[derive(Debug, Error)]
pub enum AboxError {
    #[error("abox binary not found at '{path}': {source}")]
    BinaryNotFound {
        path: String,
        source: std::io::Error,
    },
    #[error("abox run failed (exit {exit_code}): {stderr}")]
    RunFailed { exit_code: i32, stderr: String },
    #[error("abox sandbox '{task_id}' not found")]
    SandboxNotFound { task_id: String },
    #[error("abox merge failed for '{task_id}': {detail}")]
    MergeFailed { task_id: String, detail: String },
    #[error("abox stop failed for '{task_id}': {detail}")]
    StopFailed { task_id: String, detail: String },
    #[error("abox list failed: {detail}")]
    ListFailed { detail: String },
    #[error("failed to parse abox list output: {0}")]
    ParseError(String),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

#[derive(Debug, Error)]
pub enum ConfigError {
    #[error("config file not found at '{path}'")]
    NotFound { path: String },
    #[error("config parse error in '{path}': {detail}")]
    ParseError { path: String, detail: String },
    #[error("missing required field '{field}'")]
    MissingField { field: String },
    #[error("invalid value for '{field}': {detail}")]
    InvalidValue { field: String, detail: String },
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

#[derive(Debug, Error)]
pub enum SessionError {
    #[error("session '{session_id}' not found")]
    NotFound { session_id: String },
    #[error("session lock busy for '{session_id}': held by pid {owner_pid}")]
    LockBusy { session_id: String, owner_pid: u32 },
    #[error("session store error: {0}")]
    Store(String),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

#[derive(Debug, Error)]
pub enum ProviderError {
    #[error("unknown provider '{provider_id}'")]
    UnknownProvider { provider_id: String },
    #[error("provider '{provider_id}' binary not found: {detail}")]
    BinaryNotFound { provider_id: String, detail: String },
    #[error("provider dispatch failed: {0}")]
    DispatchFailed(String),
}

pub type Result<T> = std::result::Result<T, BakudoError>;
