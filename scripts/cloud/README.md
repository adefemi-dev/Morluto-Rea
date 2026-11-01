# Using REA from Claude surfaces

This fork-local guide covers the three places you can chat with Claude and
what each needs to use REA. REA is a local-only MCP server: something on the
same machine as the analysis target must launch it.

| Surface                            | REA skill                     | REA MCP tools                    | Ghidra                                                |
| ---------------------------------- | ----------------------------- | -------------------------------- | ----------------------------------------------------- |
| Claude Code cloud sessions         | Account-synced                | Yes, from `.mcp.json`            | Yes, via the setup script and SessionStart hook below |
| Claude Desktop / local Claude Code | Account-synced or `rea setup` | Yes, via `rea setup`             | Yes, your own installation                            |
| claude.ai web and mobile chat      | Account-synced                | No (cannot launch local servers) | No                                                    |

## Claude Code cloud sessions

Start each cloud session with **only this repository** selected. Claude Code
loads a repository's `.mcp.json` and its `.claude/settings.json` hooks only in
a session with one repository. A session with several repositories starts in
the folder above the clones and loads neither, so REA's tools do not appear
([docs](https://code.claude.com/docs/en/settings#settings-in-cloud-sessions)).

The repository's `.mcp.json` starts `rea-agents@6.4.0` in every new session.
It runs `npx` with `--prefix=/` because this repository's own `package.json`
is also named `rea-agents`; without it, `npx` resolves the local project and
fails with `rea: not found`.

### How Ghidra and pwntools get installed

Two things run [`claude-cloud-setup.sh`](claude-cloud-setup.sh). Its seven
steps are idempotent and each runs on its own:

- prerequisites: a full JDK 21, `procps`, `unzip`, `curl`, and Python venv
  support, installed only when missing;
- REA package: pre-downloads `rea-agents@6.4.0` with the same command
  `.mcp.json` uses;
- pwntools: `/opt/rea-pwntools` with pwntools 4.15.0, pyelftools 0.33 and
  unicorn 2.1.2, which REA's ELF layout adapter requires;
- Ghidra: the official 12.1.4 archive from this repository's
  `Ghidra_12.1.4_build` release, checked against the official SHA-256 pinned
  in the script and extracted to `/opt/ghidra_12.1.4_PUBLIC`;
- JADX: the `jadx-headless-mcp` 0.7.1 JAR REA pins for Android analysis,
  checked against REA's pinned SHA-256 and stored at
  `/opt/rea-jadx/jadx-headless-mcp-0.7.1-all.jar`;
- Hopper, only when the environment sets `INSTALL_HOPPER=1`: if `rea doctor`
  does not report an installed Hopper, REA's own installer
  (`rea setup --yes --install-hopper`) downloads the Hopper Linux demo from
  `www.hopperapp.com`, verifies it, and installs it with its Xvfb
  dependencies. The script refreshes the apt package lists first, because
  that installer runs `apt-get install` without doing so and cloud images can
  start with empty lists. Hopper is commercial software; the demo has vendor-defined
  limits. Without `--client`, this configures no agent. Setting the variable
  is the operator's approval of that installation. When Hopper is installed
  but another Hopper check fails, the step reports REA's remediation instead
  of reinstalling.
- Claude Code integration, only when `CONFIGURE_CLAUDE_CODE=1`, which the
  SessionStart hook sets unless the environment sets it: when
  `rea doctor --client claude_code --skill` reports drift, the step runs
  `rea setup --yes --client claude_code`. That backs up `~/.claude.json` to
  `~/.claude.json.rea.backup`, adds a user-scope `rea` registration, and
  installs the REA skill into `~/.claude/skills`. It installs no provider.
  Claude Code connects one `rea` server and takes the repository's
  `.mcp.json` entry over the user-scope one
  ([docs](https://code.claude.com/docs/en/mcp)); because the two commands
  differ, `/mcp` and `claude mcp list` show a same-name warning. Set
  `CONFIGURE_CLAUDE_CODE=0` in the environment to skip the step.

1. **The environment's setup script.** It runs before Claude Code starts, and
   the filesystem it leaves is cached and reused by later sessions for about
   seven days, without running the script again
   ([docs](https://code.claude.com/docs/en/cloud-environments#environment-caching)).
   It runs before Claude Code connects to the session's proxy, and the docs do
   not say whether GitHub credentials exist at that point, so the script
   falls back to the release's public URL, which needs none. If the download
   still fails, the cache is built without Ghidra.
2. **The SessionStart hook** in `.claude/settings.json`, which runs
   [`session-start.sh`](session-start.sh) whenever a cloud session starts or
   resumes, after Claude Code launches. It runs the same script inside
   the session, where the GitHub proxy authenticates downloads from this
   repository, and installs whatever the cache lacks: about 20 seconds for
   Ghidra, about 3 seconds when everything is present. It prints the step
   summary into Claude's context and writes the full log to
   `/var/log/rea-cloud-session-start.log`. It does nothing outside cloud
   sessions (`CLAUDE_CODE_REMOTE` is not `true`).

The setup script also appends its output to `/var/log/rea-cloud-setup.log`.
It exits 0 when a step fails, because a setup script that exits non-zero
stops the session from starting. `STRICT=1` makes it exit 1 anyway.

### Set up the cloud environment

1. Publish the Ghidra archive as a release of this repository (once):
   - download `ghidra_12.1.4_PUBLIC_20260921.zip` from the official
     [Ghidra 12.1.4 release](https://github.com/NationalSecurityAgency/ghidra/releases/tag/Ghidra_12.1.4_build);
   - on this repository's GitHub page, open **Releases**, then
     **Draft a new release**;
   - in the tag box, type `Ghidra_12.1.4_build` and choose to create it as
     a new tag; keep the target `main`;
   - title it `Ghidra 12.1.4 archive for cloud sessions (not an REA release)`;
   - drag the zip into the attachments box and wait for the upload to finish;
   - untick **Set as the latest release**, then select **Publish release**.

   The tag does not follow the `rea-agents-<version>` pattern of REA's own
   release tags, and no workflow runs on tags or releases.
   Ghidra is Apache 2.0 licensed and the archive carries its LICENSE and
   NOTICE files. The script rejects an archive whose SHA-256 differs from the
   official value.

2. Open the cloud environment menu in a session's title bar and choose
   **Edit**.
3. Replace the **Setup script** with the contents of
   [`claude-cloud-setup.sh`](claude-cloud-setup.sh). Changing the script also
   makes the environment rebuild its cache.
4. Keep these environment variables in the same settings:

   ```
   GHIDRA_INSTALL_DIR=/opt/ghidra_12.1.4_PUBLIC
   REA_PWNTOOLS_PYTHON=/opt/rea-pwntools/bin/python
   REA_JADX_MCP_JAR=/opt/rea-jadx/jadx-headless-mcp-0.7.1-all.jar
   INSTALL_HOPPER=1
   ```

   Leave out `INSTALL_HOPPER=1` to skip Hopper. `rea-agents` 6.4.0 requires `GHIDRA_INSTALL_DIR`. Later releases can also
   find Ghidra through the `/usr/local/bin/ghidraRun` link the script creates.

5. Under **Network access**, allow these hosts (keep package managers allowed;
   PyPI and npm are already on that list):

   ```
   api.github.com
   github.com
   release-assets.githubusercontent.com
   objects.githubusercontent.com
   www.hopperapp.com
   ```

6. Start a new session with only this repository selected and check:

   ```bash
   npx -y --prefix=/ rea-agents@6.4.0 doctor --json
   ```

REA's MCP server checks the Ghidra installation on its first Ghidra request
and keeps that result for the life of the server. If Ghidra was installed
after such a request, reconnect the `rea` server with `/mcp`.

To use another release source, set `GHIDRA_RELEASE_REPO` and
`GHIDRA_RELEASE_TAG` (for the earlier `adefemi-dev/ghidra-dist` mirror:
`GHIDRA_RELEASE_TAG=v12.1.4`, with that repository attached to the session).
For a private repository the script sends `GH_TOKEN`, or `GITHUB_TOKEN` when
`GH_TOKEN` is unset, as a bearer token. To install from an archive you supply
instead, set `GHIDRA_ZIP` to its absolute path and `GHIDRA_SHA256` to the
checksum published on the release page. To mirror another Ghidra version, set
`GHIDRA_VERSION` and `GHIDRA_SHA256` from the official release notes; the
public-URL fallback needs a pinned file name, so add one to
`official_asset_name` too.

### IDA in cloud sessions

The setup script does not install IDA. REA uses IDA through a separate IDA MCP
server ([IDA provider](../../docs/ida-provider.md)): either an IDA GUI that is
already open, which a cloud session does not have, or headless `idalib`, which
needs an IDA Pro installation and license that REA never installs or
activates. IDA is proprietary, so it must not be uploaded to this public
repository's releases.

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
  downloading. In a later fresh session with two repositories selected, the
  setup phase left no Ghidra install and the REA MCP server did not load.
- SessionStart hook: run by hand in a cloud session (not yet as a real hook),
  `session-start.sh` installed Ghidra through the API path in 16 seconds,
  reran in 3 seconds with all four steps present, did nothing without
  `CLAUDE_CODE_REMOTE=true`, and reported a failed Ghidra step in its summary.
  With the API stubbed to fail, the public-URL fallback sent no credentials,
  installed the official archive, and refused a tampered one. Downloading
  from this repository's release and the setup phase's access to the public
  URL were not tested before the release existed.
- REA 6.4.0 MCP server: with `GHIDRA_INSTALL_DIR` missing at server start and
  present before the first request, `open_binary` and
  `procedure_pseudo_code` worked through Ghidra 12.1.4; after a first request
  had failed, the same server kept reporting `executable_missing`.
- JADX in a cloud session: the script downloaded the pinned JAR and matched
  its SHA-256. Through the REA 6.4.0 MCP server, `inspect_android_package`,
  `inspect_android_class` and `inspect_android_method` (`onCreate` of
  `org.fdroid.ui.crash.CrashActivity`) succeeded on the public F-Droid APK.
  On that APK, `search_android_classes` failed closed with "JADX class
  inventory is duplicated or differs from the loaded class count".
- Hopper: in an earlier session `www.hopperapp.com` was not on the network
  allowlist, so the step failed with REA's message "REA could not download or
  unpack the official Hopper package". In a later cloud session that allowed
  the host, two script faults kept the step from installing anything: it
  stopped silently whenever Hopper was missing, because `rea doctor` exits 1
  for an unhealthy report and `pipefail` turned that into a step failure; and
  with Hopper's Qt 6 dependencies absent and the apt lists empty,
  `rea setup --yes --install-hopper` reported
  `authorization_or_package_manager_failed` and installed nothing, while the
  same command succeeded once the lists were populated. With both fixed, the
  script, run with `INSTALL_HOPPER=1` from that state, installed Hopper 6.4.2
  in 47 seconds; reruns, directly and through `session-start.sh`, changed
  nothing, and `rea doctor --provider hopper` passed `hopper`,
  `hopper-version` and `hopper-demo-runtime`. Through the REA 6.4.0 CLI, an
  install of the same package analyzed `/usr/bin/true` (86 procedures) and
  returned the entry procedure at `0x19f0` as instructions and pseudo-code
  (not repeated after the final reinstall). The REA MCP tools were not exercised with
  Hopper. `curl` with its default user agent received HTTP 403 from
  `www.hopperapp.com`, while REA's own download succeeded.
- Claude Code integration: in a cloud session with Hopper 6.4.2 installed,
  `rea doctor` reported `skill:identity` and `registration:claude_code` as
  config drift. With the installed skill removed, the setup script run with
  `CONFIGURE_CLAUDE_CODE=1` detected the drift, ran
  `rea setup --yes --client claude_code`, and the scoped doctor then passed;
  a rerun took about 7 seconds and left `~/.claude.json` unchanged, the step
  was skipped without the variable, and `session-start.sh` reported it as
  `ok`. Through `npx`, setup registers `npx -y rea-agents@6.4.0 mcp` without
  `--prefix=/`, which would fail inside this repository; there the
  `.mcp.json` entry is used instead. A fresh session starting from the hook
  was not tested.
- Windows: confirmed on one Windows machine with the Store build of Claude
  Desktop, Node.js 24.16.0, Temurin JDK 21.0.12 and Ghidra 12.1.4. After the
  private-file registration above, a Chat tab session opened
  `C:\Windows\System32\notepad.exe` through REA and listed 794 procedures
  through Ghidra. Run there, `rea setup --client claude_desktop` reported
  success without writing the private file.
