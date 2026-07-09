# Security Policy

## Supported Use

YardRelay is intended for one trusted user's local operation. The default server binds to `127.0.0.1`, keeps Orbit credentials in local backend-only storage, and allows prompt-free controls for same-computer loopback clients. `protected` mode requires an `X-App-Token` header for every browser write request, while `local` mode requires it for non-loopback clients. The existing `trusted-network` mode is a private-development compatibility option, not a supported public deployment model. `/api/config` never returns the token. Source-checkout users enter it explicitly when required, while native wrappers verify a fresh HMAC service-identity challenge before passing it to the embedded dashboard. Wrapper shutdown uses a separate one-time, purpose-bound HMAC proof rather than transmitting the long-lived token.

Do not expose this controller directly to the public internet. `WRITE_ACCESS_MODE=protected` is an extra local-control safeguard, not public-internet authentication. If remote access is needed later, put a reviewed authentication layer, TLS, and rate limiting in front of it first.

YardRelay does not send project-operated telemetry or analytics. To provide its controller features, it sends Orbit account credentials to Orbit's login service and exchanges account and device state, device identifiers, and control commands with Orbit's cloud API and event service. The YardRelay app token, local watering recipes, snapshots, and diagnostics stay local unless the user deliberately shares them.

## Supported Versions

| Version | Security support |
| --- | --- |
| Unreleased `main` development branch | Active development; not a public supported release |
| Public YardRelay releases | None published or supported yet |

After the first public beta is published, only the latest published beta will receive security fixes. Users will need to upgrade to that beta before expecting a fix. The private advisory form below is the canonical route for every security report, including reports against unreleased development code.

## Reporting Issues

Use this repository's [GitHub private vulnerability reporting form](https://github.com/markse123/yardrelay-for-bhyve/security/advisories/new) to report security issues privately. If GitHub private reporting is unavailable, open a public issue containing no vulnerability details or private data and ask the owner to enable a private reporting channel before sharing the report. Do not include Orbit credentials, app tokens, home addresses, screenshots with private location data, raw request logs, or property-specific watering recipes in a public issue.

## Secret Handling

- Never commit `.env`, `config/yard-runs.local.json`, `data/`, snapshots, request logs, desktop app data folders, SSH keys, API tokens, or generated app credentials.
- Use the sample values in `.env.example` as placeholders only.
- Rotate `APP_TOKEN` and Orbit credentials if they are ever exposed.

## Public Release Checklist

The earlier development repository and its historical research commits must remain private. This `yardrelay-for-bhyve` repository is the separately created fresh-history release boundary. Keep it private until its clean-source boundary and every remaining release gate have been reviewed and the owner explicitly approves changing its visibility.

- Confirm property-specific watering-run recipes, controller names, and Orbit device IDs are only present in ignored local files.
- Publish only from this `yardrelay-for-bhyve` repository. Do not import branches, tags, commits, or other Git objects from the earlier development repository.
- Review every author and committer name and email in the history that will become public. Explicitly approve the identities that are intentional, and rewrite unintended employer or personal email disclosure in this clean repository before changing visibility.
- Do not commit local research clones or raw upstream fixtures; keep attribution in `README.md` and preserve upstream licenses when reusing source.
- Remove or sanitize copied fixtures that contain real-looking addresses, device IDs, MAC addresses, account IDs, or location data.
- Remove any private snapshots, logs, screenshots, addresses, or generated bundles.
- Confirm CI, dependency updates, and secret scanning are enabled in GitHub.
- Confirm GitHub private vulnerability reporting is enabled and the reporting link above works without revealing report contents publicly.
- Confirm [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md), [docs/provenance.md](docs/provenance.md), and [docs/public-release-plan.md](docs/public-release-plan.md) are current.
