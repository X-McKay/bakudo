use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

const WORKER_WRAPPER_PY: &str = concat!(
    "import json, os, subprocess, sys, threading, time\n",
    "from datetime import datetime, timezone\n",
    "\n",
    "EVENT_PREFIX = 'BAKUDO_EVENT'\n",
    "RESULT_PREFIX = 'BAKUDO_RESULT'\n",
    "ERROR_PREFIX = 'BAKUDO_ERROR'\n",
    "SCHEMA_VERSION = int(os.environ.get('BAKUDO_PROTOCOL_SCHEMA_VERSION', '1'))\n",
    "ATTEMPT_ID = os.environ.get('BAKUDO_ATTEMPT_ID', 'unknown')\n",
    "SESSION_ID = os.environ.get('BAKUDO_SESSION_ID', 'unknown')\n",
    "TASK_ID = os.environ.get('BAKUDO_TASK_ID', 'unknown')\n",
    "PROMPT = os.environ.get('BAKUDO_PROMPT', '')\n",
    "\n",
    "def timestamp():\n",
    "    return datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')\n",
    "\n",
    "def emit(prefix, payload):\n",
    "    print(f'{prefix} {json.dumps(payload, ensure_ascii=False)}', flush=True)\n",
    "\n",
    "binary = sys.argv[1]\n",
    "args = sys.argv[2:]\n",
    "start = time.monotonic()\n",
    "last_line = {'value': ''}\n",
    "\n",
    "try:\n",
    "    proc = subprocess.Popen(\n",
    "        [binary, *args],\n",
    "        stdin=subprocess.PIPE,\n",
    "        stdout=subprocess.PIPE,\n",
    "        stderr=subprocess.PIPE,\n",
    "        text=True,\n",
    "        bufsize=1,\n",
    "    )\n",
    "except Exception as exc:\n",
    "    print(f'{ERROR_PREFIX} failed to spawn provider: {exc}', flush=True)\n",
    "    sys.exit(127)\n",
    "\n",
    "if proc.stdin is not None:\n",
    "    try:\n",
    "        proc.stdin.write(PROMPT)\n",
    "    finally:\n",
    "        proc.stdin.close()\n",
    "\n",
    "def pump(stream, kind, prefix=''):\n",
    "    if stream is None:\n",
    "        return\n",
    "    for raw in stream:\n",
    "        line = raw.rstrip('\\n')\n",
    "        trimmed = line.strip()\n",
    "        if not trimmed:\n",
    "            continue\n",
    "        if kind == 'assistant_message':\n",
    "            last_line['value'] = trimmed\n",
    "        emit(EVENT_PREFIX, {\n",
    "            'attempt_id': ATTEMPT_ID,\n",
    "            'kind': kind,\n",
    "            'message': f'{prefix}{trimmed}',\n",
    "            'timestamp': timestamp(),\n",
    "        })\n",
    "\n",
    "stderr_thread = threading.Thread(target=pump, args=(proc.stderr, 'status_update', '(stderr) '))\n",
    "stderr_thread.daemon = True\n",
    "stderr_thread.start()\n",
    "pump(proc.stdout, 'assistant_message')\n",
    "exit_code = proc.wait()\n",
    "stderr_thread.join()\n",
    "status = 'succeeded' if exit_code == 0 else 'failed'\n",
    "summary = last_line['value'] or f'provider exited with code {exit_code}'\n",
    "emit(RESULT_PREFIX, {\n",
    "    'schema_version': SCHEMA_VERSION,\n",
    "    'attempt_id': ATTEMPT_ID,\n",
    "    'session_id': SESSION_ID,\n",
    "    'task_id': TASK_ID,\n",
    "    'status': status,\n",
    "    'summary': summary[:200],\n",
    "    'finished_at': timestamp(),\n",
    "    'exit_code': exit_code,\n",
    "    'duration_ms': int((time.monotonic() - start) * 1000),\n",
    "    'timed_out': False,\n",
    "    'stdout': '',\n",
    "    'stderr': '',\n",
    "    'stdout_truncated': False,\n",
    "    'stderr_truncated': False,\n",
    "})\n",
);

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
        let mut command = vec![
            "python3".to_string(),
            "-c".to_string(),
            WORKER_WRAPPER_PY.to_string(),
            self.binary.clone(),
        ];
        command.extend(self.build_args(model, allow_all));
        command
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
