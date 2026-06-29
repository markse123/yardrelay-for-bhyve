# Public Release Plan

This document records release intent; it does not authorize publication or a repository visibility change.

## Repository boundary

- Keep the current development repository private permanently because its old history contains research material that is outside the public source boundary.
- Create a separate `yardrelay-for-bhyve` repository from an audited source export with fresh Git history.
- Create the new repository as **private** and keep it private until the owner explicitly approves making it public.
- Keep in-app release links disabled until that private repository exists and the destination has been verified.
- Do not copy branches, tags, issues, releases, or Git objects from the development repository.

## First beta target

- Product name: **YardRelay**.
- Compatibility subtitle: **Unofficial local controller for Orbit B-hyve devices**.
- First intended public beta: `v0.2.0`; remain on `0.x` while interfaces, migrations, and packaging are still changing.
- Official packaged target: Windows 11 x64. The macOS wrapper remains experimental and source-built for the first beta.
- One Orbit B-hyve account and one trusted local user per installation.
- Loopback-only operation is the supported deployment. Public-internet hosting and multi-user authentication are out of scope.

## Trust and release controls

- `package.json` is the canonical product-version source. Platform metadata must pass `npm run metadata:check`.
- Release provenance must record exact Node, .NET, Swift, runner-image, and packaging-tool versions rather than relying only on floating major-version channels.
- CI validates source, documentation, privacy controls, wrappers, and package shape; ordinary `main` pushes do not publish installers.
- A later release workflow may run only for version tags, create a **draft** release, and require a human to inspect and publish it.
- An unsigned beta installer must be plainly identified as unsigned and accompanied by SHA-256 checksums, a software bill of materials, and build provenance. Code signing and notarization remain future improvements.
- No silent auto-update, telemetry, or background analytics are planned.
- Preserve user data by default during uninstall. Destructive reset and backup recovery must remain explicit operations.

## Public-readiness gate

Before changing repository visibility, complete and review the safety/data phase, usability phase, Windows runtime packaging, migration behavior, encrypted backup design, security scan, license/provenance audit, privacy scan, clean-export inventory, and release-candidate tests. Re-run the checklist in [`SECURITY.md`](../SECURITY.md) immediately before publication.
