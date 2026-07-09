# YardRelay

**Unofficial local controller for Orbit B-hyve devices.**

YardRelay is a hobby project that runs on one trusted local computer, talks to Orbit using the same account credentials you already use, and gives one local dashboard for devices, zones, programs, watering history, logs, and configurable multi-zone manual runs.

YardRelay is not affiliated with, endorsed by, or supported by Orbit, B-hyve, Home Assistant, or any upstream research project. Orbit and B-hyve are names used only to describe compatible devices and services.

The supported deployment is same-computer, loopback-only use—not LAN or public hosting. Property-specific watering-run recipes belong in `config/yard-runs.local.json`, which is intentionally gitignored.

## Features

<!-- BEGIN GENERATED:CAPABILITIES -->
- **Local dashboard:** View controllers, zones, active watering, upcoming schedules, watering history, events, and sanitized logs in one local interface.
  - Pause live logs automatically while selecting text or inspecting older entries, then resume at the latest entry.
  - Copy sanitized log entries and responses, and open controller status details with a user-triggered one-time retry.
- **Manual watering:** Start and stop individual zones with configurable run-time caps and safeguards against conflicting known activity.
- **Program controls:** Enable, disable, start, and edit supported fields on existing Orbit programs while keeping smart programs read-only.
  - Program changes are snapshotted locally before the Orbit API is updated.
- **Named yard runs:** Run locally configured groups such as a front yard, garden, or planter sequence one zone at a time.
  - Adjust minutes per zone before starting.
  - Queue additional runs without watering shared zones twice.
  - Stop the active zone and clear the remaining queue from one control.
  - Recover the active queue display after a local server restart.
- **Local browser write access:** Keep same-computer loopback controls prompt-free or require the app token for every browser.
  - The older trusted-network mode remains for private-development compatibility and is not a supported public deployment.
- **Optional desktop apps:** Run the same local controller in a macOS SwiftUI wrapper or a Windows WPF and WebView2 wrapper.
  - Both wrappers verify the local controller before loading its embedded dashboard.
  - Windows includes a per-user setup flow with encrypted credential storage and a read-only Orbit login test.
- **Searchable offline Help:** Open the bundled setup, daily-use, privacy, and troubleshooting guide from the dashboard or either desktop wrapper without starting the controller server.
<!-- END GENERATED:CAPABILITIES -->

## Safety Model

This is not a cloud-hosted app. The supported deployment is one trusted user on one local computer.

- The server binds to `127.0.0.1` by default.
- Orbit credentials stay in backend-only storage: `.env` for source checkout use, or native secret storage for desktop wrappers that implement the shared setup contract.
- Browser write requests are prompt-free for same-computer loopback clients by default. `protected` mode requires an `X-App-Token` for every browser. The older `trusted-network` mode remains for private-development compatibility but is not a supported public deployment. `/api/config` never returns the token.
- Native wrappers authenticate the controller with a fresh HMAC challenge before loading its UI. The verified UI receives the token in a URL fragment that is immediately removed, while wrapper shutdown uses a separate one-time HMAC proof instead of transmitting the long-lived token. Port ownership and loopback reachability alone are not trusted as controller identity.
- Host and Origin checks reject untrusted browser requests.
- Event streams cap concurrent clients and buffered bytes; a slow client stops receiving frames until it drains and is disconnected after a bounded timeout.
- Program writes save snapshots under `data/snapshots/` before changing Orbit state.
- Active yard-run queue state is saved under ignored `data/` files so the Programs tab can recover "Now" and "Next" after a local server restart. When an app token is available, recovery snapshots are integrity-checked before replay and reconciled against the current Orbit device list. Desktop wrappers can move runtime state by setting `BHYVE_DATA_DIR`.
- `.env`, `data/`, build output, and dependency folders are gitignored.

Do not expose this server directly to the internet. If remote access is added later, put real authentication, TLS, and rate limiting in front of it.

## Requirements

<!-- BEGIN GENERATED:REQUIREMENTS -->
- Orbit B-hyve account credentials.
- Node.js 24 or newer for the local server and current desktop wrappers.
- macOS 14 or newer for the optional Mac wrapper app.
- Windows 11 or newer plus WebView2 Runtime for the optional Windows wrapper app.
<!-- END GENERATED:REQUIREMENTS -->

## Source Checkout Setup

Use this path when running the controller directly from the repository.

Install dependencies from the lockfile:

```bash
npm ci
```

Copy the sample environment file:

```bash
cp .env.example .env
```

Edit `.env`:

```dotenv
ORBIT_EMAIL=you@example.com
ORBIT_PASSWORD=your-orbit-password
HOST=127.0.0.1
PORT=3030
APP_TOKEN=replace-with-a-long-random-local-token
WRITE_ACCESS_MODE=local
YARD_RUN_CONFIG=config/yard-runs.local.json
MAX_SSE_CLIENTS=16
MAX_SSE_BUFFER_BYTES=1048576
SSE_DRAIN_TIMEOUT_MS=5000
```

Set up watering-run recipes if you want named multi-zone controls:

```bash
cp config/yard-runs.example.json config/yard-runs.local.json
```

Edit `config/yard-runs.local.json` with named runs, Orbit device IDs, controller names, station numbers, zone labels, and optional per-run default minutes. The local file is ignored by git because it describes your property and controller IDs.

The current config supports the generic `runs` shape:

```json
{
  "version": 1,
  "runs": [
    {
      "key": "front",
      "label": "Front yard",
      "defaultMinutes": 10,
      "zones": []
    }
  ]
}
```

Older `areas.front` / `areas.back` configs still load for compatibility.

Start the server:

```bash
npm start
```

Open:

```text
http://127.0.0.1:3030
```

The default `WRITE_ACCESS_MODE=local` keeps controls prompt-free when the dashboard and server are on the same computer. Binding the server beyond loopback is unsupported and requires a separate security design.

Write-access modes:

- `local` (default): loopback clients can use controls immediately. This is the supported mode.
- `protected`: every browser client must unlock with `APP_TOKEN`.
- `trusted-network`: legacy private-development compatibility. It removes the token gate for clients admitted by Host and Origin checks and is not supported for public builds.

The browser never receives the configured token from `/api/config`. When a token is entered or supplied by a verified desktop wrapper, it stays in page memory and is removed from the visible URL.

For long-running use, start the server from your own terminal so the process is not tied to a transient agent console.

## Local Files

- `.env` stores Orbit credentials, the local write token, host, port, and optional config paths.
- `config/yard-runs.local.json` stores property-specific watering runs and controller IDs.
- `data/` stores local runtime files such as program snapshots and active yard-run recovery state.
- `BHYVE_DATA_DIR` can move runtime state for native desktop wrappers.

These files and folders are intentionally ignored by git. Keep examples generic and use placeholders in public issues, PRs, screenshots, and docs.

## Desktop Apps

Native wrappers are optional. They provide a desktop shell around the same local Node controller and browser UI.

Common behavior:

- The wrapper starts `node server/app.js` with environment variables.
- The wrapper verifies the local service with a fresh `APP_TOKEN`-keyed HMAC challenge before trusting an existing listener, sending credentials, or loading the embedded UI.
- The wrapper passes the app token to the verified dashboard in a URL fragment. Fragments are not sent in HTTP requests, and the dashboard removes it from the visible URL after reading it into memory.
- Embedded browsers allow navigation only to the exact configured loopback controller origin and reject popups or redirects elsewhere.
- Runtime state is stored outside the app bundle by setting `BHYVE_DATA_DIR`.
- Desktop setup should follow the shared contract in `docs/desktop-setup.md`.
- Release checks remain disabled while this clean-history repository is private and until its public release destination has been verified. V1 does not silently download, execute, or replace app binaries.
- Help opens the bundled guide from `public/help/index.html`, including when the local controller server is stopped.
- Help opens approved download and release links in the system browser instead of navigating the embedded controller view.

### Mac Wrapper

`mac/BHyveControllerApp` contains a lightweight SwiftUI wrapper that can start, stop, and restart the local Node controller on the configured port. Shutdown is requested through this controller's API so it does not scan for unrelated Node processes.

The current Mac wrapper still uses the source-checkout `.env` setup path. A future parity pass should move it to the shared desktop setup model with Keychain and Application Support storage.

Use the Help toolbar button or **Help > YardRelay Help** to open the bundled guide without starting the controller server.

Build it from the wrapper folder:

```bash
cd mac/BHyveControllerApp
swift build
```

### Windows Wrapper

`windows/BHyveControllerApp` contains a WPF/WebView2 wrapper with a first-run setup wizard. It stores non-secret settings under `%LOCALAPPDATA%\YardRelay`, encrypts Orbit credentials for the current Windows user with DPAPI, and starts the Node controller with environment variables instead of writing an installed `.env` file. On first startup after an older installation, it prefers an existing YardRelay folder unchanged. Only when that destination is absent, it makes a staged one-time copy of `%LOCALAPPDATA%\BHyveController`, retains the legacy source, and then uses the new folder. It never merges into or overwrites an existing destination, and later startups are a no-op. Within copied `settings.json`, only the exact legacy default data and yard-run config paths are rewritten; custom paths are preserved.

The wizard checks Node.js and WebView2, lets the user enter Orbit credentials, offers a read-only Test Orbit Login button, generates the local app token, and can import an existing `.env` or yard-run config as a migration shortcut. Its optional browser-control lock selects `WRITE_ACCESS_MODE=protected`; it is off by default for prompt-free loopback controls.

The Help button is available from both the main toolbar and Desktop setup, so setup and recovery guidance remains available before the controller server starts.

Build the wrapper:

```powershell
dotnet build windows/BHyveControllerApp/BHyveControllerApp.csproj -c Release
```

Create the Windows package zip with a self-contained .NET runtime. Node.js 24 or newer and WebView2 Runtime are still required on the target computer:

```powershell
./windows/package-windows.ps1 -Runtime win-x64
```

Create the per-user installer on Windows with Inno Setup 6 installed:

```powershell
./windows/package-windows.ps1 -Runtime win-x64 -BuildInstaller
```

The package output is written under `outputs/windows/`. The zip is `YardRelay-win-x64.zip`; the installer is `YardRelaySetup-<version>.exe` when `-BuildInstaller` is used. CI validates the Windows package shape without publishing installable artifacts. Version tags that exactly match `package.json` run the separate release workflow, which builds the unsigned installer, scans the final publish tree, generates SHA-256 checksums, an SPDX software bill of materials, and build provenance, and creates a draft prerelease for human inspection. The workflow never publishes the draft automatically; signing and repository visibility remain separate human-controlled gates described in [the public release plan](docs/public-release-plan.md).

The app expects Node.js 24 or newer and WebView2 Runtime on the target machine; setup links to the official download pages when either prerequisite is missing.

#### Install an unsigned Windows beta

After a beta is published:

1. Download `YardRelaySetup-<version>.exe` and its published SHA-256 checksum from this repository's verified GitHub release page. Do not use an installer copied from another site.
2. In PowerShell, calculate the installer checksum:

   ```powershell
   Get-FileHash .\YardRelaySetup-<version>.exe -Algorithm SHA256
   ```

3. Compare the complete hexadecimal hash with the value published on the release page. Do not run the installer if they differ.
4. Run the installer. The beta is unsigned, so Microsoft Defender SmartScreen may show **Windows protected your PC** and **Unknown publisher**. Only after the source and checksum match, select **More info**, confirm the app is `YardRelaySetup-<version>.exe`, and select **Run anyway**. Do not bypass any different or unexpected warning.
5. Complete Desktop setup. Install Node.js 24 or newer and WebView2 Runtime first if the prerequisite check reports either one missing.

To uninstall, open **Windows Settings > Apps > Installed apps**, find **YardRelay**, and choose **Uninstall**. Uninstall removes the app but preserves `%LOCALAPPDATA%\YardRelay` so settings, encrypted credentials, configuration, snapshots, and logs are not destroyed automatically.

#### Back up or restore Windows data

Quit YardRelay and make sure its managed controller has stopped before copying app data. Back up the complete `%LOCALAPPDATA%\YardRelay` folder. Restore only while YardRelay is stopped, and never merge a backup into an existing app-data folder: rename or move the existing `%LOCALAPPDATA%\YardRelay` directory first, then copy the backup into that exact location.

This is a manual local backup/restore procedure, not an encrypted archive feature. Only `secrets.bin` is DPAPI-protected; settings, configuration, data, snapshots, and logs may contain sensitive property or device information in plaintext. Keep the backup private and encrypted at rest. The DPAPI-protected credentials are usable only by the same Windows user/profile that created them and are not portable to another profile or computer; re-enter Orbit credentials when restoring elsewhere.

## Development

The command reference below is regenerated from `docs/project-capabilities.json` and current project files. Add user-visible capabilities to that manifest with repository evidence; `npm test` refreshes generated sections before running the test suite, while CI uses `npm run docs:check` to reject uncommitted drift.

<!-- BEGIN GENERATED:DEVELOPMENT-COMMANDS -->
Install dependencies from the lockfile:

```bash
npm ci
```

Start the local controller:

```bash
npm start
```

Regenerate project documentation and run all checks:

```bash
npm test
```

Regenerate the README and shared Help capability summary without running tests:

```bash
npm run docs:update
```

Check generated documentation for drift without changing files:

```bash
npm run docs:check
```

Check canonical package identity and platform versions for drift:

```bash
npm run metadata:check
```

Scan tracked and untracked repository files for private data:

```bash
npm run privacy:scan
```

Audit production dependencies for high-severity vulnerabilities:

```bash
npm audit --audit-level=high
```
<!-- END GENERATED:DEVELOPMENT-COMMANDS -->

Build the optional wrappers:

<!-- BEGIN GENERATED:WRAPPER-BUILD-COMMANDS -->
Build the optional macOS wrapper:

```bash
swift build --package-path mac/BHyveControllerApp
```

Build the optional Windows wrapper:

```powershell
dotnet build windows/BHyveControllerApp/BHyveControllerApp.csproj -c Release
```

Create the Windows package with a bundled .NET runtime:

```powershell
./windows/package-windows.ps1 -Runtime win-x64
```
<!-- END GENERATED:WRAPPER-BUILD-COMMANDS -->

## GitHub Controls

This repo includes:

- `.github/workflows/ci.yml` to check generated-documentation drift, run `npm ci`, `npm test`, `npm run privacy:scan`, `npm audit --audit-level=high`, a macOS Swift build, and a Windows wrapper package validation build.
- `.github/dependabot.yml` for weekly npm and GitHub Actions update checks.
- `.github/pull_request_template.md` with a privacy and remote-access review checklist.
- `SECURITY.md` with local-use boundaries, secret-handling guidance, and public-release checklist.

Recommended repository settings:

- Enable secret scanning and push protection if available for the account.
- Enable Dependabot security alerts and update PRs.
- Protect `main` from force pushes and deletion.
- Require the CI workflow before merging pull requests once branch protection is configured.
- Use a GitHub noreply email address if you do not want commits to expose a personal email.

## Reporting Security Issues

Please follow [SECURITY.md](SECURITY.md). Do not include Orbit credentials, app tokens, home addresses, screenshots with private location data, raw request logs, or property-specific watering recipes in public issues.

## Scope

In scope:

- Local control of existing B-hyve devices and programs.
- Manual zone runs.
- Watering-run sequencing for configured local property recipes.
- Recovering the local yard-run queue display and remaining sequence after a controller restart.
- Viewing recent watering history and local logs.

Out of scope for now:

- Creating or deleting Orbit programs.
- Editing smart programs.
- Public internet hosting.
- Multi-user auth.
- UI editing for generic watering-run configuration.

## Privacy Notes

Keep Orbit device IDs and local watering-run recipes in `config/yard-runs.local.json`. That file is ignored by git and should not be copied into issues, screenshots, release bundles, or public examples.

Never commit:

- `.env`
- `data/`
- snapshots or logs
- screenshots with location data
- SSH keys
- Orbit credentials or app tokens
- `config/yard-runs.local.json`

## Credits And Upstream Research

This clean-history repository was created as the public-source boundary for YardRelay. The earlier private development repository and its Git history are not part of this repository and must not be imported. The project was built with help from local research copies of existing open-source B-hyve and Home Assistant projects. Those research clones are not vendored because fixtures can contain real-looking addresses, device identifiers, or account-specific values. The exact reviewed snapshots, their role, and their license notices are recorded in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and [docs/provenance.md](docs/provenance.md).

Credited sources:

- [billchurch/bhyve-api](https://github.com/billchurch/bhyve-api/tree/b02ebe84fa8a40b2fc236ea9c05ac8d5e6ab3774), version 1.2.4, MIT License.
- [sebr/bhyve-home-assistant](https://github.com/sebr/bhyve-home-assistant/tree/d412ca91f854c3b9f91df9781d6e78eaf972906a), version 4.1.2, MIT License.
- [sebr/pybhyve](https://github.com/sebr/pybhyve/tree/df8316f174bf3cf18db34d62c378b5da6af1c8fc), version 1.0.2, MIT License.
- [reypm/Orbit-BHyve-Custom-Card](https://github.com/reypm/Orbit-BHyve-Custom-Card/tree/307acd07b49958eadbcb82eb31318d370ff0520e), reviewed snapshot, MIT License.

The root project is also released under the MIT License; see [LICENSE](LICENSE).

## Disclaimer

YardRelay is unofficial and is not affiliated with, endorsed by, or supported by Orbit, B-hyve, Home Assistant, or the upstream research projects. Use it carefully: sprinkler control can affect landscaping, water use, and hardware behavior.

All product names and trademarks belong to their respective owners.
