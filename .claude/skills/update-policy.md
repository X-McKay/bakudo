# Skill: Update Provider or Policy Configuration in Bakudo

## Trigger

When asked to add a new provider, change provider invocation flags, or
update the default configuration schema in `bakudo`.

## Process

### Adding or updating a provider

1. Open `crates/bakudo-core/src/provider.rs`.
2. Add or update the `ProviderSpec` entry in `ProviderRegistry::default()`.
3. Implement `build_args()` to return the correct **non-interactive** CLI
   flags. Refer to the provider's official documentation:
   - Claude Code: `claude -p <prompt>` (non-interactive print mode)
   - Codex: `codex exec --full-auto -q <prompt>`
   - OpenCode: `opencode run -q <prompt>`
   - Gemini CLI: `gemini -p <prompt>`
4. Add a unit test asserting the non-interactive flag is present:
   ```rust
   #[test]
   fn my_provider_non_interactive_flag() {
       let reg = ProviderRegistry::default();
       let spec = reg.get("myprovider").unwrap();
       let args = spec.build_args(&None, true);
       assert!(args.iter().any(|a| a == "-p" || a == "--non-interactive"));
   }
   ```
5. Run `just check`.

### Updating the default config schema

1. Open `crates/bakudo-core/src/config.rs`.
2. Update the `BakudoConfig` struct and its `Default` implementation.
3. Update `docs/bakudo-v2-architecture-revised-plan.md` to reflect the
   new config key.
4. Run `just check`.

## Quality Gate

`just check` must pass with zero errors and zero warnings.
