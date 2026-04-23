set shell := ["bash", "-c"]

# Default recipe: run all checks (matches abox's convention).
default: check

# ─── Development ─────────────────────────────────────────────────────────────

# Build the project (debug).
build:
    cargo build

# Build the project (release).
release:
    cargo build --release

# Run all tests across the workspace.
test:
    cargo test --workspace

# Run all tests with output shown (useful when debugging a failing test).
test-verbose:
    cargo test --workspace -- --nocapture

# Run clippy with strict warnings.
lint:
    cargo clippy --workspace --all-targets -- -D warnings

# Check formatting without modifying files.
fmt-check:
    cargo fmt --all -- --check

# Format all source files.
fmt:
    cargo fmt --all

# Full local check: format, lint, test.
check: fmt-check lint test

# ─── Quality ─────────────────────────────────────────────────────────────────

# Supply-chain audit (install: cargo install --locked cargo-deny).
deny:
    cargo deny check

# Everything CI runs: fmt + clippy + test + supply-chain audit.
ci: check deny

# Alias of `ci` for symmetry with abox's tiered naming.
tier-ci: ci

# ─── Installation ────────────────────────────────────────────────────────────

# Install the bakudo binary from this checkout into ~/.cargo/bin.
install:
    cargo install --path . --force
    @echo
    @echo "installed: $(which bakudo)"
    @bakudo --version

# ─── Integration & smoke ─────────────────────────────────────────────────────

# Run the Rust e2e test suite against a real abox (requires abox on PATH).
tier-integration:
    ./scripts/local/integration_test.sh

# Dispatch real prompts through provider CLIs (requires credentials; costs tokens).
tier-smoke:
    ./scripts/local/agent_smoke_test.sh

# ─── Documentation ───────────────────────────────────────────────────────────

# Generate and open rustdoc.
doc:
    cargo doc --workspace --no-deps --open

# Generate rustdoc without opening.
doc-build:
    cargo doc --workspace --no-deps

# ─── Utilities ───────────────────────────────────────────────────────────────

# Count lines of code (install: cargo install tokei).
loc:
    tokei crates/ src/

# Show dependency tree.
deps:
    cargo tree --workspace

# Check for outdated dependencies (install: cargo install --locked cargo-outdated).
outdated:
    cargo outdated --workspace

# ─── Cleanup ─────────────────────────────────────────────────────────────────

# Remove build artifacts.
clean:
    cargo clean

# ─── Git hooks ───────────────────────────────────────────────────────────────

# Install the git pre-commit hook (runs `just check` before every commit).
hooks-install:
    mise run hooks:install

# ─── Metadata ────────────────────────────────────────────────────────────────

# Show the current workspace version.
version:
    cargo metadata --no-deps --format-version 1 | python3 -c \
        "import json,sys; pkgs=json.load(sys.stdin)['packages']; \
         root=[p for p in pkgs if p['name']=='bakudo'][0]; \
         print(root['version'])"
