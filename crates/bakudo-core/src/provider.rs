use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

const WORKER_WRAPPER_PY: &str = r###"import json, os, subprocess, sys, threading, time
from datetime import datetime, timezone

EVENT_PREFIX = 'BAKUDO_EVENT'
RESULT_PREFIX = 'BAKUDO_RESULT'
ERROR_PREFIX = 'BAKUDO_ERROR'
SUMMARY_PREFIX = 'BAKUDO_SUMMARY:'
SCHEMA_VERSION = int(os.environ.get('BAKUDO_PROTOCOL_SCHEMA_VERSION', '1'))
ATTEMPT_ID = os.environ.get('BAKUDO_ATTEMPT_ID', 'unknown')
SESSION_ID = os.environ.get('BAKUDO_SESSION_ID', 'unknown')
TASK_ID = os.environ.get('BAKUDO_TASK_ID', 'unknown')
PROMPT = os.environ.get('BAKUDO_PROMPT', '')
HEARTBEAT_INTERVAL_MS = max(
    250,
    int(os.environ.get('BAKUDO_HEARTBEAT_INTERVAL_MS', '5000') or '5000'),
)
FILE_EXTENSIONS = (
    '.rs', '.toml', '.md', '.txt', '.json', '.yaml', '.yml', '.py',
    '.ts', '.tsx', '.js', '.jsx', '.css', '.html', '.sql', '.sh',
)
COMMAND_NAMES = {
    'awk', 'bash', 'cargo', 'cat', 'chmod', 'cp', 'find', 'git', 'go',
    'grep', 'just', 'ls', 'make', 'mkdir', 'mv', 'node', 'npm', 'pnpm',
    'python', 'python3', 'rg', 'rm', 'rustc', 'rustfmt', 'sed', 'sh',
    'touch', 'uv', 'yarn',
}
TOOL_MARKERS = (
    'functions.exec_command',
    'functions.write_stdin',
    'functions.apply_patch',
    'functions.exec_command',
    'multi_tool_use.parallel',
    'tool_search.tool_search_tool',
    'web.',
    'apply_patch',
)

def timestamp():
    return datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')

def emit(prefix, payload):
    print(f'{prefix} {json.dumps(payload, ensure_ascii=False)}', flush=True)

def emit_event(kind, message, metadata=None):
    payload = {
        'attempt_id': ATTEMPT_ID,
        'kind': kind,
        'message': message,
        'timestamp': timestamp(),
    }
    if metadata:
        payload['metadata'] = metadata
    emit(EVENT_PREFIX, payload)

def normalize_path(token):
    cleaned = token.strip().strip('`"\'[](),:;')
    if not cleaned:
        return ''
    if '/' in cleaned or cleaned.endswith(FILE_EXTENSIONS):
        return cleaned
    return ''

def extract_path(text):
    for token in text.replace(',', ' ').split():
        path = normalize_path(token)
        if path:
            return path
    return ''

def extract_after_prefix(line, prefixes):
    lower = line.lower()
    for prefix in prefixes:
        if lower.startswith(prefix):
            return line[len(prefix):].strip(' :`')
    return ''

def is_command_text(text):
    stripped = text.strip().strip('`')
    if not stripped:
        return False
    first = stripped.split()[0]
    return first in COMMAND_NAMES or first.startswith('./')

def extract_command(line):
    candidate = extract_after_prefix(
        line,
        (
            'running command',
            'executing command',
            'running',
            'executing',
            'command',
        ),
    )
    if candidate and is_command_text(candidate):
        return candidate.strip('`')
    if line.startswith('$ '):
        candidate = line[2:].strip()
        if is_command_text(candidate):
            return candidate
    stripped = line.strip()
    if is_command_text(stripped):
        return stripped
    return ''

def extract_tool_name(text):
    lower = text.lower()
    for prefix in ('calling tool ', 'tool call ', 'tool result '):
        if lower.startswith(prefix):
            return text[len(prefix):].strip(' :`')
    for marker in TOOL_MARKERS:
        idx = text.find(marker)
        if idx == -1:
            continue
        end = idx
        while end < len(text) and text[end] not in ' ({[:':
            end += 1
        return text[idx:end]
    return ''

def classify_line(raw_line, from_stderr=False):
    line = raw_line.strip()
    if not line:
        return None
    if line.startswith(SUMMARY_PREFIX):
        summary = line[len(SUMMARY_PREFIX):].strip()
        return ('status_update', summary or 'worker summary emitted', {'detail': 'summary'})
    tool_name = extract_tool_name(line)
    lower = line.lower()
    if tool_name and any(
        token in lower
        for token in (' result', ' completed', ' finished', ' returned', ' exit code')
    ):
        return ('tool_result', line, {'tool_name': tool_name})
    if tool_name:
        return ('tool_call', line, {'tool_name': tool_name})
    command = extract_command(line)
    if command:
        return ('command_execution', command, {'command': command})
    if any(
        lower.startswith(prefix)
        for prefix in (
            'reading ',
            'read ',
            'opening ',
            'opened ',
            'viewing ',
            'inspect ',
            'inspecting ',
            'exploring ',
            'listing ',
        )
    ):
        path = extract_path(line)
        return ('file_exploration', path or line, {'path': path} if path else None)
    if any(
        lower.startswith(prefix)
        for prefix in (
            'editing ',
            'edited ',
            'updating ',
            'updated ',
            'writing ',
            'wrote ',
            'creating ',
            'created ',
            'adding ',
            'added ',
            'removing ',
            'removed ',
            'patching ',
            'patched ',
        )
    ):
        path = extract_path(line)
        return ('code_edit', path or line, {'path': path} if path else None)
    if from_stderr:
        return ('status_update', f'(stderr) {line}', None)
    return ('assistant_message', line, None)

binary = sys.argv[1]
args = sys.argv[2:]
start = time.monotonic()
last_line = {'value': ''}
summary_line = {'value': ''}
heartbeat_stop = threading.Event()

try:
    proc = subprocess.Popen(
        [binary, *args],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
    )
except Exception as exc:
    print(f'{ERROR_PREFIX} failed to spawn provider: {exc}', flush=True)
    sys.exit(127)

def heartbeat_loop():
    while not heartbeat_stop.wait(HEARTBEAT_INTERVAL_MS / 1000.0):
        if proc.poll() is not None:
            break
        emit_event('heartbeat', 'worker still running')

if proc.stdin is not None:
    try:
        proc.stdin.write(PROMPT)
    finally:
        proc.stdin.close()

def pump(stream, from_stderr=False):
    if stream is None:
        return
    for raw in stream:
        event = classify_line(raw.rstrip('\n'), from_stderr=from_stderr)
        if event is None:
            continue
        kind, message, metadata = event
        if kind in ('assistant_message', 'status_update'):
            last_line['value'] = message
        if metadata and metadata.get('detail') == 'summary':
            summary_line['value'] = message
        emit_event(kind, message, metadata)

heartbeat_thread = threading.Thread(target=heartbeat_loop)
heartbeat_thread.daemon = True
heartbeat_thread.start()
stderr_thread = threading.Thread(target=pump, args=(proc.stderr, True))
stderr_thread.daemon = True
stderr_thread.start()
pump(proc.stdout)
exit_code = proc.wait()
heartbeat_stop.set()
heartbeat_thread.join()
stderr_thread.join()
status = 'succeeded' if exit_code == 0 else 'failed'
summary = summary_line['value'] or last_line['value'] or f'provider exited with code {exit_code}'
emit(RESULT_PREFIX, {
    'schema_version': SCHEMA_VERSION,
    'attempt_id': ATTEMPT_ID,
    'session_id': SESSION_ID,
    'task_id': TASK_ID,
    'status': status,
    'summary': summary[:200],
    'finished_at': timestamp(),
    'exit_code': exit_code,
    'duration_ms': int((time.monotonic() - start) * 1000),
    'timed_out': False,
    'stdout': '',
    'stderr': '',
    'stdout_truncated': False,
    'stderr_truncated': False,
})
"###;

pub fn build_wrapped_worker_command(
    binary: impl Into<String>,
    args: impl IntoIterator<Item = String>,
) -> Vec<String> {
    let mut command = vec![
        "python3".to_string(),
        "-c".to_string(),
        WORKER_WRAPPER_PY.to_string(),
        binary.into(),
    ];
    command.extend(args);
    command
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderSpec {
    pub id: String,
    pub display_name: String,
    pub binary: String,
    pub non_interactive_args: Vec<String>,
    pub model_flag: String,
    pub allow_all_flag: Option<String>,
    pub memory_mib: Option<u32>,
    pub cpus: Option<u8>,
}

impl ProviderSpec {
    /// Build the full argument list for a non-interactive invocation.
    pub fn build_args(&self, model: Option<&str>, allow_all: bool) -> Vec<String> {
        let mut args = self.non_interactive_args.clone();
        if let Some(m) = model.filter(|s| !s.is_empty()) {
            if !self.model_flag.is_empty() {
                args.push(self.model_flag.clone());
                args.push(m.to_string());
            }
        }
        if allow_all {
            if let Some(flag) = &self.allow_all_flag {
                args.push(flag.clone());
            }
        }
        args
    }

    /// Build a guest-safe wrapper command that emits structured progress and
    /// result envelopes around provider output.
    pub fn build_worker_command(&self, model: Option<&str>, allow_all: bool) -> Vec<String> {
        build_wrapped_worker_command(self.binary.clone(), self.build_args(model, allow_all))
    }
}

#[derive(Debug, Clone)]
pub struct ProviderRegistry {
    providers: BTreeMap<String, ProviderSpec>,
    default_provider: String,
}

impl ProviderRegistry {
    pub fn with_defaults() -> Self {
        let mut providers = BTreeMap::new();

        providers.insert(
            "claude".to_string(),
            ProviderSpec {
                id: "claude".to_string(),
                display_name: "Claude Code".to_string(),
                binary: "claude".to_string(),
                non_interactive_args: vec!["-p".to_string()],
                model_flag: "--model".to_string(),
                allow_all_flag: Some("--dangerously-skip-permissions".to_string()),
                memory_mib: Some(4096),
                cpus: Some(2),
            },
        );

        providers.insert(
            "codex".to_string(),
            ProviderSpec {
                id: "codex".to_string(),
                display_name: "OpenAI Codex CLI".to_string(),
                binary: "codex".to_string(),
                non_interactive_args: vec!["exec".to_string()],
                model_flag: "--model".to_string(),
                allow_all_flag: Some("--full-auto".to_string()),
                memory_mib: Some(4096),
                cpus: Some(2),
            },
        );

        providers.insert(
            "opencode".to_string(),
            ProviderSpec {
                id: "opencode".to_string(),
                display_name: "OpenCode".to_string(),
                binary: "opencode".to_string(),
                non_interactive_args: vec!["run".to_string()],
                model_flag: "--model".to_string(),
                allow_all_flag: None,
                memory_mib: Some(4096),
                cpus: Some(2),
            },
        );

        providers.insert(
            "gemini".to_string(),
            ProviderSpec {
                id: "gemini".to_string(),
                display_name: "Gemini CLI".to_string(),
                binary: "gemini".to_string(),
                non_interactive_args: vec!["-p".to_string()],
                model_flag: "--model".to_string(),
                allow_all_flag: Some("--yolo".to_string()),
                memory_mib: Some(4096),
                cpus: Some(2),
            },
        );

        Self {
            providers,
            default_provider: "claude".to_string(),
        }
    }

    pub fn get(&self, id: &str) -> Option<&ProviderSpec> {
        self.providers.get(id)
    }

    pub fn default_provider_id(&self) -> &str {
        &self.default_provider
    }

    pub fn set_default(&mut self, id: &str) -> Result<(), String> {
        if self.providers.contains_key(id) {
            self.default_provider = id.to_string();
            Ok(())
        } else {
            Err(format!("unknown provider '{}'", id))
        }
    }

    pub fn list_ids(&self) -> Vec<&str> {
        // BTreeMap iteration is already sorted.
        self.providers.keys().map(|s| s.as_str()).collect()
    }
}

impl Default for ProviderRegistry {
    fn default() -> Self {
        Self::with_defaults()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_registry_has_all_providers() {
        let reg = ProviderRegistry::with_defaults();
        assert!(reg.get("claude").is_some());
        assert!(reg.get("codex").is_some());
        assert!(reg.get("opencode").is_some());
        assert!(reg.get("gemini").is_some());
    }

    #[test]
    fn claude_args_non_interactive() {
        let reg = ProviderRegistry::with_defaults();
        let args = reg.get("claude").unwrap().build_args(None, false);
        assert_eq!(args, vec!["-p"]);
    }

    #[test]
    fn claude_args_with_model_and_allow_all() {
        let reg = ProviderRegistry::with_defaults();
        let args = reg
            .get("claude")
            .unwrap()
            .build_args(Some("claude-opus-4-5"), true);
        assert_eq!(
            args,
            vec![
                "-p",
                "--model",
                "claude-opus-4-5",
                "--dangerously-skip-permissions"
            ]
        );
    }

    #[test]
    fn codex_exec_subcommand() {
        let reg = ProviderRegistry::with_defaults();
        let args = reg.get("codex").unwrap().build_args(None, false);
        assert_eq!(args, vec!["exec"]);
    }

    #[test]
    fn worker_command_wraps_provider_and_preserves_args() {
        let reg = ProviderRegistry::with_defaults();
        let cmd = reg
            .get("codex")
            .unwrap()
            .build_worker_command(Some("gpt-5"), true);
        assert_eq!(cmd[0], "python3");
        assert_eq!(cmd[1], "-c");
        assert!(cmd[2].contains("BAKUDO_RESULT"));
        assert_eq!(cmd[3], "codex");
        assert_eq!(&cmd[4..], &["exec", "--model", "gpt-5", "--full-auto"]);
    }

    #[test]
    fn empty_model_string_is_treated_as_none() {
        let reg = ProviderRegistry::with_defaults();
        let args = reg.get("claude").unwrap().build_args(Some(""), false);
        assert_eq!(args, vec!["-p"]);
    }

    #[test]
    fn set_default_unknown_fails() {
        let mut reg = ProviderRegistry::with_defaults();
        assert!(reg.set_default("nonexistent").is_err());
    }
}
