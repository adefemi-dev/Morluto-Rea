#!/usr/bin/env bash
# Setup script for a Claude Code cloud environment that uses REA with Ghidra.
#
# Paste this file's contents into the environment's "Setup script" field
# (claude.ai > cloud environment menu > Edit). It is not part of REA's
# installer: `rea setup` never installs Java or Ghidra, and this script is
# operator-owned environment provisioning for disposable cloud containers.
#
# What it does, idempotently:
#   1. Installs a full JDK 21 (with javac), procps (`ps`), unzip, and curl
#      through apt-get, only when they are missing.
#   2. Downloads the official Ghidra release archive from the
#      NationalSecurityAgency/ghidra GitHub release, verifies its SHA-256,
#      and extracts it under GHIDRA_PREFIX (default /opt).
#   3. Links ghidraRun into BIN_DIR (default /usr/local/bin).
#
# After it runs, add this environment variable in the same environment
# settings so the REA MCP server sees the installation:
#   GHIDRA_INSTALL_DIR=/opt/ghidra_12.1.4_PUBLIC
# rea-agents 6.4.0 requires it. Later releases also discover Ghidra through
# the ghidraRun PATH link when the variable is unset.
#
# Optional overrides:
#   GHIDRA_VERSION   Ghidra release, default 12.1.4 (REA accepts 12.1.x and
#                    verifies its bridge with 12.1.4).
#   GHIDRA_SHA256    Expected archive SHA-256. Required when the GitHub API
#                    does not report an asset digest.
#   GHIDRA_ZIP       Absolute path to an already downloaded release archive.
#   GHIDRA_PREFIX    Extraction parent directory, default /opt.
#   BIN_DIR          Directory for the ghidraRun link, default /usr/local/bin.
set -euo pipefail

GHIDRA_VERSION="${GHIDRA_VERSION:-12.1.4}"
GHIDRA_PREFIX="${GHIDRA_PREFIX:-/opt}"
BIN_DIR="${BIN_DIR:-/usr/local/bin}"
GHIDRA_DIR="${GHIDRA_PREFIX}/ghidra_${GHIDRA_VERSION}_PUBLIC"
RELEASE_API="https://api.github.com/repos/NationalSecurityAgency/ghidra/releases/tags/Ghidra_${GHIDRA_VERSION}_build"

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
  if [ "${#missing[@]}" -eq 0 ]; then
    log "prerequisites present: javac, ps, unzip, curl"
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

# Prints "<asset name> <download url> <sha256 or empty>" for the release zip.
resolve_release_asset() {
  local release
  release="$(curl -fsSL --retry 3 -H 'Accept: application/vnd.github+json' "$RELEASE_API")" || return 1
  printf '%s' "$release" | python3 -c '
import json, sys
release = json.load(sys.stdin)
zips = [a for a in release.get("assets", []) if a.get("name", "").endswith(".zip")]
if len(zips) != 1:
    sys.exit("expected exactly one .zip asset, found %d" % len(zips))
asset = zips[0]
digest = asset.get("digest") or ""
sha = digest.split(":", 1)[1] if digest.startswith("sha256:") else ""
print(asset["name"], asset["browser_download_url"], sha)
'
}

download_ghidra() {
  local work="$1" asset name url api_sha expected
  asset="$(resolve_release_asset)" ||
    die "could not resolve the Ghidra ${GHIDRA_VERSION} release asset from ${RELEASE_API}"
  read -r name url api_sha <<<"$asset"
  expected="${GHIDRA_SHA256:-$api_sha}"
  [ -n "$expected" ] || die "no SHA-256 available for ${name}; set GHIDRA_SHA256 from the release notes"
  if [ -n "${GHIDRA_SHA256:-}" ] && [ -n "$api_sha" ] && [ "$GHIDRA_SHA256" != "$api_sha" ]; then
    die "GHIDRA_SHA256 does not match the digest GitHub reports for ${name}"
  fi
  log "downloading ${name}"
  curl -fSL --retry 3 -o "${work}/${name}" "$url"
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

ensure_packages
check_java_major
install_ghidra
link_launcher
log "done. Set GHIDRA_INSTALL_DIR=${GHIDRA_DIR} in the environment variables, then verify"
log "inside a session with: npx -y --prefix=/ rea-agents@6.4.0 doctor --json"
