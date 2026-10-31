#!/usr/bin/env bash
# Setup script for a Claude Code cloud environment that uses REA with Ghidra.
#
# Paste this file's contents into the environment's "Setup script" field
# (claude.ai > cloud environment menu > Edit). The repository's SessionStart
# hook (.claude/settings.json -> scripts/cloud/session-start.sh) also runs it at
# the start of every cloud session, because the setup script runs only when the
# environment cache is rebuilt and possibly without GitHub credentials.
# It is not part of REA's installer: `rea setup` never installs Java or
# Ghidra, and this script is operator-owned environment provisioning for
# disposable cloud containers.
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
#      (default: the Ghidra_<version>_build release of adefemi-dev/Morluto-Rea,
#      because cloud sessions reach GitHub only for repositories attached to
#      them), verifies it against the official SHA-256, extracts it under
#      GHIDRA_PREFIX (default /opt), and links ghidraRun into BIN_DIR (default
#      /usr/local/bin).
#   5. JADX: downloads the jadx-headless-mcp 0.7.1 JAR that REA pins for
#      Android analysis, checks REA's pinned SHA-256, and stores it at
#      JADX_JAR (default /opt/rea-jadx/jadx-headless-mcp-0.7.1-all.jar).
#   6. Hopper, only with INSTALL_HOPPER=1: when `rea doctor` does not report an
#      installed Hopper, runs `rea setup --yes --install-hopper`, REA's own
#      installer, which downloads the Hopper Linux demo from www.hopperapp.com,
#      verifies it, and installs it with its Xvfb dependencies, after
#      refreshing the apt package lists that installer relies on. Hopper is
#      commercial software; the demo has vendor-defined limits. Setting
#      INSTALL_HOPPER=1 in the environment settings is the operator's approval.
#
# After it runs, add these environment variables in the same environment
# settings so the REA MCP server sees the installations:
#   GHIDRA_INSTALL_DIR=/opt/ghidra_12.1.4_PUBLIC
#   REA_PWNTOOLS_PYTHON=/opt/rea-pwntools/bin/python
#   REA_JADX_MCP_JAR=/opt/rea-jadx/jadx-headless-mcp-0.7.1-all.jar
# rea-agents 6.4.0 requires GHIDRA_INSTALL_DIR. Later releases also discover
# Ghidra through the ghidraRun PATH link when the variable is unset.
#
# The script exits 0 even when a step fails, because a setup script that exits
# non-zero stops the session from starting. Set STRICT=1 to exit 1 when any
# step fails. All output is also appended to LOG_FILE so a session can read
# what happened during setup.
#
# Optional overrides:
#   GHIDRA_VERSION   Ghidra release, default 12.1.4 (REA accepts 12.1.x and
#                    verifies its bridge with 12.1.4).
#   GHIDRA_RELEASE_REPO  GitHub owner/repo holding the release, default
#                    adefemi-dev/Morluto-Rea. Use NationalSecurityAgency/ghidra
#                    where the official repository is reachable.
#   GHIDRA_RELEASE_TAG   Release tag, default Ghidra_<version>_build (the
#                    official tag name).
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
#   JADX_JAR         Absolute JADX JAR path, default
#                    /opt/rea-jadx/jadx-headless-mcp-0.7.1-all.jar. An existing
#                    file with another digest is never replaced.
#   SKIP_JADX=1      Skip step 5.
#   INSTALL_HOPPER=1 Run step 6; it is skipped otherwise.
#   LOG_FILE         Log file, default /var/log/rea-cloud-setup.log; set it
#                    empty to disable.
#   SUMMARY_FILE     Optional file that receives the step summary lines.
set -euo pipefail

LOG_FILE="${LOG_FILE-/var/log/rea-cloud-setup.log}"
if [ -n "$LOG_FILE" ] && mkdir -p "$(dirname "$LOG_FILE")" 2>/dev/null &&
  printf '\n[rea-cloud-setup] === %s start\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >>"$LOG_FILE" 2>/dev/null; then
  exec 2> >(tee -a "$LOG_FILE" >&2)
fi

GHIDRA_VERSION="${GHIDRA_VERSION:-12.1.4}"
GHIDRA_PREFIX="${GHIDRA_PREFIX:-/opt}"
BIN_DIR="${BIN_DIR:-/usr/local/bin}"
REA_VERSION="${REA_VERSION:-6.4.0}"
PWNTOOLS_VENV="${PWNTOOLS_VENV:-/opt/rea-pwntools}"
PWNTOOLS_PINS=(pwntools==4.15.0 pyelftools==0.33 unicorn==2.1.2)
JADX_JAR="${JADX_JAR:-/opt/rea-jadx/jadx-headless-mcp-0.7.1-all.jar}"
# Pinned by REA (docs/android-analysis.md, src/android/JadxRelease.ts).
JADX_URL="https://github.com/1013503897/jadx-headless-mcp/releases/download/v0.7.1/jadx-headless-mcp-0.7.1-all.jar"
JADX_SHA256="6e5eacf500b64292bfb73c49797c1958f6ee44646e43e868039ae7feb573ff75"
GHIDRA_DIR="${GHIDRA_PREFIX}/ghidra_${GHIDRA_VERSION}_PUBLIC"
GHIDRA_RELEASE_REPO="${GHIDRA_RELEASE_REPO:-adefemi-dev/Morluto-Rea}"
GHIDRA_RELEASE_TAG="${GHIDRA_RELEASE_TAG:-Ghidra_${GHIDRA_VERSION}_build}"
RELEASE_API="https://api.github.com/repos/${GHIDRA_RELEASE_REPO}/releases/tags/${GHIDRA_RELEASE_TAG}"

# Official archive checksums. A mirror's own digest only shows the upload was
# intact, so a mirrored archive must also match the official value.
official_sha256() {
  case "$1" in
    12.1.4) printf '%s\n' ddac49f903da9d5bac833e5cc79395098b9c33cfd3279be5f31bd00387d2d4db ;;
    *) return 1 ;;
  esac
}

# Official archive file names, for the public download URL that needs no API.
official_asset_name() {
  case "$1" in
    12.1.4) printf '%s\n' ghidra_12.1.4_PUBLIC_20260921.zip ;;
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

# Tries the API asset url first (it serves private repositories through
# credentials), then the public download url without credentials, which needs
# no API call and works for a public repository when no proxy supplies
# credentials, for example during the environment's setup phase.
download_ghidra() {
  local work="$1" asset name url api_sha expected public_name
  expected="${GHIDRA_SHA256:-$(official_sha256 "$GHIDRA_VERSION" || true)}"
  [ -n "$expected" ] || die "no official SHA-256 is pinned for Ghidra ${GHIDRA_VERSION}; set GHIDRA_SHA256 from the official release notes"
  printf '%s\n' "$expected" >"${work}/expected.sha256"
  if asset="$(resolve_release_asset)"; then
    read -r name url api_sha <<<"$asset"
    if [ -n "$api_sha" ] && [ "$expected" != "$api_sha" ]; then
      die "${GHIDRA_RELEASE_REPO} reports SHA-256 ${api_sha} for ${name}, not the expected ${expected}"
    fi
    log "downloading ${name} from ${GHIDRA_RELEASE_REPO} ${GHIDRA_RELEASE_TAG} through the API"
    if github_curl -o "${work}/${name}" -H 'Accept: application/octet-stream' "$url"; then
      printf '%s\n' "${work}/${name}"
      return
    fi
    log "API download failed"
  else
    log "could not resolve the release asset from ${RELEASE_API}"
  fi
  public_name="$(official_asset_name "$GHIDRA_VERSION")" ||
    die "could not download Ghidra ${GHIDRA_VERSION} from ${RELEASE_API}, and no official file name is pinned for a public download"
  url="https://github.com/${GHIDRA_RELEASE_REPO}/releases/download/${GHIDRA_RELEASE_TAG}/${public_name}"
  log "downloading ${public_name} from ${url}"
  curl -fSL --retry 3 -o "${work}/${public_name}" "$url" ||
    die "could not download Ghidra ${GHIDRA_VERSION} from ${RELEASE_API} or ${url}"
  printf '%s\n' "${work}/${public_name}"
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

install_jadx() {
  local tmp
  case "$JADX_JAR" in
    /*) ;;
    *) die "JADX_JAR must be an absolute path; REA rejects a relative REA_JADX_MCP_JAR (got ${JADX_JAR})" ;;
  esac
  if [ -e "$JADX_JAR" ] || [ -L "$JADX_JAR" ]; then
    { [ -f "$JADX_JAR" ] && [ "$(sha256sum "$JADX_JAR" | awk '{print $1}')" = "$JADX_SHA256" ]; } ||
      die "${JADX_JAR} exists but is not the pinned JADX 0.7.1 JAR; refusing to replace it"
    log "JADX JAR already present at ${JADX_JAR}"
    return
  fi
  WORK_DIR="$(mktemp -d)"
  trap cleanup EXIT
  tmp="${WORK_DIR}/jadx.jar"
  log "downloading ${JADX_URL}"
  curl -fSL --retry 3 -o "$tmp" "$JADX_URL" || die "could not download ${JADX_URL}"
  [ "$(sha256sum "$tmp" | awk '{print $1}')" = "$JADX_SHA256" ] ||
    die "SHA-256 mismatch for the JADX JAR; expected ${JADX_SHA256}"
  chmod 0644 "$tmp"
  as_root mkdir -p "$(dirname "$JADX_JAR")"
  as_root mv -n "$tmp" "$JADX_JAR"
  [ "$(sha256sum "$JADX_JAR" | awk '{print $1}')" = "$JADX_SHA256" ] ||
    die "${JADX_JAR} appeared during installation and is not the pinned JAR"
  log "installed the JADX JAR at ${JADX_JAR} (SHA-256 verified)"
}

# Reads `rea doctor --provider hopper` and prints one line: "installed" when
# every Hopper check passes, "runtime" and the failing checks when Hopper is
# installed but another Hopper check fails, or "missing". rea doctor exits 1
# whenever a check fails, including a missing Hopper, so the report decides and
# the exit status is ignored; under pipefail it would abort the step silently.
hopper_state() {
  local report
  report="$(cd / && npx -y --prefix=/ "rea-agents@${REA_VERSION}" doctor --provider hopper --json 2>/dev/null)" || true
  printf '%s' "$report" |
    python3 -c '
import json, sys
try:
    report = json.load(sys.stdin)
except ValueError:
    print("missing")
    sys.exit()
checks = [c for c in report.get("checks", []) if str(c.get("name", "")).startswith("hopper")]
installation = [c for c in checks if c.get("name") == "hopper"]
failing = [c for c in checks if not c.get("ok")]
if not installation or not installation[0].get("ok"):
    print("missing")
elif failing:
    print("runtime " + "; ".join("%s: %s" % (c.get("name"), c.get("remediation") or c.get("detail")) for c in failing))
else:
    print("installed")
'
}

# Uses REA's own installer, which verifies the official package before
# installing it; without --client it configures no agent integration. It runs
# only after the operator opts in with INSTALL_HOPPER=1, and installs only when
# Hopper itself is missing, never to repair host runtime configuration.
install_hopper() {
  local state
  command -v npx >/dev/null 2>&1 || die "npx not found; cannot run REA's Hopper installer"
  state="$(hopper_state)"
  case "$state" in
    installed)
      log "Hopper already installed and reported ready by rea doctor"
      return
      ;;
    runtime*) die "Hopper is installed but not ready: ${state#runtime }" ;;
  esac
  # As a non-root user, REA's installer elevates through pkexec, which cloud
  # containers do not provide; cloud setup scripts and hooks run as root.
  [ "$(id -u)" -eq 0 ] || die "installing Hopper needs root; run this script as root"
  # REA's installer runs apt-get install without refreshing package lists.
  # Cloud images can start with empty lists, which hide Hopper's Qt 6
  # dependencies and make the installer report a package-manager failure.
  if command -v apt-get >/dev/null 2>&1; then
    DEBIAN_FRONTEND=noninteractive apt-get update -qq >&2
  fi
  (cd / && npx -y --prefix=/ "rea-agents@${REA_VERSION}" setup --yes --install-hopper) >&2 ||
    die "rea setup --install-hopper failed"
  state="$(hopper_state)"
  [ "$state" = installed ] || die "rea doctor does not report Hopper as ready after installation: ${state}"
  log "installed Hopper with rea setup"
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
if [ "${SKIP_JADX:-0}" = 1 ]; then
  STEP_RESULTS+=("skipped JADX (SKIP_JADX=1)")
else
  run_step "JADX" install_jadx
fi
if [ "${INSTALL_HOPPER:-0}" = 1 ]; then
  run_step "Hopper" install_hopper
else
  STEP_RESULTS+=("skipped Hopper (set INSTALL_HOPPER=1 to install it)")
fi

log "=== summary"
for result in "${STEP_RESULTS[@]}"; do
  log "$result"
done
if [ -n "${SUMMARY_FILE:-}" ]; then
  printf '%s\n' "${STEP_RESULTS[@]}" >"$SUMMARY_FILE"
fi
log "environment variables for the REA MCP server:"
log "  GHIDRA_INSTALL_DIR=${GHIDRA_DIR}"
log "  REA_PWNTOOLS_PYTHON=${PWNTOOLS_VENV}/bin/python"
log "  REA_JADX_MCP_JAR=${JADX_JAR}"
log "check inside a session with: npx -y --prefix=/ rea-agents@${REA_VERSION} doctor --json"
if [ "$FAILED" -eq 1 ] && [ "${STRICT:-0}" = 1 ]; then
  exit 1
fi
