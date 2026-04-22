//! Integration tests for bakudo-core.
//!
//! These tests exercise the abox adapter, provider registry, state ledger,
//! and slash command parser without requiring a real abox binary.

#[cfg(test)]
mod abox_adapter_tests {
    use bakudo_core::abox::sandbox_task_id;

    #[test]
    fn sandbox_task_id_is_stable() {
        let id1 = sandbox_task_id("attempt-abc-123");
        let id2 = sandbox_task_id("attempt-abc-123");
        assert_eq!(id1, id2);
        assert!(id1.starts_with("bakudo-"));
    }

    #[test]
    fn sandbox_task_id_sanitises_special_chars() {
        let id = sandbox_task_id("attempt/with spaces@and#symbols");
        assert!(!id.contains(' '));
        assert!(!id.contains('/'));
        assert!(!id.contains('@'));
    }
}

#[cfg(test)]
mod provider_registry_tests {
    use bakudo_core::provider::ProviderRegistry;

    #[test]
    fn all_default_providers_have_non_interactive_args() {
        let reg = ProviderRegistry::with_defaults();
        for id in reg.list_ids() {
            let spec = reg.get(id).unwrap();
            assert!(
                !spec.non_interactive_args.is_empty(),
                "Provider '{}' has no non_interactive_args",
                id
            );
        }
    }

    #[test]
    fn claude_uses_print_flag() {
        let reg = ProviderRegistry::with_defaults();
        let claude = reg.get("claude").unwrap();
        assert!(claude.non_interactive_args.contains(&"-p".to_string()));
    }

    #[test]
    fn codex_uses_exec_subcommand() {
        let reg = ProviderRegistry::with_defaults();
        let codex = reg.get("codex").unwrap();
        assert!(codex.non_interactive_args.contains(&"exec".to_string()));
    }

    #[test]
    fn opencode_uses_run_subcommand() {
        let reg = ProviderRegistry::with_defaults();
        let opencode = reg.get("opencode").unwrap();
        assert!(opencode.non_interactive_args.contains(&"run".to_string()));
    }

    #[test]
    fn set_default_and_get() {
        let mut reg = ProviderRegistry::with_defaults();
        reg.set_default("codex").unwrap();
        assert_eq!(reg.default_provider_id(), "codex");
    }
}

#[cfg(test)]
mod state_ledger_tests {
    use bakudo_core::abox::SandboxEntry;
    use bakudo_core::protocol::{AttemptId, CandidatePolicy, SandboxLifecycle, SessionId};
    use bakudo_core::state::{SandboxLedger, SandboxRecord, SandboxState};
    use chrono::Utc;

    fn make_record(task_id: &str, state: SandboxState) -> SandboxRecord {
        SandboxRecord {
            attempt_id: AttemptId(format!("attempt-{task_id}")),
            session_id: SessionId("session-test".to_string()),
            task_id: task_id.to_string(),
            provider_id: "claude".to_string(),
            model: String::new(),
            prompt_summary: "integration test".to_string(),
            state,
            lifecycle: SandboxLifecycle::Preserved,
            candidate_policy: CandidatePolicy::Review,
            started_at: Utc::now(),
            finished_at: None,
            worktree_path: None,
            branch: None,
        }
    }

    #[tokio::test]
    async fn active_returns_only_running() {
        let ledger = SandboxLedger::new();
        ledger.insert(make_record("t1", SandboxState::Running)).await;
        ledger.insert(make_record("t2", SandboxState::Preserved)).await;
        ledger.insert(make_record("t3", SandboxState::Starting)).await;

        let active = ledger.active().await;
        assert_eq!(active.len(), 2);
        let ids: Vec<&str> = active.iter().map(|r| r.task_id.as_str()).collect();
        assert!(ids.contains(&"t1"));
        assert!(ids.contains(&"t3"));
    }

    #[tokio::test]
    async fn update_state_sets_finished_at() {
        let ledger = SandboxLedger::new();
        ledger.insert(make_record("t1", SandboxState::Running)).await;
        ledger.update_state("t1", SandboxState::Preserved).await;

        let record = ledger.get("t1").await.unwrap();
        assert_eq!(record.state, SandboxState::Preserved);
        assert!(record.finished_at.is_some());
    }

    #[tokio::test]
    async fn reconcile_only_affects_running() {
        let ledger = SandboxLedger::new();
        ledger.insert(make_record("running-ok", SandboxState::Running)).await;
        ledger.insert(make_record("ghost", SandboxState::Running)).await;
        ledger.insert(make_record("preserved", SandboxState::Preserved)).await;

        let entries = vec![SandboxEntry {
            id: "running-ok".to_string(),
            branch: "agent/running-ok".to_string(),
            vm_state: "running".to_string(),
            vm_pid: "1234".to_string(),
            commits_ahead: "0".to_string(),
        }];

        ledger.reconcile(&entries).await;

        assert_eq!(ledger.get("running-ok").await.unwrap().state, SandboxState::Running);
        assert!(matches!(ledger.get("ghost").await.unwrap().state, SandboxState::Failed { .. }));
        // Preserved should NOT be changed.
        assert_eq!(ledger.get("preserved").await.unwrap().state, SandboxState::Preserved);
    }
}

#[cfg(test)]
mod slash_command_tests {
    use bakudo_tui::commands::{parse_slash, SlashCommand};

    #[test]
    fn all_providers_parseable() {
        for id in &["claude", "codex", "opencode", "gemini"] {
            let cmd = parse_slash(&format!("/provider {id}")).unwrap();
            assert_eq!(cmd, SlashCommand::SetProvider(id.to_string()));
        }
    }

    #[test]
    fn model_with_spaces_in_name() {
        let cmd = parse_slash("/model claude opus 4").unwrap();
        // The full remainder after /model is the model name (spaces allowed).
        assert_eq!(cmd, SlashCommand::SetModel("claude opus 4".to_string()));
    }

    #[test]
    fn apply_and_discard() {
        assert_eq!(
            parse_slash("/apply bakudo-attempt-abc"),
            Some(SlashCommand::Apply("bakudo-attempt-abc".to_string()))
        );
        assert_eq!(
            parse_slash("/discard bakudo-attempt-xyz"),
            Some(SlashCommand::Discard("bakudo-attempt-xyz".to_string()))
        );
    }
}
