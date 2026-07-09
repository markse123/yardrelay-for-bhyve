# Desktop Setup Contract

This document defines the shared setup contract for YardRelay native desktop wrappers around the local B-hyve-compatible controller. The Node server stays local and browser-based; each wrapper owns native setup, secret storage, prerequisite checks, and process lifecycle.

The internal service identity `bhyve-local-controller` and the `BHYVE_*` environment-variable names are legacy protocol/configuration identifiers retained to avoid breaking existing private-development installs. They are not the product name and should change only through an explicit compatibility migration.

The existing macOS wrapper still supports the development `.env` flow. The Windows wrapper implements this contract first, and a later macOS parity pass should move the Mac app to the same setup model with Keychain and Application Support storage.

## Runtime Model

Desktop wrappers start `node server/app.js` with environment variables rather than writing a generated `.env` file into the installed application folder.

Before an existing loopback listener is treated as the controller, the wrapper must call `/api/identity` with a fresh 32-byte base64url challenge and verify the returned HMAC-SHA-256 proof with `APP_TOKEN`. Protocol v2 signs the exact UTF-8 bytes `bhyve-local-controller\n2\nidentity\n<canonical-origin>\n<challenge>`, where the canonical origin is the exact loopback controller origin without a trailing slash, such as `http://127.0.0.1:3030`. A status code, product-name string, redirect, or successful `/api/config` response is not service authentication. Wrappers must not send `APP_TOKEN`, load the embedded UI, or adopt the listener until the proof succeeds.

For native shutdown, wrappers reuse that fresh verified challenge once and send `X-Controller-Challenge` plus a proof over the exact UTF-8 bytes `bhyve-local-controller\n2\nshutdown\n<canonical-origin>\n<challenge>`. The canonical origin must match the verified controller origin. The server expires challenges after 30 seconds and consumes an accepted challenge. Wrappers must not put `APP_TOKEN` in the shutdown request.

After service verification, an embedded browser may receive `APP_TOKEN` in the controller URL fragment. The wrapper must restrict every frame navigation to the exact configured `http://127.0.0.1:<port>` origin, reject redirects to another origin, and suppress new windows. The dashboard removes the fragment immediately after reading it into page memory.

Required server environment:

```text
ORBIT_EMAIL
ORBIT_PASSWORD
APP_TOKEN
WRITE_ACCESS_MODE=local
HOST=127.0.0.1
PORT
BHYVE_DATA_DIR
YARD_RUN_CONFIG
```

`.env` remains supported for source checkout and development use. Installed desktop apps should inject secrets and settings into the child process environment at launch.

Every server and wrapper uses the same app-token policy: an explicit `APP_TOKEN` must contain 32–512 printable ASCII characters, have no surrounding whitespace, and must not be the published sample or a generic placeholder, redaction, or password value. The sample in `.env.example` is intentionally invalid and must be replaced, for example with the output of `openssl rand -hex 32`. An explicitly unsafe value fails closed; only an absent value may receive a temporary or wrapper-generated 32-byte CSPRNG token.

`BHYVE_DATA_DIR` points to writable runtime state. The server stores snapshots and yard-run recovery state beneath this folder. `YARD_RUN_CONFIG` points to the optional local yard-run recipe file.

## Settings Schema

Wrappers should persist non-secret settings in a versioned JSON file:

```json
{
  "version": 1,
  "host": "127.0.0.1",
  "port": 3030,
  "nodePath": null,
  "dataDir": "platform-specific-data-folder",
  "yardRunConfigPath": "platform-specific-config-folder/yard-runs.local.json",
  "requireWriteToken": false
}
```

Only one profile is supported in V1. The app is configured when it has an Orbit email, Orbit password, app token, port, data directory, and yard-run config path. A yard-run config file is optional. Desktop wrappers should expose **Require the app token to unlock browser controls** as an extra-security option and pass `WRITE_ACCESS_MODE=protected` when enabled. The default is `local`, which keeps controls prompt-free for loopback clients.

## Platform Storage

Windows V1:

- Per-user install under `%LOCALAPPDATA%\Programs\YardRelay` for public builds.
- Settings, config, data, and logs under `%LOCALAPPDATA%\YardRelay`, with automatic migration from the legacy `%LOCALAPPDATA%\BHyveController` path as described below.
- Secrets encrypted for the current user with DPAPI.
- App tokens are accepted only when they contain 32–512 printable ASCII characters, have no leading or trailing whitespace, and do not contain published sample or generic sentinel values such as placeholders, redactions, or passwords. On startup, a previously stored token that fails this policy is removed from memory before it can be used. The encrypted secrets file is left unchanged, setup reopens with the existing Orbit credentials, and saving setup generates and stores a fresh random 32-byte token.
- Node.js 24 or newer required; the setup UI links to https://nodejs.org/en/download.
- WebView2 Runtime required; the setup UI links to https://developer.microsoft.com/en-us/microsoft-edge/webview2/.
- Build output is produced by `windows/package-windows.ps1`. Its zip contains a self-contained .NET runtime, but it does not bundle Node.js or WebView2 Runtime.
- The optional polished installer is defined by `windows/Packaging/BHyveController.iss` and requires Inno Setup 6 on Windows.

### Windows data migration behavior

On startup, `DesktopPaths` applies these rules before opening settings or starting the controller:

1. If `%LOCALAPPDATA%\YardRelay` already exists, use it unchanged. Do not copy, overwrite, or merge anything from the legacy folder.
2. If the destination is absent and `%LOCALAPPDATA%\BHyveController` exists, copy the legacy folder into a uniquely named staging directory, rewrite only copied settings that equal the exact legacy default paths, and move the completed staging directory to `%LOCALAPPDATA%\YardRelay`. Retain the complete legacy source as a recovery copy.
3. If neither folder exists, create `%LOCALAPPDATA%\YardRelay` for the new installation.
4. On every later startup, the existing destination makes migration a no-op. The same startup sequence is therefore idempotent.

The copied exact defaults for `dataDir` and `yardRunConfigPath` are rewritten from the legacy root to the YardRelay root. Any custom path remains unchanged. A failed copy removes its staging directory without deleting or modifying the legacy source, and a retry still refuses to overwrite or merge an existing destination. If both folders exist, the app uses the destination rather than guessing which data to combine. Uninstall must preserve user data unless the user chooses a separate explicit destructive-reset operation.

### Windows install, uninstall, backup, and restore

Published beta instructions must identify the installer as unsigned and direct users to download `YardRelaySetup-<version>.exe` only from the verified GitHub release page. The release must publish a SHA-256 checksum. Users verify it in PowerShell with:

```powershell
Get-FileHash .\YardRelaySetup-<version>.exe -Algorithm SHA256
```

The complete result must match the release value before the installer runs. Because the beta is unsigned, Microsoft Defender SmartScreen may display **Windows protected your PC** and **Unknown publisher**. After verifying the release source and checksum, the user may choose **More info** and **Run anyway** for the expected YardRelay installer. Instructions must tell users not to bypass a checksum mismatch or any different warning.

Windows uninstall uses **Settings > Apps > Installed apps > YardRelay > Uninstall**. It removes installed application files but preserves `%LOCALAPPDATA%\YardRelay` by default.

For backup or restore, quit the app and stop its managed controller first:

1. Back up the complete `%LOCALAPPDATA%\YardRelay` folder to private storage.
2. Restore only while YardRelay is stopped.
3. Never merge a backup over an existing app-data directory. Rename or move the existing `%LOCALAPPDATA%\YardRelay` folder first, then copy the backup into that exact path.
4. Treat `secrets.bin` as non-portable. DPAPI binds it to the same Windows user/profile that created it; a different profile or computer must re-enter Orbit credentials.

This is manual local backup/restore, not an encrypted archive feature. Only `secrets.bin` is DPAPI-protected; settings, configuration, data, snapshots, and logs may contain sensitive property or device information in plaintext. Keep backups private and encrypted at rest.

macOS parity target:

- App bundle installed normally by the user.
- Settings, config, data, and logs under `~/Library/Application Support/YardRelay` after the migration phase; private-development builds retain the legacy path until migration is implemented and tested.
- Secrets stored in Keychain.
- Node.js 24 or newer required unless a future package bundles Node.

## First-Run Wizard

Native wrappers should show setup before starting the controller server:

1. Check prerequisites: Node.js 24 or newer and, on Windows, WebView2 Runtime.
2. Collect Orbit email and password.
3. Offer a read-only Test Orbit Login button.
4. Configure server port and optional Node path override.
5. Offer optional `.env` import.
6. Offer optional yard-run config import.
7. Generate an app token automatically.
8. Offer an optional Require the app token to unlock browser controls setting, off by default.
9. Save settings and secrets only when the user finishes setup.

If Test Orbit Login fails, the wizard should show the error and still allow Save anyway for offline or temporary Orbit failures.

## Imports

`.env` import is a migration shortcut, not the normal storage model. It may import:

- Orbit email and password into native secret storage.
- App token into native secret storage only when it passes the shared token policy above. An unsafe import retains an existing safe Windows token; otherwise Windows generates a fresh random 32-byte token while still importing the Orbit email and password.
- Port into settings.
- `WRITE_ACCESS_MODE=protected` into the optional browser-control lock setting.

The app ignores imported `HOST` values and always uses `127.0.0.1`. Keeping one exact IPv4 loopback origin is part of the endpoint-bound service-identity protocol; `localhost` and `::1` are not wrapper-managed aliases.

Replacing an unsafe saved token invalidates any browser copy of the old token. After setup is saved, the verified Windows wrapper receives the new token automatically; a separate browser using protected mode must unlock writes again.

An active yard-run recovery file was signed with the old token and cannot be trusted after replacement. Before saving the replacement, confirm no zone or yard run is active. After the controller restarts, verify the physical sprinkler state; YardRelay may discard recovery state signed by the rejected token rather than replaying it.

Yard-run config import is separate. The wrapper should copy the selected file into the app config folder instead of referencing the original source checkout. Missing yard-run config means no optional yard runs are configured. Basic device, zone, and program controls still come from Orbit-discovered state.

## Reset Setup

Reset Setup should:

- Stop a managed controller server.
- Remove desktop settings.
- Remove native secrets.
- Restart the setup wizard.

On Windows, Reset Setup requires explicit confirmation that watering is stopped and physically verified. Resetting replaces the app token, so any active or saved yard-run recovery signed with the old token becomes unusable even though the yard-run recipe and runtime files are retained.

Reset Setup should keep yard-run config, snapshots, logs, and active yard-run state. V1 should not include a one-click full app-data delete command; it can expose Open App Data Folder for manual cleanup.

## Updates

The bundled Help guide may link to this project's canonical GitHub release page and open it in the system browser. That page may contain no beta yet. V1 must not silently poll, download, execute, or replace application binaries. True auto-update should wait for a signed release channel, stable update metadata, rollback behavior, and a trust model that both Windows and macOS can enforce.

## Help And User Guide

Desktop wrappers must expose the shared guide in `public/help/index.html` from their normal Help surface and while first-run setup or server startup is unavailable. The guide is bundled with the app and must not require the controller server or internet access for its content, search, navigation, or styling.

The dashboard exposes the same guide as its Help tab. Stable section anchors let future errors and controls link directly to setup, daily use, troubleshooting, privacy, and advanced topics without duplicating content in native views.

Manual navigation stays inside the bundled help page. Explicit HTTPS links to approved prerequisite and release hosts open in the system browser. Desktop wrappers must reject other file navigation, unapproved hosts, non-HTTPS destinations, credentials in URLs, popups, and redirects inside the Help webview.

The manual must not include live screenshots, Orbit credentials, app tokens, email addresses, device identifiers, property-specific schedules, zone names, yard-run recipes, raw request data, or logs. Screenshots can be added later only from synthetic demo data.

## Diagnostics

Wrappers should provide Copy Diagnostics. Diagnostics may include:

- App version.
- Node path and version.
- WebView/runtime status.
- Server status and port.
- Settings, config, data, and log paths.
- Recent redacted wrapper/server log lines.

Diagnostics must not include Orbit credentials, app tokens, email addresses, device identifiers, yard-run recipes, snapshots, or raw request payloads.

## Process Lifecycle

Wrappers should start the server on app launch after setup is complete. Closing the app stops a server managed by that wrapper. If the wrapper attaches to an already-running controller, it should ask before stopping that external process.

After service verification, wrappers may load the dashboard with `APP_TOKEN` in the URL fragment as `#token=...`. The fragment is not transmitted to the HTTP server; the dashboard removes it from the visible URL and keeps the value only in page memory. Source-checkout browsers without a wrapper remain read-only until the operator explicitly unlocks writes with the token.

Wrappers must not kill unknown Node processes. If the configured port is occupied by an unknown process, the UI should explain the conflict and suggest another port.
