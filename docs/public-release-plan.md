# Public Release Plan

This document records the enduring release boundary and controls. It does not itself publish a release or change repository visibility.

## Repository boundary

- Keep the earlier development repository private permanently because its old history contains research material that is outside the public source boundary.
- Treat the canonical [`markse123/yardrelay-for-bhyve`](https://github.com/markse123/yardrelay-for-bhyve) repository, rooted at clean-history commit `b864287de7ac398042e20b5cfecc754d195a1f58` and prepared from/audited against private revision `1f5136a5e70cf9c081b0fdbc1c535675212844a1`, as the only public-source and release repository. The two trees are not byte-identical.
- Treat every commit in the canonical repository as public-ready regardless of its current GitHub visibility. Visibility changes remain explicit owner actions outside the source tree.
- Link only to the canonical repository's GitHub release page. It may be unavailable before the visibility change or contain no releases before the first beta; the app must not silently poll or install updates.
- Do not copy branches, tags, issues, releases, commits, or other Git objects from the earlier development repository.
- Review author and committer names and email addresses as commits are added. Repeat the complete identity and history review after any exceptional rewrite or import.

## First beta target

- Product name: **YardRelay**.
- Compatibility subtitle: **Unofficial local controller for Orbit B-hyve devices**.
- First intended public beta: `v0.2.0`; remain on `0.x` while interfaces and packaging are still changing.
- Official packaged target: Windows 11 x64. The macOS wrapper remains experimental and source-built for the first beta.
- One Orbit B-hyve account and one trusted local user per installation.
- Loopback-only operation is the supported deployment. Public-internet hosting and multi-user authentication are out of scope.

## Trust and release controls

- `package.json` is the canonical product-version source. Platform metadata must pass `npm run metadata:check`.
- Release provenance must record every applicable toolchain exactly rather than relying only on floating major-version channels: Node, .NET, Inno Setup, Syft, PowerShell, and the runner image for the Windows beta; Swift must be added when a macOS artifact enters the release workflow.
- CI validates source, documentation, privacy controls, wrappers, and package shape; ordinary `main` pushes do not publish installers.
- The release workflow runs only for version tags that exactly match `package.json`, creates a **draft prerelease**, attaches checksums, an SPDX SBOM, and build provenance, and requires a human to inspect and publish it.
- An unsigned beta installer must be plainly identified as unsigned and accompanied by SHA-256 checksums, a software bill of materials, and build provenance. Code signing and notarization remain future improvements.
- Windows install guidance must direct users to the verified GitHub release, show `Get-FileHash -Algorithm SHA256` verification, explain the expected unsigned SmartScreen warning, and tell users never to bypass a mismatch or unexpected warning.
- No silent auto-update, telemetry, or background analytics are planned.
- Preserve user data by default during uninstall. Manual local backup and restore require the app to be stopped, a complete copy of `%LOCALAPPDATA%\YardRelay`, and replacement rather than merging of an existing destination. Only `secrets.bin` is DPAPI-protected; other files may contain sensitive property or device data in plaintext and backups should be encrypted at rest. DPAPI secrets remain bound to the originating Windows user/profile, so restores elsewhere require credentials to be entered again. Destructive reset must remain an explicit operation.
- The Windows wrapper implements the migration behavior in [`docs/desktop-setup.md`](desktop-setup.md): it prefers an existing `%LOCALAPPDATA%\YardRelay` destination; otherwise it makes a staged one-time copy of `%LOCALAPPDATA%\BHyveController`, retains the legacy source, never overwrites or merges a destination, rewrites only copied exact-default data/config paths, preserves custom paths, and makes later startups idempotent.

## Ongoing publication gate

The fresh-history repository is the publication boundary; merging source does not publish a packaged release. Before a human publishes each draft beta, review safety and data handling, usability, Windows runtime packaging, migration behavior, manual backup and restore including DPAPI portability limits, security results, license/provenance, privacy scanning, the clean artifact inventory, and release-candidate tests. Verify the external private-vulnerability-reporting route and re-run the checklist in [`SECURITY.md`](../SECURITY.md). Repository visibility and GitHub security settings remain separately controlled by the owner.
