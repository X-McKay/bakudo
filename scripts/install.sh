#!/usr/bin/env bash
# bakudo install script. A thin wrapper around `pnpm install -g @bakudo/cli`
# that adds shell-profile detection, tarball checksum validation (when
# the tarball env vars are set), and version-management modes.
#
# Usage:
#   bakudo/scripts/install.sh [latest|prerelease|<version>]
#
# Environment variables:
#   BAKUDO_VERSION          — explicit version (`1.2.3` or `v1.2.3`). Optional.
#   BAKUDO_TARBALL          — URL of a prebuilt tarball. Optional.
#   BAKUDO_TARBALL_SHA256   — expected SHA-256 for BAKUDO_TARBALL. Required
#                             when BAKUDO_TARBALL is set.
#   BAKUDO_INSTALL_DRY=1    — print planned actions; do not execute.
#   BAKUDO_SKIP_PROFILE=1   — do not modify any shell profile file.

set -euo pipefail

log() { printf '[bakudo.install] %s\n' "$*"; }
warn() { printf '[bakudo.install] WARNING: %s\n' "$*" >&2; }
die()  { printf '[bakudo.install] ERROR: %s\n' "$*" >&2; exit 1; }

is_dry() { [ "${BAKUDO_INSTALL_DRY:-}" = "1" ]; }
skip_profile() { [ "${BAKUDO_SKIP_PROFILE:-}" = "1" ]; }

run() {
    if is_dry; then
        log "dry-run: $*"
    else
        log "run: $*"
        "$@"
    fi
}

# ---------------------------------------------------------------------------
# Version-management modes
# ---------------------------------------------------------------------------

normalize_version() {
    # Strip a leading v/V so `1.2.3` and `v1.2.3` are accepted equivalently.
    local raw="$1"
    printf '%s' "${raw#v}" | sed -E 's/^V//'
}

resolve_version_mode() {
    # Resolution order:
    #   1. BAKUDO_VERSION env var (explicit wins).
    #   2. CLI positional (latest | prerelease | <version>).
    #   3. Default: latest.
    local arg="${1:-}"
    if [ -n "${BAKUDO_VERSION:-}" ]; then
        printf 'explicit:%s' "$(normalize_version "${BAKUDO_VERSION}")"
        return
    fi
    case "${arg}" in
        ""|latest)
            printf 'latest'
            ;;
        prerelease)
            printf 'prerelease'
            ;;
        *)
            printf 'explicit:%s' "$(normalize_version "${arg}")"
            ;;
    esac
}

resolve_prerelease_version() {
    # Discover the newest prerelease tag from the bakudo repo. We rely
    # only on `git ls-remote --tags` so no GitHub API token is needed.
    local repo_url="${BAKUDO_REPO_URL:-https://github.com/X-McKay/bakudo.git}"
    local tags
    if ! command -v git >/dev/null 2>&1; then
        die "git is required to resolve prerelease versions"
    fi
    tags=$(git ls-remote --tags --refs "${repo_url}" 2>/dev/null \
        | awk '{print $2}' \
        | sed 's,refs/tags/,,' \
        | grep -E '^v?[0-9]+\.[0-9]+\.[0-9]+(-|$)' \
        | sort -V)
    # Prefer a prerelease tag (contains a hyphen) over a stable one.
    printf '%s' "${tags}" | grep -E -- '-' | tail -n 1
}

# ---------------------------------------------------------------------------
# Shell-profile detection
# ---------------------------------------------------------------------------

detect_shell_profile() {
    local shell_name="${SHELL##*/}"
    case "${shell_name}" in
        zsh)
            printf '%s/.zprofile' "${HOME}"
            ;;
        bash)
            if [ -f "${HOME}/.bash_profile" ]; then
                printf '%s/.bash_profile' "${HOME}"
            else
                printf '%s/.profile' "${HOME}"
            fi
            ;;
        fish)
            printf '%s/.config/fish/config.fish' "${HOME}"
            ;;
        *)
            printf '%s/.profile' "${HOME}"
            ;;
    esac
}

print_profile_fallback() {
    # Always printed so CI / unattended installs see the exact line they
    # should append to their shell profile if auto-editing is disabled.
    local profile="$1"
    cat <<EOF
[bakudo.install] If your shell cannot find bakudo after install, add this to
[bakudo.install] ${profile}:
[bakudo.install]
[bakudo.install]   export PATH="\$(pnpm bin -g):\$PATH"
[bakudo.install]
EOF
}

update_shell_profile() {
    # Only edit the profile file when stdin is a TTY AND BAKUDO_SKIP_PROFILE is unset.
    local profile="$1"
    if skip_profile; then
        log "BAKUDO_SKIP_PROFILE=1 — not modifying ${profile}"
        print_profile_fallback "${profile}"
        return
    fi
    if [ ! -t 0 ]; then
        log "stdin is not a TTY; skipping profile auto-edit"
        print_profile_fallback "${profile}"
        return
    fi
    local line='export PATH="$(pnpm bin -g):$PATH"'
    if [ -f "${profile}" ] && grep -Fq "${line}" "${profile}"; then
        log "PATH line already present in ${profile}"
        return
    fi
    if is_dry; then
        log "dry-run: would append PATH line to ${profile}"
    else
        printf '\n# bakudo: ensure pnpm global bin is on PATH\n%s\n' "${line}" >> "${profile}"
        log "appended PATH line to ${profile}"
    fi
}

# ---------------------------------------------------------------------------
# Checksum validation
# ---------------------------------------------------------------------------

compute_sha256() {
    local target="$1"
    if command -v shasum >/dev/null 2>&1; then
        shasum -a 256 "${target}" | awk '{print $1}'
    elif command -v sha256sum >/dev/null 2>&1; then
        sha256sum "${target}" | awk '{print $1}'
    else
        die "neither shasum nor sha256sum is available"
    fi
}

verify_tarball_checksum() {
    # No-op unless BAKUDO_TARBALL + BAKUDO_TARBALL_SHA256 are both set.
    local url="${BAKUDO_TARBALL:-}"
    local expected="${BAKUDO_TARBALL_SHA256:-}"
    if [ -z "${url}" ] && [ -z "${expected}" ]; then
        return 0
    fi
    if [ -z "${url}" ] || [ -z "${expected}" ]; then
        die "BAKUDO_TARBALL and BAKUDO_TARBALL_SHA256 must be set together"
    fi
    if is_dry; then
        log "dry-run: would download ${url} and verify against ${expected}"
        return 0
    fi
    local tmp
    tmp="$(mktemp -t bakudo-tarball.XXXXXX)"
    trap 'rm -f "${tmp}"' EXIT
    log "downloading ${url}"
    if ! curl -fsSL "${url}" -o "${tmp}"; then
        die "failed to download ${url}"
    fi
    local actual
    actual="$(compute_sha256 "${tmp}")"
    if [ "${actual}" != "${expected}" ]; then
        die "checksum mismatch: expected ${expected}, got ${actual}"
    fi
    log "checksum OK (${actual})"
}

# ---------------------------------------------------------------------------
# Main flow
# ---------------------------------------------------------------------------

main() {
    local mode
    mode="$(resolve_version_mode "${1:-}")"

    local resolved_version=""
    case "${mode}" in
        latest)
            log "install mode: latest"
            resolved_version="latest"
            ;;
        prerelease)
            log "install mode: prerelease"
            resolved_version="$(resolve_prerelease_version)"
            if [ -z "${resolved_version}" ]; then
                die "no prerelease tag resolved"
            fi
            log "resolved prerelease version: ${resolved_version}"
            ;;
        explicit:*)
            resolved_version="${mode#explicit:}"
            log "install mode: explicit (${resolved_version})"
            ;;
        *)
            die "internal: unrecognized mode token: ${mode}"
            ;;
    esac

    verify_tarball_checksum

    if ! command -v pnpm >/dev/null 2>&1; then
        die "pnpm is required — install pnpm (https://pnpm.io) and rerun"
    fi

    local spec="@bakudo/cli"
    case "${resolved_version}" in
        ""|latest)
            : # Default spec resolves to latest.
            ;;
        *)
            spec="@bakudo/cli@${resolved_version}"
            ;;
    esac
    run pnpm install -g "${spec}"

    local profile
    profile="$(detect_shell_profile)"
    update_shell_profile "${profile}"

    log "done. Run \`bakudo doctor\` to verify the install."
}

main "$@"
