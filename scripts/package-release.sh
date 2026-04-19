#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUTPUT_DIR="${BAKUDO_RELEASE_OUTPUT_DIR:-$ROOT_DIR/dist/release}"
ASSET_NAME="${BAKUDO_RELEASE_ASSET_NAME:-bakudo-cli.tar.gz}"

log() { printf '[bakudo.release] %s\n' "$*"; }
die() { printf '[bakudo.release] ERROR: %s\n' "$*" >&2; exit 1; }

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

write_wrapper() {
    local target="$1"
    local module_path="$2"
    cat > "${target}" <<EOF
#!/usr/bin/env bash
set -euo pipefail

SELF="\${BASH_SOURCE[0]}"
if command -v readlink >/dev/null 2>&1; then
    RESOLVED_SELF="\$(readlink -f "\${SELF}" 2>/dev/null || true)"
    if [ -n "\${RESOLVED_SELF}" ]; then
        SELF="\${RESOLVED_SELF}"
    fi
fi

SCRIPT_DIR="\$(cd "\$(dirname "\${SELF}")" && pwd)"
APP_DIR="\$(cd "\${SCRIPT_DIR}/.." && pwd)"

exec node "\${APP_DIR}/${module_path}" "\$@"
EOF
    chmod 755 "${target}"
}

command -v pnpm >/dev/null 2>&1 || die "pnpm is required"
command -v node >/dev/null 2>&1 || die "node is required"
command -v tar >/dev/null 2>&1 || die "tar is required"

STAGE_ROOT="$(mktemp -d)"
trap 'rm -rf "${STAGE_ROOT}"' EXIT

BUNDLE_DIR="${STAGE_ROOT}/bakudo-cli"

log "building bakudo"
(cd "${ROOT_DIR}" && pnpm build)

mkdir -p "${BUNDLE_DIR}/bin" "${BUNDLE_DIR}/docs"
cp -R "${ROOT_DIR}/dist" "${BUNDLE_DIR}/dist"
cp -R "${ROOT_DIR}/docs/help" "${BUNDLE_DIR}/docs/help"
cp "${ROOT_DIR}/package.json" "${ROOT_DIR}/pnpm-lock.yaml" "${ROOT_DIR}/README.md" "${ROOT_DIR}/LICENSE" "${BUNDLE_DIR}/"

log "installing production dependencies into bundle"
(cd "${BUNDLE_DIR}" && pnpm install --prod --frozen-lockfile --ignore-scripts)

write_wrapper "${BUNDLE_DIR}/bin/bakudo" "dist/src/cli.js"
write_wrapper "${BUNDLE_DIR}/bin/bakudo-worker" "dist/src/workerCli.js"

mkdir -p "${OUTPUT_DIR}"
log "writing ${ASSET_NAME}"
tar czf "${OUTPUT_DIR}/${ASSET_NAME}" -C "${BUNDLE_DIR}" .

checksum="$(compute_sha256 "${OUTPUT_DIR}/${ASSET_NAME}")"
printf '%s  %s\n' "${checksum}" "${ASSET_NAME}" > "${OUTPUT_DIR}/SHA256SUMS"

log "bundle ready"
printf '  asset: %s\n' "${OUTPUT_DIR}/${ASSET_NAME}"
printf '  sums:  %s\n' "${OUTPUT_DIR}/SHA256SUMS"
