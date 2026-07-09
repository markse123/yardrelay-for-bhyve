# Source Provenance

The canonical [`markse123/yardrelay-for-bhyve`](https://github.com/markse123/yardrelay-for-bhyve) repository is YardRelay's fresh-history public-source boundary. YardRelay is a separately maintained local-controller implementation informed by documented behavior and by review of permissively licensed community projects. Research clones, captured account data, upstream fixtures, vendor artwork, and third-party brand assets are excluded from this repository and its release artifacts.

## Reviewed snapshots

The following private research snapshots were matched to public Git commits before the YardRelay clean-history work began:

| Project | Reviewed version | Exact commit | How it informed YardRelay |
| --- | --- | --- | --- |
| `billchurch/bhyve-api` | 1.2.4 | [`b02ebe84fa8a40b2fc236ea9c05ac8d5e6ab3774`](https://github.com/billchurch/bhyve-api/tree/b02ebe84fa8a40b2fc236ea9c05ac8d5e6ab3774) | Orbit API and websocket behavior research. |
| `sebr/bhyve-home-assistant` | 4.1.2 | [`d412ca91f854c3b9f91df9781d6e78eaf972906a`](https://github.com/sebr/bhyve-home-assistant/tree/d412ca91f854c3b9f91df9781d6e78eaf972906a) | Device, zone, and program behavior research. |
| `sebr/pybhyve` | 1.0.2 | [`df8316f174bf3cf18db34d62c378b5da6af1c8fc`](https://github.com/sebr/pybhyve/tree/df8316f174bf3cf18db34d62c378b5da6af1c8fc) | Independent comparison of Orbit client semantics. |
| `reypm/Orbit-BHyve-Custom-Card` | No release version declared in the reviewed snapshot | [`307acd07b49958eadbcb82eb31318d370ff0520e`](https://github.com/reypm/Orbit-BHyve-Custom-Card/tree/307acd07b49958eadbcb82eb31318d370ff0520e) | UI and device-state research only; its artwork and branding are not used. |

The license notices for these snapshots are preserved in [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md). Their inclusion there is attribution, not a claim that the entire upstream projects are redistributed.

## Clean repository boundary

The earlier private development repository once contained local research copies in historical commits. Rewriting or publishing that history would create avoidable privacy and attribution risk, so it must remain private. This repository was created separately with fresh history. Its root commit, `b864287de7ac398042e20b5cfecc754d195a1f58` (`Initialize YardRelay foundation`), was prepared from and audited against private development revision `1f5136a5e70cf9c081b0fdbc1c535675212844a1`. The two trees are not byte-identical: the clean boundary is a curated public-source tree, not an exact copy. Do not join, rebase, merge, or import Git objects from the earlier repository into this one.

Fresh history establishes the repository boundary but does not make later commits safe automatically. Treat every commit here as public-ready regardless of the repository's current visibility. Before each release, and after any exceptional history rewrite or import, verify that no ignored local files, account data, device identifiers, property-specific recipes, snapshots, logs, build products, research clones, or third-party brand assets are present in the repository or release artifacts. Retain the project license, this provenance record, and all applicable third-party notices.
