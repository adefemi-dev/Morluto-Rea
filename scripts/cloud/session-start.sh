#!/usr/bin/env bash
# SessionStart hook for Claude Code cloud sessions (see .claude/settings.json).
#
# Runs claude-cloud-setup.sh inside the session, where the GitHub proxy can
# authenticate downloads from this repository's releases. The environment's
# setup script runs only when the environment cache is rebuilt, and before
# those credentials exist, so it cannot guarantee Ghidra on its own. Every step
# is idempotent: when the environment already has everything, this takes a few
# seconds.
#
# It does nothing outside cloud sessions. Its standard output becomes context
# for Claude, so it prints only the step summary; the full log goes to
# LOG_FILE (default /var/log/rea-cloud-session-start.log). It always exits 0
# so a failed step never blocks the session.
#
# The hook runs when the session starts. REA's MCP server checks the Ghidra
# installation on its first Ghidra request and keeps the result, so if Ghidra
# was installed later, reconnect the rea server with /mcp before using it.
set -uo pipefail

[ "${CLAUDE_CODE_REMOTE:-}" = true ] || exit 0

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
log_file="${LOG_FILE:-/var/log/rea-cloud-session-start.log}"
summary="$(mktemp)"
trap 'rm -f "$summary"' EXIT

LOG_FILE="$log_file" SUMMARY_FILE="$summary" bash "${here}/claude-cloud-setup.sh" >/dev/null 2>&1
rc=$?

printf 'REA cloud setup (SessionStart hook, full log: %s):\n' "$log_file"
if [ -s "$summary" ]; then
  sed 's/^/  /' "$summary"
else
  printf '  setup script exited %s before writing a summary\n' "$rc"
fi
if [ "$rc" -ne 0 ] || grep -q '^FAILED' "$summary"; then
  printf '  Some steps failed. Read the log, fix the cause, run `bash %s`, then reconnect the rea MCP server with /mcp.\n' "${here}/session-start.sh"
fi
exit 0
