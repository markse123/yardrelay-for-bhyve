# Security Policy

## Supported Use

YardRelay is intended for one trusted user's local operation. The default server binds to `127.0.0.1`, keeps Orbit credentials in local backend-only storage, and allows prompt-free controls for same-computer loopback clients. `protected` mode requires an `X-App-Token` header for every browser write request, while `local` mode requires it for non-loopback clients. The existing `trusted-network` mode is a private-development compatibility option, not a supported public deployment model. `/api/config` never returns the token. Source-checkout users enter it explicitly when required, while native wrappers verify a fresh HMAC service-identity challenge before passing it to the embedded dashboard. Wrapper shutdown uses a separate one-time, purpose-bound HMAC proof rather than transmitting the long-lived token.

Do not expose this controller directly to the public internet. `WRITE_ACCESS_MODE=protected` is an extra local-control safeguard, not public-internet authentication. If remote access is needed later, put a reviewed authentication layer, TLS, and rate limiting in front of it first.

YardRelay collects no telemetry. Account credentials, app tokens, device identifiers, watering recipes, snapshots, and diagnostics stay local unless the user deliberately shares them.

## Reporting Issues

Report security issues privately through GitHub security advisories if available, or contact the repository owner directly. Do not include Orbit credentials, app tokens, home addresses, screenshots with private location data, raw request logs, or property-specific watering recipes in a public issue.

## Secret Handling

- Never commit `.env`, `config/yard-runs.local.json`, `data/`, snapshots, request logs, desktop app data folders, SSH keys, API tokens, or generated app credentials.
- Use the sample values in `.env.example` as placeholders only.
- Rotate `APP_TOKEN` and Orbit credentials if they are ever exposed.

## Public Release Checklist

The current development repository and its historical research commits must remain private. Before making any YardRelay repository public:

- Confirm property-specific watering-run recipes, controller names, and Orbit device IDs are only present in ignored local files.
- Publish only from the separately audited `yardrelay-for-bhyve` repository with fresh history. Create that repository as private first and change visibility only after an explicit human decision.
- Do not commit local research clones or raw upstream fixtures; keep attribution in `README.md` and preserve upstream licenses when reusing source.
- Remove or sanitize copied fixtures that contain real-looking addresses, device IDs, MAC addresses, account IDs, or location data.
- Remove any private snapshots, logs, screenshots, addresses, or generated bundles.
- Confirm CI, dependency updates, and secret scanning are enabled in GitHub.
- Confirm [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md), [docs/provenance.md](docs/provenance.md), and [docs/public-release-plan.md](docs/public-release-plan.md) are current.
