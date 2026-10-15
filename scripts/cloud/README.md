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

### Add Ghidra and pwntools to the cloud environment

1. Open the cloud environment menu in a session's title bar and choose
   **Edit**.
2. Paste the contents of [`claude-cloud-setup.sh`](claude-cloud-setup.sh)
   into **Setup script**. It runs four independent steps and prints a summary:
   - prerequisites: a full JDK 21, `procps`, `unzip`, `curl`, and Python venv
     support, installed only when missing;
   - REA package: pre-downloads `rea-agents@6.4.0` with the same command
     `.mcp.json` uses (measured: 9.4 s cold start, 1.9 s once cached);
   - pwntools: `/opt/rea-pwntools` with pwntools 4.15.0, pyelftools 0.33 and
     unicorn 2.1.2, which REA's ELF layout adapter requires;
   - Ghidra: the official 12.1.4 archive from the `v12.1.4` release of the
     `adefemi-dev/ghidra-dist` mirror, checked against the official SHA-256
     pinned in the script and extracted to `/opt/ghidra_12.1.4_PUBLIC`.
     Cloud sessions reach GitHub release pages only for repositories attached
     to the session, so the NationalSecurityAgency/ghidra release is not
     reachable there. Set `GHIDRA_RELEASE_REPO=NationalSecurityAgency/ghidra`
     where it is.

   A failed step does not stop the others, and the script exits 0 so sessions
   still start. Set `STRICT=1` to make any failure exit 1.

3. Add these environment variables in the same settings:

   ```
   GHIDRA_INSTALL_DIR=/opt/ghidra_12.1.4_PUBLIC
   REA_PWNTOOLS_PYTHON=/opt/rea-pwntools/bin/python
   ```

   `rea-agents` 6.4.0 requires `GHIDRA_INSTALL_DIR`. Later releases can also
   find Ghidra through the `/usr/local/bin/ghidraRun` link the script creates.

4. Give the session access to the mirror: install the Claude GitHub App on
   `adefemi-dev/ghidra-dist` and select that repository for the session. A
   mirror release must hold the unmodified official archive; the script
   rejects any archive whose SHA-256 differs from the pinned official value.
   To mirror another version, upload its official archive to a `v<version>`
   release and set `GHIDRA_VERSION` and `GHIDRA_SHA256` from the official
   release notes.

5. Under **Network access**, allow these hosts (keep package managers allowed;
   PyPI and npm are already on that list):

   ```
   api.github.com
   github.com
   release-assets.githubusercontent.com
   objects.githubusercontent.com
   ```

6. Start a new session and check:

   ```bash
   npx -y --prefix=/ rea-agents@6.4.0 doctor --json
   ```

If the release cannot be reached, for example because the mirror is not
attached to the session, the Ghidra step fails with
`could not resolve the Ghidra 12.1.4 release asset` while the other steps still
finish. To install from an archive you supply instead, set `GHIDRA_ZIP` to its
absolute path and `GHIDRA_SHA256` to the checksum published on the release
page.

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

Setup records `GHIDRA_INSTALL_DIR` and `JAVA_HOME` in the registration. Start
Claude Desktop again afterwards.

REA's documentation says setup also detects the private configuration file of
the Microsoft Store (MSIX) build. On one Windows machine with the Store build
(`Claude 2.37337.1.0`), setup reported success but wrote only
`%APPDATA%\Claude\claude_desktop_config.json`, which that build ignores once
it has saved its private copy. If Claude Desktop shows no REA tools, check
which build you have:

```powershell
Get-AppxPackage *Claude* | Select-Object Name, Version
Test-Path "$env:LOCALAPPDATA\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\claude_desktop_config.json"
```

A package plus `True` means the Store build is reading its private file. Use
the PowerShell registration below.

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

For the Store build, this PowerShell block adds the entry to the private file.
Quit Claude Desktop fully first (tray icon, then **Quit**). It backs up the
file, keeps every other setting, replaces only `mcpServers.rea`, and writes
UTF-8 without a byte-order mark. Replace the two paths in `env` with yours:

```powershell
$P = "$env:LOCALAPPDATA\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\claude_desktop_config.json"
Copy-Item $P "$P.bak-$(Get-Date -Format yyyyMMdd-HHmmss)"
$raw = Get-Content $P -Raw
if ($raw -and $raw.Trim()) { $cfg = $raw | ConvertFrom-Json } else { $cfg = [pscustomobject]@{} }
if (-not $cfg.PSObject.Properties['mcpServers']) {
  $cfg | Add-Member -NotePropertyName mcpServers -NotePropertyValue ([pscustomobject]@{})
}
$rea = [pscustomobject]@{
  command = "C:\Program Files\nodejs\node.exe"
  args    = @("$env:APPDATA\npm\node_modules\rea-agents\scripts\rea.mjs", "mcp")
  env     = [pscustomobject]@{
    GHIDRA_INSTALL_DIR = "C:\path\to\ghidra_12.1.4_PUBLIC"
    JAVA_HOME          = "C:\path\to\jdk-21"
  }
}
$cfg.mcpServers | Add-Member -NotePropertyName rea -NotePropertyValue $rea -Force
[IO.File]::WriteAllText($P, ($cfg | ConvertTo-Json -Depth 32), (New-Object System.Text.UTF8Encoding $false))
(Get-Content $P -Raw | ConvertFrom-Json).mcpServers.rea | Format-List
```

To undo it, copy the `.bak-…` file back over `claude_desktop_config.json`. The
Store build keeps its logs in
`%LOCALAPPDATA%\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\logs`.

## claude.ai web and mobile

The `reverse-engineer-anything` skill reaches claude.ai through your account's
skill sync, so Claude there knows REA's workflows. claude.ai can only connect
to remote HTTPS MCP connectors and cannot start REA on your computer, so REA's
analysis tools are not available there. Use Claude Desktop or Claude Code for
analysis that needs REA's tools.

## Verification status

- Cloud: the setup script's Ghidra step was tested with a synthetic archive
  for a fresh install, an idempotent rerun, a checksum mismatch, a refused
  launcher replacement, and a blocked GitHub API (the other steps still
  completed). The pwntools and REA pre-download steps ran for real, and
  `inspect-binary-layout /usr/bin/ls` then returned 31 sections and 128
  symbols through the script-built pwntools environment. The
  NationalSecurityAgency/ghidra release pages were blocked from that session.
- Cloud mirror: run from inside a cloud session with `adefemi-dev/ghidra-dist`
  attached, the script downloaded the 12.1.4 archive from the mirror, matched
  the pinned SHA-256, installed it and linked `ghidraRun`; a rerun changed
  nothing, and a wrong `GHIDRA_SHA256` or an unpinned version failed before
  downloading. Whether the environment's setup phase, which runs before a
  session starts, has the same repository access was not tested.
- Windows: confirmed on one Windows machine with the Store build of Claude
  Desktop, Node.js 24.16.0, Temurin JDK 21.0.12 and Ghidra 12.1.4. After the
  private-file registration above, a Chat tab session opened
  `C:\Windows\System32\notepad.exe` through REA and listed 794 procedures
  through Ghidra. Run there, `rea setup --client claude_desktop` reported
  success without writing the private file.
