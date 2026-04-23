use std::process::Stdio;

use bakudo_core::config::BakudoConfig;
use bakudo_core::hook::PostRunHookPayload;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

pub async fn run_post_run_hook(
    config: &BakudoConfig,
    payload: &PostRunHookPayload,
) -> anyhow::Result<()> {
    let Some(command) = config.post_run_hook.as_ref() else {
        return Ok(());
    };
    let Some(program) = command.first() else {
        return Ok(());
    };

    let mut child = Command::new(program);
    if command.len() > 1 {
        child.args(&command[1..]);
    }
    child.stdin(Stdio::piped());
    child.stdout(Stdio::null());
    child.stderr(Stdio::piped());

    let mut child = child.spawn()?;
    if let Some(stdin) = child.stdin.as_mut() {
        let json = serde_json::to_vec(payload)?;
        stdin.write_all(&json).await?;
    }
    let output = child.wait_with_output().await?;
    if output.status.success() {
        Ok(())
    } else {
        anyhow::bail!(
            "post-run hook failed (exit {:?}): {}",
            output.status.code(),
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
}
