use crate::provider_runtime::{ProviderEngine, WorkerRuntimeConfig};
use anyhow::{anyhow, Result};
use bakudo_core::mission::ExperimentScript;
use bakudo_core::provider::build_wrapped_worker_command;

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
    let (binary, args) = match config.engine {
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

    Ok(build_wrapped_worker_command(binary, args))
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
