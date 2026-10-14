# Using REA from Claude surfaces

This fork-local guide covers the three places you can chat with Claude and
what each needs to use REA. REA is a local-only MCP server: something on the
same machine as the analysis target must launch it.

| Surface                            | REA skill                     | REA MCP tools                    | Ghidra                          |
| ---------------------------------- | ----------------------------- | -------------------------------- | ------------------------------- |
| Claude Code cloud sessions         | Account-synced                | Yes, from `.mcp.json`            | Yes, via the setup script below |
| Claude Desktop / local Claude Code | Account-synced or `rea setup` | Yes, via `rea setup`             | Yes, your own installation      |
| claude.ai web and mobile chat      | Account-synced                | No (cannot launch local servers) | No                              |

## Claude Code cloud sessions

The repository's `.mcp.json` starts `rea-agents@6.4.0` in every new session.
It runs `npx` with `--prefix=/` because this repository's own `package.json`
is also named `rea-agents`; without it, `npx` resolves the local project and
fails with `rea: not found`.

### Add Ghidra to the cloud environment

1. Open the cloud environment menu in a session's title bar and choose
   **Edit**.
2. Paste the contents of [`claude-cloud-setup.sh`](claude-cloud-setup.sh)
   into **Setup script**. It installs a full JDK 21, `procps`, `unzip`, and
   `curl` only when missing, downloads the official Ghidra 12.1.4 archive
   from the NationalSecurityAgency/ghidra GitHub release, verifies the
   SHA-256 that GitHub reports for the asset, and extracts it to
   `/opt/ghidra_12.1.4_PUBLIC`.
3. Add this environment variable in the same settings:

   ```
   GHIDRA_INSTALL_DIR=/opt/ghidra_12.1.4_PUBLIC
   ```

   `rea-agents` 6.4.0 requires it. Later releases can also find Ghidra through
   the `/usr/local/bin/ghidraRun` link the script creates.

4. Start a new session and check:

   ```bash
   npx -y --prefix=/ rea-agents@6.4.0 doctor --json
   ```

The environment's network policy must allow `api.github.com` and GitHub
release downloads. If the API is unreachable, the script stops with
`could not resolve the Ghidra 12.1.4 release asset`. To install from an
archive you supply instead, set `GHIDRA_ZIP` to its absolute path and
`GHIDRA_SHA256` to the checksum published on the release page.

## Claude Desktop on Windows

Claude Desktop can launch REA locally and use the Ghidra already installed on
your computer. REA accepts Ghidra 12.1.x with a 64-bit full JDK 21 or newer
(including `javac`).

### 1. Find your Ghidra folder and JDK

In PowerShell:

```powershell
# Ghidra folders contain ghidraRun.bat and Ghidra\application.properties.
Get-ChildItem -Path "C:\", $env:USERPROFILE, $env:ProgramFiles -Filter ghidraRun.bat `
  -Recurse -Depth 4 -ErrorAction SilentlyContinue | Select-Object DirectoryName

# Replace the path with a folder printed above to see its version.
Select-String -Path "C:\path\to\ghidra_12.1.4_PUBLIC\Ghidra\application.properties" `
  -Pattern "application.version"

# The JDK must provide javac 21 or newer.
javac -version
(Get-Command javac).Source
```

`JAVA_HOME` is the folder above `bin\javac.exe`. If the version is not
12.1.x, install Ghidra 12.1.4 next to it; REA refuses other release lines.

### 2. Register REA with setup (recommended)

Quit Claude Desktop fully (including its tray icon), then run these from a
regular PowerShell window, not one started by Claude Desktop:

```powershell
npm install --global rea-agents@6.4.0
$env:GHIDRA_INSTALL_DIR = "C:\path\to\ghidra_12.1.4_PUBLIC"
$env:JAVA_HOME = "C:\path\to\jdk-21"
rea doctor --json
rea setup --client claude_desktop
```

Setup shows its plan and asks before writing. It finds the configuration file
Claude Desktop actually reads, including the private copy used by the
Microsoft Store (MSIX) build, and records `GHIDRA_INSTALL_DIR` and
`JAVA_HOME` in the registration. Start Claude Desktop again afterwards.

### 3. Manual registration (fallback)

If you prefer to edit the file yourself, add this to
`%APPDATA%\Claude\claude_desktop_config.json`, or to
`%LOCALAPPDATA%\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\claude_desktop_config.json`
for the MSIX build. Keep any existing `mcpServers` entries:

```json
{
  "mcpServers": {
    "rea": {
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": [
        "C:\\Users\\YOU\\AppData\\Roaming\\npm\\node_modules\\rea-agents\\scripts\\rea.mjs",
        "mcp"
      ],
      "env": {
        "REA_ANALYSIS_PROVIDER": "ghidra",
        "GHIDRA_INSTALL_DIR": "C:\\path\\to\\ghidra_12.1.4_PUBLIC",
        "JAVA_HOME": "C:\\path\\to\\jdk-21"
      }
    }
  }
}
```

Find the real `rea.mjs` path with `npm root --global`. Cold Ghidra imports can
take minutes; REA's provider startup deadline is 330 seconds.

## claude.ai web and mobile

The `reverse-engineer-anything` skill reaches claude.ai through your account's
skill sync, so Claude there knows REA's workflows. claude.ai can only connect
to remote HTTPS MCP connectors and cannot start REA on your computer, so REA's
analysis tools are not available there. Use Claude Desktop or Claude Code for
analysis that needs REA's tools.

## Verification status

- Cloud: the setup script was tested with a synthetic archive for a fresh
  install, an idempotent rerun, a checksum mismatch, a refused launcher
  replacement, and a blocked GitHub API. A real Ghidra download was not
  possible from the session that wrote it, because its network policy blocks
  that repository's release pages.
- Windows: the PowerShell commands and Desktop registration were not run on
  Windows.
