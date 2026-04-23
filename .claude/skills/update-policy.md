# Skill: Update Provider or Policy Configuration in Bakudo

## Trigger

When asked to add a new provider, change provider invocation flags, or
update the default configuration schema in `bakudo`.

## Process

### Adding or updating classic provider registry behavior

1. Open `crates/bakudo-core/src/provider.rs`.
2. Add or update the `ProviderSpec` entry in `ProviderRegistry::with_defaults()`.
3. Implement `build_args()` to return the correct non-interactive CLI flags
   for the classic one-shot execution path. The prompt is wrapped and passed
   through `ProviderSpec::build_worker_command(...)`; do not invent a second
   prompt transport.
4. Add a unit test asserting the non-interactive flag is present:
   ```rust
   #[test]
   fn my_provider_non_interactive_flag() {
       let reg = ProviderRegistry::with_defaults();
       let spec = reg.get("myprovider").unwrap();
       let args = spec.build_args(None, true);
       assert!(args.iter().any(|a| a == "-p" || a == "--non-interactive"));
   }
   ```
5. Run `just check`.

### Adding or updating mission-runtime provider defaults

1. Open `crates/bakudo-daemon/src/provider_runtime.rs`.
2. Update the default provider TOML or prompt files under:
   - `crates/bakudo-daemon/data/providers/`
   - `crates/bakudo-daemon/data/prompts/`
3. Keep `wake_budget`, posture, and prompt guidance aligned with the current
   tool surface and Mission State terminology.
4. Add or update runtime coverage in `tests/runtime.rs`.
5. Run `just check`.

### Updating the default config schema

1. Open `crates/bakudo-core/src/config.rs`.
2. Update the `BakudoConfig` struct and its `Default` implementation.
3. Update `README.md` and `docs/current-architecture.md` to reflect the
   new config key or policy behavior.
4. Run `just check`.

## Quality Gate

`just check` must pass with zero errors and zero warnings.
