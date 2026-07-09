# YardRelay Mac App

Experimental macOS wrapper for YardRelay, an unofficial local controller for Orbit B-hyve devices.

The app is a native SwiftUI shell with a `WKWebView` for the existing local UI. It can start, stop, and restart the YardRelay server on its configured local port. If a controller server is already running in a terminal, the app accepts it only after verifying a fresh HMAC service-identity challenge with the configured `APP_TOKEN`. Native shutdown uses a separate one-time HMAC proof, so the long-lived token is not sent to a newly occupied port. The app does not scan for, trust, or send credentials to unrelated Node processes or arbitrary port owners.

The wrapper accepts an explicit `APP_TOKEN` only when it is 32–512 printable ASCII characters with no surrounding whitespace and is not a sample or generic placeholder. Replace the rejected value from `.env.example`, for example with `openssl rand -hex 32`, before probing or starting the controller. If the token is absent, the wrapper generates a temporary 32-byte random token for its managed server process.

## Requirements

- macOS 14 or newer
- Xcode command line tools
- Node.js 24 or newer available on `PATH`
- `.env` configured in the repository root

## Run During Development

From this folder:

```bash
swift run
```

The app looks for the server root automatically. If you move this wrapper, set:

```bash
export BHYVE_CONTROLLER_ROOT=/path/to/bhyve-local-controller
```

`BHYVE_CONTROLLER_ROOT`, `BHYVE_NODE_PATH`, the Swift package target, and its executable name are transitional compatibility identifiers retained for existing private-development installs. The user-visible product name is YardRelay.

The packaged app stores the Node executable path found at build time. If Node moves, set:

```bash
export BHYVE_NODE_PATH=/path/to/node
```

## Build A Local App Bundle

From this folder:

```bash
scripts/build-app.sh
open ".build/app/YardRelay.app"
```

The generated app bundle keeps using the Node server from the repository root. It does not bundle Node or the server files yet.

## First-Version Scope

- Normal dock app
- Native start, stop, restart, reload controls
- Embedded local controller UI
- Generated Dock icon
- Detects and stops an externally running YardRelay server on the configured local port
- Requires installed Node
- Uses the existing `.env` file
