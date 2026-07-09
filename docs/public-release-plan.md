# Public Release Plan

This document records release intent; it does not authorize publication or a repository visibility change.

## Repository boundary

- Keep the earlier development repository private permanently because its old history contains research material that is outside the public source boundary.
- Treat the canonical [`markse123/yardrelay-for-bhyve`](https://github.com/markse123/yardrelay-for-bhyve) repository, rooted at clean-history commit `b864287de7ac398042e20b5cfecc754d195a1f58` and prepared from/audited against private revision `1f5136a5e70cf9c081b0fdbc1c535675212844a1`, as the only public-source and release repository. The two trees are not byte-identical.
- Keep this repository **private** until the owner explicitly approves making it public after the remaining gates below pass.
- Keep in-app release links disabled while this repository is private and until the public release destination has been verified.
- Do not copy branches, tags, issues, releases, commits, or other Git objects from the earlier development repository.
- Before changing visibility, inspect every author and committer name and email in the history that will become public. Explicitly approve intended identities, and rewrite unintended employer or personal email disclosure in this clean repository before publication.

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

## Public-readiness gate

Creating the fresh-history repository completed the repository-boundary step only; it did not complete the public release. Before changing repository visibility, complete and review the safety/data phase, usability phase, Windows runtime packaging, migration validation, manual backup/restore validation including DPAPI portability limits, security scan, license/provenance audit, privacy scan, clean-export inventory, and release-candidate tests. Verify private vulnerability reporting and re-run the checklist in [`SECURITY.md`](../SECURITY.md) immediately before publication.
