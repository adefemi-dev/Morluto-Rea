#!/usr/bin/env bash
# Setup script for a Claude Code cloud environment that uses REA with Ghidra.
#
# Paste this file's contents into the environment's "Setup script" field
# (claude.ai > cloud environment menu > Edit). It is not part of REA's
# installer: `rea setup` never installs Java or Ghidra, and this script is
# operator-owned environment provisioning for disposable cloud containers.
#
# What it does, idempotently. Each step runs on its own, so one failure (for
# example a blocked download) does not stop the others; a summary at the end
# lists every step's result:
#   1. Prerequisites: installs a full JDK 21 (with javac), procps (`ps`),
#      unzip, curl, and Python venv support through apt-get, only when they
#      are missing.
#   2. REA package: downloads rea-agents into the npm cache with the same
#      command `.mcp.json` uses, so the MCP server starts quickly.
#   3. pwntools: creates a Python environment at PWNTOOLS_VENV (default
#      /opt/rea-pwntools) with the exact versions REA's ELF layout adapter
#      requires (pwntools 4.15.0, pyelftools 0.33, unicorn 2.1.2).
#   4. Ghidra: downloads the official release archive from a GitHub release
#      (default: the operator's adefemi-dev/ghidra-dist mirror, because cloud
#      sessions can reach only repositories attached to them), verifies it
#      against the official SHA-256, extracts it under GHIDRA_PREFIX (default
#      /opt), and links ghidraRun into BIN_DIR (default /usr/local/bin).
#
# After it runs, add these environment variables in the same environment
# settings so the REA MCP server sees the installations:
#   GHIDRA_INSTALL_DIR=/opt/ghidra_12.1.4_PUBLIC
#   REA_PWNTOOLS_PYTHON=/opt/rea-pwntools/bin/python
# rea-agents 6.4.0 requires GHIDRA_INSTALL_DIR. Later releases also discover
# Ghidra through the ghidraRun PATH link when the variable is unset.
#
# The script exits 0 even when a step fails, so a blocked download cannot
# stop sessions from starting. Set STRICT=1 to exit 1 when any step fails.
#
# Optional overrides:
#   GHIDRA_VERSION   Ghidra release, default 12.1.4 (REA accepts 12.1.x and
#                    verifies its bridge with 12.1.4).
#   GHIDRA_RELEASE_REPO  GitHub owner/repo holding the release, default
#                    adefemi-dev/ghidra-dist. Use NationalSecurityAgency/ghidra
#                    where the official repository is reachable.
#   GHIDRA_RELEASE_TAG   Release tag, default v<version> for a mirror and
#                    Ghidra_<version>_build for NationalSecurityAgency/ghidra.
#   GHIDRA_SHA256    Expected archive SHA-256. Defaults to the official value
#                    pinned below for known versions; required otherwise.
#   GH_TOKEN         Optional GitHub token for a private release repository
#                    when no proxy supplies credentials. GITHUB_TOKEN is used
#                    when GH_TOKEN is unset. Never logged.
#   GHIDRA_ZIP       Absolute path to an already downloaded release archive.
#   GHIDRA_PREFIX    Extraction parent directory, default /opt.
#   BIN_DIR          Directory for the ghidraRun link, default /usr/local/bin.
#   REA_VERSION      rea-agents version to pre-download, default 6.4.0
#                    (keep it equal to the version pinned in .mcp.json).
#   PWNTOOLS_VENV    pwntools environment directory, default /opt/rea-pwntools.
#   SKIP_PWNTOOLS=1  Skip step 3.
set -euo pipefail

GHIDRA_VERSION="${GHIDRA_VERSION:-12.1.4}"
GHIDRA_PREFIX="${GHIDRA_PREFIX:-/opt}"
BIN_DIR="${BIN_DIR:-/usr/local/bin}"
REA_VERSION="${REA_VERSION:-6.4.0}"
PWNTOOLS_VENV="${PWNTOOLS_VENV:-/opt/rea-pwntools}"
PWNTOOLS_PINS=(pwntools==4.15.0 pyelftools==0.33 unicorn==2.1.2)
GHIDRA_DIR="${GHIDRA_PREFIX}/ghidra_${GHIDRA_VERSION}_PUBLIC"
GHIDRA_RELEASE_REPO="${GHIDRA_RELEASE_REPO:-adefemi-dev/ghidra-dist}"
if [ "$GHIDRA_RELEASE_REPO" = "NationalSecurityAgency/ghidra" ]; then
  GHIDRA_RELEASE_TAG="${GHIDRA_RELEASE_TAG:-Ghidra_${GHIDRA_VERSION}_build}"
else
  GHIDRA_RELEASE_TAG="${GHIDRA_RELEASE_TAG:-v${GHIDRA_VERSION}}"
fi
RELEASE_API="https://api.github.com/repos/${GHIDRA_RELEASE_REPO}/releases/tags/${GHIDRA_RELEASE_TAG}"

# Official archive checksums. A mirror's own digest only shows the upload was
# intact, so a mirrored archive must also match the official value.
official_sha256() {
  case "$1" in
    12.1.4) printf '%s\n' ddac49f903da9d5bac833e5cc79395098b9c33cfd3279be5f31bd00387d2d4db ;;
    *) return 1 ;;
  esac
}

WORK_DIR=""
cleanup() { [ -z "$WORK_DIR" ] || rm -rf "$WORK_DIR"; }
trap cleanup EXIT

# Progress goes to stderr so command substitutions capture only results.
log() { printf '[rea-cloud-setup] %s\n' "$*" >&2; }
die() {
  printf '[rea-cloud-setup] error: %s\n' "$*" >&2
  exit 1
}

as_root() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  elif command -v sudo >/dev/null 2>&1; then
    sudo "$@"
  else
    die "root privileges are required to run: $*"
  fi
}

ensure_packages() {
  local missing=()
  command -v javac >/dev/null 2>&1 || missing+=(openjdk-21-jdk-headless)
  command -v ps >/dev/null 2>&1 || missing+=(procps)
  command -v unzip >/dev/null 2>&1 || missing+=(unzip)
  command -v curl >/dev/null 2>&1 || missing+=(curl ca-certificates)
  command -v python3 >/dev/null 2>&1 || missing+=(python3)
  if [ "${SKIP_PWNTOOLS:-0}" != 1 ] && ! python3 -c 'import ensurepip, venv' >/dev/null 2>&1; then
    missing+=(python3-venv)
  fi
  if [ "${#missing[@]}" -eq 0 ]; then
    log "prerequisites present: javac, ps, unzip, curl, python3"
    return
  fi
  command -v apt-get >/dev/null 2>&1 || die "apt-get not found; install ${missing[*]} manually"
  log "installing ${missing[*]}"
  as_root env DEBIAN_FRONTEND=noninteractive apt-get update -qq
  as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends "${missing[@]}"
}

check_java_major() {
  local version major
  version="$(javac -version 2>&1 | awk '/^javac /{print $2; exit}')"
  major="${version%%.*}"
  case "$major" in
    '' | *[!0-9]*) die "could not read the javac version (got '${version}')" ;;
  esac
  [ "$major" -ge 21 ] || die "Ghidra ${GHIDRA_VERSION} needs JDK 21 or newer; javac reports ${version}"
  log "javac ${version}"
}

installed_version() {
  local props="${GHIDRA_DIR}/Ghidra/application.properties"
  [ -f "$props" ] || return 1
  sed -n 's/^application\.version=//p' "$props" | head -n 1
}

# GitHub API request, with GH_TOKEN (or else GITHUB_TOKEN) as a bearer token
# when one is set. A private mirror answers 404 to unauthenticated requests.
github_curl() {
  local auth=() token="${GH_TOKEN:-${GITHUB_TOKEN:-}}"
  [ -z "$token" ] || auth=(-H "Authorization: Bearer ${token}")
  curl -fSL --retry 3 ${auth[@]+"${auth[@]}"} "$@"
}

# Prints "<asset name> <API asset url> <sha256 or empty>" for the release zip.
# The API asset url also serves private repositories, unlike the browser url.
resolve_release_asset() {
  local release
  release="$(github_curl -s -H 'Accept: application/vnd.github+json' "$RELEASE_API")" || return 1
  printf '%s' "$release" | python3 -c '
import json, sys
release = json.load(sys.stdin)
version = sys.argv[1]
zips = [
    a for a in release.get("assets", [])
    if a.get("name", "").startswith("ghidra_%s_PUBLIC" % version)
    and a.get("name", "").endswith(".zip")
]
if len(zips) != 1:
    sys.exit("expected exactly one ghidra_%s_PUBLIC .zip asset, found %d" % (version, len(zips)))
asset = zips[0]
digest = asset.get("digest") or ""
sha = digest.split(":", 1)[1] if digest.startswith("sha256:") else ""
print(asset["name"], asset["url"], sha)
' "$GHIDRA_VERSION"
}

download_ghidra() {
  local work="$1" asset name url api_sha expected
  asset="$(resolve_release_asset)" ||
    die "could not resolve the Ghidra ${GHIDRA_VERSION} release asset from ${RELEASE_API}"
  read -r name url api_sha <<<"$asset"
  expected="${GHIDRA_SHA256:-$(official_sha256 "$GHIDRA_VERSION" || true)}"
  [ -n "$expected" ] || die "no official SHA-256 is pinned for Ghidra ${GHIDRA_VERSION}; set GHIDRA_SHA256 from the official release notes"
  if [ -n "$api_sha" ] && [ "$expected" != "$api_sha" ]; then
    die "${GHIDRA_RELEASE_REPO} reports SHA-256 ${api_sha} for ${name}, not the expected ${expected}"
  fi
  log "downloading ${name} from ${GHIDRA_RELEASE_REPO} ${GHIDRA_RELEASE_TAG}"
  github_curl -o "${work}/${name}" -H 'Accept: application/octet-stream' "$url"
  printf '%s\n' "$expected" >"${work}/expected.sha256"
  printf '%s\n' "${work}/${name}"
}

verify_sha256() {
  local zip="$1" expected="$2" actual
  actual="$(sha256sum "$zip" | awk '{print $1}')"
  [ "$actual" = "$expected" ] || die "SHA-256 mismatch for ${zip}: expected ${expected}, got ${actual}"
  log "SHA-256 verified: ${actual}"
}

install_ghidra() {
  local current work zip expected staged
  if current="$(installed_version)" && [ "$current" = "$GHIDRA_VERSION" ]; then
    log "Ghidra ${GHIDRA_VERSION} already installed at ${GHIDRA_DIR}"
    return
  fi
  [ ! -e "$GHIDRA_DIR" ] || die "${GHIDRA_DIR} exists but is not Ghidra ${GHIDRA_VERSION}; remove it first"

  WORK_DIR="$(mktemp -d)"
  trap cleanup EXIT
  work="$WORK_DIR"
  if [ -n "${GHIDRA_ZIP:-}" ]; then
    [ -f "$GHIDRA_ZIP" ] || die "GHIDRA_ZIP does not exist: ${GHIDRA_ZIP}"
    [ -n "${GHIDRA_SHA256:-}" ] || die "GHIDRA_SHA256 is required with GHIDRA_ZIP"
    zip="$GHIDRA_ZIP"
    expected="$GHIDRA_SHA256"
  else
    zip="$(download_ghidra "$work")"
    expected="$(cat "${work}/expected.sha256")"
  fi
  verify_sha256 "$zip" "$expected"

  staged="${work}/extract"
  mkdir -p "$staged"
  unzip -q "$zip" -d "$staged"
  [ -f "${staged}/ghidra_${GHIDRA_VERSION}_PUBLIC/Ghidra/application.properties" ] ||
    die "archive does not contain ghidra_${GHIDRA_VERSION}_PUBLIC/Ghidra/application.properties"
  as_root mkdir -p "$GHIDRA_PREFIX"
  as_root mv "${staged}/ghidra_${GHIDRA_VERSION}_PUBLIC" "$GHIDRA_DIR"
  log "installed Ghidra $(installed_version) at ${GHIDRA_DIR}"
}

link_launcher() {
  local target="${GHIDRA_DIR}/ghidraRun" link="${BIN_DIR}/ghidraRun"
  [ -x "$target" ] || die "missing launcher ${target}"
  if [ -L "$link" ] && [ "$(readlink "$link")" = "$target" ]; then
    log "${link} already points to ${target}"
    return
  fi
  [ ! -e "$link" ] || [ -L "$link" ] || die "${link} exists and is not a symlink; refusing to replace it"
  as_root mkdir -p "$BIN_DIR"
  as_root ln -sfn "$target" "$link"
  log "linked ${link} -> ${target}"
}

# Runs the same command .mcp.json uses so the package lands in the npm cache.
prewarm_rea() {
  command -v npx >/dev/null 2>&1 || die "npx not found; the MCP server will download REA on first start"
  (cd / && npx -y --prefix=/ "rea-agents@${REA_VERSION}" --version) >&2
  log "rea-agents ${REA_VERSION} is in the npm cache"
}

pwntools_ready() {
  [ -x "${PWNTOOLS_VENV}/bin/python" ] || return 1
  "${PWNTOOLS_VENV}/bin/python" - <<'PY' >/dev/null 2>&1
from importlib.metadata import version
assert version("pwntools") == "4.15.0"
assert version("pyelftools") == "0.33"
assert version("unicorn") == "2.1.2"
PY
}

install_pwntools() {
  if pwntools_ready; then
    log "pwntools environment already present at ${PWNTOOLS_VENV}"
    return
  fi
  as_root python3 -m venv "$PWNTOOLS_VENV"
  as_root "${PWNTOOLS_VENV}/bin/python" -m pip install -q --disable-pip-version-check "${PWNTOOLS_PINS[@]}"
  pwntools_ready || die "pwntools environment at ${PWNTOOLS_VENV} does not report the pinned versions"
  log "installed ${PWNTOOLS_PINS[*]} at ${PWNTOOLS_VENV}"
}

install_ghidra_and_link() {
  check_java_major
  install_ghidra
  link_launcher
}

STEP_RESULTS=()
FAILED=0

# Runs one step in a subshell with errexit active, records its result, and
# continues with the next step either way.
run_step() {
  local name="$1" rc
  shift
  log "--- ${name}"
  set +e
  (
    set -e
    "$@"
  )
  rc=$?
  set -e
  if [ "$rc" -eq 0 ]; then
    STEP_RESULTS+=("ok      ${name}")
  else
    STEP_RESULTS+=("FAILED  ${name}")
    FAILED=1
  fi
}

run_step "prerequisites" ensure_packages
run_step "REA package (npm cache)" prewarm_rea
if [ "${SKIP_PWNTOOLS:-0}" = 1 ]; then
  STEP_RESULTS+=("skipped pwntools (SKIP_PWNTOOLS=1)")
else
  run_step "pwntools" install_pwntools
fi
run_step "Ghidra ${GHIDRA_VERSION}" install_ghidra_and_link

log "=== summary"
for result in "${STEP_RESULTS[@]}"; do
  log "$result"
done
log "environment variables for the REA MCP server:"
log "  GHIDRA_INSTALL_DIR=${GHIDRA_DIR}"
log "  REA_PWNTOOLS_PYTHON=${PWNTOOLS_VENV}/bin/python"
log "check inside a session with: npx -y --prefix=/ rea-agents@${REA_VERSION} doctor --json"
if [ "$FAILED" -eq 1 ] && [ "${STRICT:-0}" = 1 ]; then
  exit 1
fi
