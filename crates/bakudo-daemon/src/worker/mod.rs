use anyhow::{anyhow, Result};
use bakudo_core::mission::ExperimentScript;

use crate::provider_runtime::{ProviderEngine, WorkerRuntimeConfig};

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

struct ProviderCli {
    binary: &'static str,
    model_flag: &'static str,
}

pub fn build_script_worker_command(script: &ExperimentScript) -> Vec<String> {
    match script {
        ExperimentScript::Inline { source } => {
            vec!["bash".to_string(), "-lc".to_string(), source.clone()]
        }
        ExperimentScript::File { path } => vec!["bash".to_string(), path.clone()],
    }
}

pub fn build_agent_worker_command(
    config: &WorkerRuntimeConfig,
    model: Option<&str>,
    allow_all_tools: bool,
) -> Result<Vec<String>> {
    let (binary, mut args) = match config.engine {
        ProviderEngine::Exec => {
            let (first, rest) = config
                .engine_args
                .split_first()
                .ok_or_else(|| anyhow!("exec worker runtime is missing engine_args"))?;
            (first.clone(), rest.to_vec())
        }
        engine => {
            let cli = provider_cli(engine);
            let mut args = config.engine_args.clone();
            if let Some(model) = model.filter(|value| !value.is_empty()) {
                if !cli.model_flag.is_empty() {
                    args.push(cli.model_flag.to_string());
                    args.push(model.to_string());
                }
            }
            if allow_all_tools && config.allow_all_tools {
                if let Some(flag) = config.engine.allow_all_flag() {
                    args.push(flag.to_string());
                }
            }
            (cli.binary.to_string(), args)
        }
    };

    let mut command = vec![
        "python3".to_string(),
        "-c".to_string(),
        WORKER_WRAPPER_PY.to_string(),
        binary,
    ];
    command.append(&mut args);
    Ok(command)
}

fn provider_cli(engine: ProviderEngine) -> ProviderCli {
    match engine {
        ProviderEngine::ClaudeCode => ProviderCli {
            binary: "claude",
            model_flag: "--model",
        },
        ProviderEngine::Codex => ProviderCli {
            binary: "codex",
            model_flag: "--model",
        },
        ProviderEngine::OpenCode => ProviderCli {
            binary: "opencode",
            model_flag: "--model",
        },
        ProviderEngine::Gemini => ProviderCli {
            binary: "gemini",
            model_flag: "--model",
        },
        ProviderEngine::Exec => ProviderCli {
            binary: "",
            model_flag: "",
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codex_agent_worker_command_wraps_runtime() {
        let command = build_agent_worker_command(
            &WorkerRuntimeConfig {
                engine: ProviderEngine::Codex,
                engine_args: vec!["exec".to_string()],
                abox_profile: "worker".to_string(),
                allow_all_tools: true,
                timeout_secs: 1800,
                max_output_bytes: 1024,
                memory_mib: None,
                cpus: None,
            },
            Some("gpt-5"),
            true,
        )
        .unwrap();
        assert_eq!(command[0], "python3");
        assert_eq!(command[3], "codex");
        assert_eq!(&command[4..], &["exec", "--model", "gpt-5", "--full-auto"]);
    }

    #[test]
    fn script_worker_command_keeps_shell_layout() {
        let command = build_script_worker_command(&ExperimentScript::Inline {
            source: "cargo test".to_string(),
        });
        assert_eq!(command, vec!["bash", "-lc", "cargo test"]);
    }
}
