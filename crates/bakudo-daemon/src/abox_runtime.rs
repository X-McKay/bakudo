//! Bakudo-owned abox runtime config materializer.
//!
//! Bakudo ships its own abox config + proxy policy as embedded data and
//! materializes them under `<bakudo-data-root>/abox-runtime/` on
//! startup. The `AboxAdapter` is then constructed with `--config
//! <materialized>` so every sandbox bakudo dispatches uses the
//! bakudo-owned policy regardless of what the operator's own
//! `~/.abox/config.toml` says.
//!
//! Why this exists: the proxy policy (which CLI commands and egress
//! domains are allowed) is part of bakudo's runtime contract. Workers
//! need pypi to bootstrap pip, mission tools need git push to talk to
//! origin, etc. Pinning the policy in the bakudo source tree means
//! reviewers see policy changes in bakudo PRs and the abox repo's
//! shipped default doesn't have to track every bakudo runtime
//! requirement.
//!
//! Direct `abox run` use by other tools on the same host is unaffected
//! because we override the config path per-invocation rather than
//! mutating `~/.abox/`.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};

const ABOX_CONFIG_TEMPLATE: &str = include_str!("../data/abox-runtime/abox-config.toml");
const ABOX_POLICY_DEFAULT: &str = include_str!("../data/abox-runtime/policies/default.toml");
const POLICY_DIR_PLACEHOLDER: &str = "{POLICY_DIR}";

/// Bakudo's materialized abox runtime assets.
///
/// Constructed via [`ensure_materialized`]. The held [`config_path`] is
/// what bakudo passes to `abox --config` on every sandbox invocation.
#[derive(Debug, Clone)]
pub struct AboxRuntimeAssets {
    config_path: PathBuf,
    policy_dir: PathBuf,
}

impl AboxRuntimeAssets {
    /// Materialize bakudo's abox config + policy under
    /// `<data_root>/abox-runtime/`, rewriting the policy_dir placeholder
    /// in the config to an absolute path on the local filesystem.
    ///
    /// Idempotent: if the on-disk file already matches the embedded
    /// content (and config's expanded policy_dir), nothing is written.
    /// Mismatched content (e.g. an older bakudo version's policy left
    /// behind) is overwritten — the embedded copy wins.
    pub fn ensure_materialized(data_root: &Path) -> Result<Self> {
        let runtime_dir = data_root.join("abox-runtime");
        let policy_dir = runtime_dir.join("policies");
        let policy_path = policy_dir.join("default.toml");
        let config_path = runtime_dir.join("abox-config.toml");

        std::fs::create_dir_all(&policy_dir).with_context(|| {
            format!(
                "creating bakudo abox runtime dir '{}'",
                policy_dir.display()
            )
        })?;

        // Materialize the policy first so the config's policy_dir is
        // pointing at something that already exists when abox loads it.
        write_if_changed(&policy_path, ABOX_POLICY_DEFAULT)?;

        // Bake the absolute policy_dir into the config. We use the
        // absolute (but un-canonicalized) path so the config text stays
        // stable across sessions even if `data_root` happens to be a
        // symlink — canonicalize would write the symlink target, which
        // would invalidate the cache check on subsequent runs whenever
        // the symlink target changes.
        let abs_policy_dir = absolute_path(&policy_dir)?;
        let config_content = ABOX_CONFIG_TEMPLATE.replace(
            POLICY_DIR_PLACEHOLDER,
            abs_policy_dir.to_str().ok_or_else(|| {
                anyhow::anyhow!(
                    "abox runtime policy_dir '{}' is not valid UTF-8",
                    abs_policy_dir.display(),
                )
            })?,
        );
        write_if_changed(&config_path, &config_content)?;

        Ok(Self {
            config_path,
            policy_dir,
        })
    }

    /// Path to pass on `abox --config <path>`.
    pub fn config_path(&self) -> &Path {
        &self.config_path
    }

    /// Directory containing the materialized policy file. Useful for
    /// `bakudo doctor` output and operator orientation.
    pub fn policy_dir(&self) -> &Path {
        &self.policy_dir
    }
}

fn write_if_changed(path: &Path, expected: &str) -> Result<()> {
    let current = match std::fs::read_to_string(path) {
        Ok(text) => Some(text),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => {
            return Err(e).with_context(|| {
                format!(
                    "reading existing bakudo abox runtime asset '{}'",
                    path.display()
                )
            });
        }
    };
    if current.as_deref() == Some(expected) {
        return Ok(());
    }
    std::fs::write(path, expected)
        .with_context(|| format!("writing bakudo abox runtime asset '{}'", path.display()))?;
    Ok(())
}

/// Resolve `path` against the current working directory if it is
/// relative, without canonicalizing. Mirrors `std::path::absolute` from
/// stable Rust 1.79+ but stays compatible with the workspace's
/// minimum supported toolchain.
fn absolute_path(path: &Path) -> Result<PathBuf> {
    if path.is_absolute() {
        return Ok(path.to_path_buf());
    }
    let cwd = std::env::current_dir()
        .with_context(|| "resolving cwd for bakudo abox runtime policy_dir")?;
    Ok(cwd.join(path))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    /// stdlib-only scratch directory. Workspace doesn't pull in
    /// `tempfile`, and this module is the only daemon code that needs a
    /// disposable directory for tests.
    struct ScratchDir {
        path: PathBuf,
    }

    impl ScratchDir {
        fn new() -> Self {
            static COUNTER: AtomicU64 = AtomicU64::new(0);
            let id = COUNTER.fetch_add(1, Ordering::Relaxed);
            let pid = std::process::id();
            let path = std::env::temp_dir().join(format!("bakudo-abox-runtime-test-{pid}-{id}"));
            std::fs::create_dir_all(&path).unwrap();
            Self { path }
        }

        fn path(&self) -> &Path {
            &self.path
        }
    }

    impl Drop for ScratchDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }

    #[test]
    fn materializes_config_and_policy_with_resolved_policy_dir() {
        let tmp = ScratchDir::new();
        let assets = AboxRuntimeAssets::ensure_materialized(tmp.path()).unwrap();

        let config_path = tmp.path().join("abox-runtime/abox-config.toml");
        let policy_path = tmp.path().join("abox-runtime/policies/default.toml");
        assert_eq!(assets.config_path(), config_path);
        assert!(
            policy_path.exists(),
            "policy default.toml must be materialized"
        );

        // Policy content is the embedded shipped copy.
        let policy = std::fs::read_to_string(&policy_path).unwrap();
        assert!(policy.contains("Bakudo-owned abox proxy policy"));
        assert!(policy.contains("pypi.org"));

        // Config has the placeholder expanded to an absolute policy dir
        // pointing at our materialized policies directory.
        let config = std::fs::read_to_string(&config_path).unwrap();
        assert!(!config.contains(POLICY_DIR_PLACEHOLDER));
        assert!(
            config.contains(assets.policy_dir().to_str().unwrap()),
            "config must reference the absolute policy dir; got\n{config}",
        );
    }

    #[test]
    fn rerunning_with_unchanged_assets_does_not_rewrite() {
        let tmp = ScratchDir::new();
        AboxRuntimeAssets::ensure_materialized(tmp.path()).unwrap();
        let policy_path = tmp.path().join("abox-runtime/policies/default.toml");
        let mtime_before = std::fs::metadata(&policy_path).unwrap().modified().unwrap();

        // Sleep above filesystem mtime resolution so an unwanted write
        // would be visible.
        std::thread::sleep(std::time::Duration::from_millis(50));
        AboxRuntimeAssets::ensure_materialized(tmp.path()).unwrap();
        let mtime_after = std::fs::metadata(&policy_path).unwrap().modified().unwrap();
        assert_eq!(
            mtime_before, mtime_after,
            "second materialize must be a no-op when content is unchanged"
        );
    }

    #[test]
    fn drifted_policy_is_overwritten_back_to_shipped_content() {
        let tmp = ScratchDir::new();
        AboxRuntimeAssets::ensure_materialized(tmp.path()).unwrap();
        let policy_path = tmp.path().join("abox-runtime/policies/default.toml");
        std::fs::write(&policy_path, "default_cli_action = \"allow\"\n").unwrap();

        AboxRuntimeAssets::ensure_materialized(tmp.path()).unwrap();
        let restored = std::fs::read_to_string(&policy_path).unwrap();
        assert!(restored.contains("Bakudo-owned abox proxy policy"));
        assert!(restored.contains("pypi.org"));
    }
}
