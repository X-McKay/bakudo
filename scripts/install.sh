#!/usr/bin/env bash
# install.sh — one-command installer for bakudo.
#
# Downloads the latest (or specified) bakudo release bundle from GitHub,
# verifies checksums, and installs the CLI wrappers to ~/.bakudo/bin.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/X-McKay/bakudo/main/scripts/install.sh | bash
#   BAKUDO_VERSION=v0.1.0 bash install.sh
#   BAKUDO_INSTALL_DIR=/usr/local/bin bash install.sh

set -euo pipefail

REPO="X-McKay/bakudo"
INSTALL_DIR="${BAKUDO_INSTALL_DIR:-$HOME/.bakudo/bin}"
RELEASES_DIR="${BAKUDO_RELEASES_DIR:-$HOME/.bakudo/releases}"
ASSET_NAME="${BAKUDO_ASSET_NAME:-bakudo-cli.tar.gz}"

log() { printf '[bakudo.install] %s\n' "$*"; }
die() { printf '[bakudo.install] ERROR: %s\n' "$*" >&2; exit 1; }

is_dry() { [ "${BAKUDO_INSTALL_DRY:-}" = "1" ]; }

normalize_version_tag() {
    local raw="$1"
    local stripped="${raw#v}"
    printf 'v%s' "${stripped}"
}

normalize_version_dir() {
    local raw="$1"
    printf '%s' "${raw#v}"
}

resolve_version_mode() {
    local arg="${1:-}"
    if [ -n "${BAKUDO_VERSION:-}" ]; then
        printf 'explicit:%s' "$(normalize_version_tag "${BAKUDO_VERSION}")"
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
            printf 'explicit:%s' "$(normalize_version_tag "${arg}")"
            ;;
    esac
}

resolve_prerelease_version() {
    local repo_url="${BAKUDO_REPO_URL:-https://github.com/X-McKay/bakudo.git}"
    command -v git >/dev/null 2>&1 || die "git is required to resolve prerelease versions"
    local tags
    tags="$(git ls-remote --tags --refs "${repo_url}" 2>/dev/null \
        | awk '{print $2}' \
        | sed 's,refs/tags/,,' \
        | grep -E '^v?[0-9]+\.[0-9]+\.[0-9]+(-|$)' \
        | sort -V)"
    local resolved
    resolved="$(printf '%s' "${tags}" | grep -E -- '-' | tail -n 1)"
    [ -n "${resolved}" ] || die "no prerelease tag resolved"
    normalize_version_tag "${resolved}"
}

resolve_latest_version() {
    local api_url="https://api.github.com/repos/${REPO}/releases/latest"
    local api_response
    api_response="$(curl -fsSL "${api_url}" 2>/dev/null || true)"
    local version
    version="$(printf '%s' "${api_response}" | grep '"tag_name"' | head -n 1 | cut -d'"' -f4)"
    if [ -z "${version}" ]; then
        cat >&2 <<'EOF'

No published release of bakudo was found.

To install from source:

  git clone https://github.com/X-McKay/bakudo.git
  cd bakudo
  pnpm install
  pnpm install:cli

To build a local release bundle instead:

  pnpm install
  just release-bundle

Once a release is published, rerun this script or pin a version:
  BAKUDO_VERSION=v0.1.0 bash install.sh
EOF
        exit 1
    fi
    normalize_version_tag "${version}"
}

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

verify_checksum() {
    local asset_path="$1"
    local sums_path="$2"
    local expected
    expected="$(awk -v asset="${ASSET_NAME}" '$2 == asset { print $1 }' "${sums_path}")"
    [ -n "${expected}" ] || die "no checksum entry found for ${ASSET_NAME}"
    local actual
    actual="$(compute_sha256 "${asset_path}")"
    [ "${actual}" = "${expected}" ] || die "checksum mismatch for ${ASSET_NAME}: expected ${expected}, got ${actual}"
}

require_node() {
    command -v node >/dev/null 2>&1 || die "node is required (v22 or later)"
    local version
    version="$(node -p 'process.versions.node' 2>/dev/null || true)"
    [ -n "${version}" ] || die "failed to determine installed node version"
    local major="${version%%.*}"
    case "${major}" in
        ''|*[!0-9]*)
            die "unexpected node version: ${version}"
            ;;
    esac
    [ "${major}" -ge 22 ] || die "node ${version} found; bakudo requires node v22 or later"
}

print_path_hint() {
    echo "Add bakudo to your PATH:"
    echo "  export PATH=\"${INSTALL_DIR}:\$PATH\""
}

main() {
    command -v curl >/dev/null 2>&1 || die "curl is required"
    command -v tar >/dev/null 2>&1 || die "tar is required"
    require_node

    local mode
    mode="$(resolve_version_mode "${1:-}")"

    local version_tag=""
    case "${mode}" in
        latest)
            log "install mode: latest"
            if is_dry; then
                log "dry-run: would resolve the latest release from GitHub"
                version_tag="v0.0.0-dry-run"
            else
                version_tag="$(resolve_latest_version)"
                log "resolved latest release: ${version_tag}"
            fi
            ;;
        prerelease)
            log "install mode: prerelease"
            if is_dry; then
                log "dry-run: would resolve the newest prerelease tag from GitHub"
                version_tag="v0.0.0-dry-run-prerelease"
            else
                version_tag="$(resolve_prerelease_version)"
                log "resolved prerelease version: ${version_tag}"
            fi
            ;;
        explicit:*)
            version_tag="${mode#explicit:}"
            log "install mode: explicit (${version_tag})"
            ;;
        *)
            die "internal: unrecognized mode token: ${mode}"
            ;;
    esac

    local version_dir_name
    version_dir_name="$(normalize_version_dir "${version_tag}")"
    local version_dir="${RELEASES_DIR}/${version_dir_name}"
    local base_url="${BAKUDO_BASE_URL:-https://github.com/${REPO}/releases/download/${version_tag}}"

    if is_dry; then
        log "dry-run: would download ${ASSET_NAME} from ${base_url}/${ASSET_NAME}"
        log "dry-run: would download SHA256SUMS from ${base_url}/SHA256SUMS"
        log "dry-run: would verify checksums"
        log "dry-run: would extract into ${version_dir}"
        log "dry-run: would link ${INSTALL_DIR}/bakudo -> ${version_dir}/bin/bakudo"
        log "dry-run: would link ${INSTALL_DIR}/bakudo-worker -> ${version_dir}/bin/bakudo-worker"
        echo
        print_path_hint
        echo
        echo "Then run 'bakudo doctor' to verify the install."
        return 0
    fi

    local tmp_dir
    tmp_dir="$(mktemp -d)"
    trap "rm -rf -- \"${tmp_dir}\"" EXIT

    log "downloading ${ASSET_NAME}"
    curl -fsSL -o "${tmp_dir}/${ASSET_NAME}" "${base_url}/${ASSET_NAME}"
    log "downloading SHA256SUMS"
    curl -fsSL -o "${tmp_dir}/SHA256SUMS" "${base_url}/SHA256SUMS"
    log "verifying checksums"
    verify_checksum "${tmp_dir}/${ASSET_NAME}" "${tmp_dir}/SHA256SUMS"

    mkdir -p "${INSTALL_DIR}" "${RELEASES_DIR}"
    local staging_dir="${RELEASES_DIR}/.${version_dir_name}.tmp.$$"
    rm -rf "${staging_dir}" "${version_dir}"
    mkdir -p "${staging_dir}"
    tar xzf "${tmp_dir}/${ASSET_NAME}" -C "${staging_dir}"
    mv "${staging_dir}" "${version_dir}"

    ln -sfn "${version_dir}/bin/bakudo" "${INSTALL_DIR}/bakudo"
    ln -sfn "${version_dir}/bin/bakudo-worker" "${INSTALL_DIR}/bakudo-worker"

    echo
    echo "bakudo ${version_tag} installed successfully."
    echo
    echo "  CLI:      ${INSTALL_DIR}/bakudo"
    echo "  Worker:   ${INSTALL_DIR}/bakudo-worker"
    echo "  Release:  ${version_dir}"
    echo
    if [[ ":${PATH}:" == *":${INSTALL_DIR}:"* ]]; then
        echo "Run 'bakudo doctor' to verify the install."
    else
        print_path_hint
        echo
        echo "Then run 'bakudo doctor' to verify the install."
    fi
}

main "$@"
