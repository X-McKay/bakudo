//! Provider/abox health probes surfaced via the `/doctor` slash command
//! and the `bakudo doctor` subcommand.

use tokio::process::Command;

use bakudo_core::abox::{AboxAdapter, AboxVersionStatus, MIN_ABOX_VERSION};
use bakudo_core::config::BakudoConfig;
use bakudo_core::provider::ProviderRegistry;

fn fmt_version(v: (u32, u32, u32)) -> String {
    format!("{}.{}.{}", v.0, v.1, v.2)
}

/// Build a multi-line human-readable health report.
pub async fn run(config: &BakudoConfig, abox: &AboxAdapter, registry: &ProviderRegistry) -> String {
    let mut lines = Vec::new();
    lines.push(String::from("Bakudo health check"));
    lines.push(String::from("────────────────────"));

    match abox.version().await {
        Ok(raw) => match bakudo_core::abox::check_abox_version(&raw) {
            AboxVersionStatus::Ok { .. } => {
                lines.push(format!("  abox       [ ok ]  {raw}  ({})", config.abox_bin));
            }
            AboxVersionStatus::TooOld { current, min } => {
                lines.push(format!(
                    "  abox       [warn]  {raw}  ({})  — bakudo requires ≥ {}; current {} is too old. Run `just install-abox` from the bakudo-abox workspace root.",
                    config.abox_bin,
                    fmt_version(min),
                    fmt_version(current),
                ));
            }
            AboxVersionStatus::Unparseable(raw) => {
                lines.push(format!(
                    "  abox       [warn]  unexpected version output: {raw}  (expected `abox X.Y.Z` where X.Y.Z ≥ {})",
                    fmt_version(MIN_ABOX_VERSION),
                ));
            }
        },
        Err(e) => {
            lines.push(format!(
                "  abox       [FAIL]  '{}' not runnable: {e}",
                config.abox_bin
            ));
        }
    }

    // Providers.
    for id in registry.list_ids() {
        let Some(spec) = registry.get(id) else {
            continue;
        };
        match probe_binary(&spec.binary).await {
            Some(version) => {
                lines.push(format!(
                    "  {:<10} [ ok ]  {}  ({})",
                    id, version, spec.binary
                ));
            }
            None => {
                lines.push(format!(
                    "  {:<10} [miss]  binary '{}' not found on PATH",
                    id, spec.binary
                ));
            }
        }
    }

    lines.push(String::from("────────────────────"));
    lines.join("\n")
}

async fn probe_binary(bin: &str) -> Option<String> {
    // Try `--version` first; fall back to `--help` first line.
    if let Ok(out) = Command::new(bin).arg("--version").output().await {
        if out.status.success() {
            let text = String::from_utf8_lossy(&out.stdout);
            let first = text.lines().next().unwrap_or("").trim();
            if !first.is_empty() {
                return Some(first.to_string());
            }
        }
    }
    if let Ok(out) = Command::new(bin).arg("--help").output().await {
        if out.status.success() {
            let text = String::from_utf8_lossy(&out.stdout);
            let first = text.lines().next().unwrap_or("").trim();
            if !first.is_empty() {
                return Some(first.to_string());
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn missing_binary_returns_none() {
        let v = probe_binary("definitely-not-a-real-binary-xyz-bakudo").await;
        assert!(v.is_none());
    }
}
