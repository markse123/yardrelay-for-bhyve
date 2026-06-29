# Repository Agent Guidance

These instructions apply to the entire repository. Use `README.md`,
`SECURITY.md`, and `docs/desktop-setup.md` as the canonical sources for
detailed product, security, and desktop-wrapper guidance.

## Scope And Worktree Safety

- Inspect the repository and `git status` before editing. Preserve all
  pre-existing changes and do not overwrite, reformat, stage, stash, reset,
  discard, or commit unrelated work.
- Keep changes within the user's requested scope. Do not commit, push, create
  or update a pull request, publish a release, or change repository settings
  unless the user explicitly authorizes that action.
- Prefer repository evidence over assumptions. Read the relevant code, tests,
  configuration, and documentation before asking a question that they can
  answer.

## Design Before Implementation

Use an interview-first workflow for new features, product ideas, architecture
changes, and materially changed behavior. A full design interview is not
required for a clearly scoped bug fix, routine maintenance, a mechanical
refactor with no behavior change, or work for which the user has already given
complete acceptance criteria.

When an interview is required:

1. Explore the codebase first and identify the decisions that remain open.
2. Walk through dependent decisions one at a time. Independent, low-impact
   questions may be grouped only when their answers do not affect one another.
3. For every question, provide a recommended answer and explain the relevant
   tradeoff.
4. Continue until the behavior, boundaries, failure cases, security and privacy
   implications, platform impact, and acceptance criteria are understood.
5. Read-only exploration, diagnostics, and feasibility checks are allowed
   during the interview. Do not edit files while relevant design decisions are
   unresolved.
6. Before implementation, summarize the agreed design, assumptions, acceptance
   criteria, validation plan, and any unresolved items. Begin editing after the
   user confirms that checkpoint or directly tells you to proceed.

## Safety And Privacy Boundaries

- This is a local/private-network controller. Do not broaden network exposure,
  weaken authentication or origin checks, change secret handling, add
  executable automatic updates, or make the service internet-facing without
  first explaining the threat-model impact and receiving explicit approval.
- Never commit `.env`, `config/yard-runs.local.json`, `data/`, snapshots, logs,
  generated packages, credentials, app tokens, private keys, Orbit device IDs,
  home or property details, or screenshots containing private data. Follow
  `SECURITY.md` for the complete policy.
- Do not run diagnostics or tests that start or stop watering, modify programs,
  or otherwise mutate the live Orbit account unless the user explicitly
  authorizes that exact operation. Prefer mocks, fixtures, local integration
  tests, and read-only account validation.
- Prefer the standard library and existing dependencies. Before adding a
  production dependency, explain why it is needed, alternatives considered,
  and maintenance and security implications, then obtain approval. Apply the
  same process to development dependencies that materially change the
  toolchain.

## Desktop And Documentation Contracts

- For desktop-wrapper work, determine first whether the behavior belongs in the
  shared contract in `docs/desktop-setup.md`. Keep shared behavior documented
  there and call out intentional macOS/Windows parity gaps.
- For user-visible capability changes, update `docs/project-capabilities.json`
  and its repository evidence, then run `npm run docs:update`.
- Do not manually edit content between generated markers in `README.md` or
  `public/help/index.html`; change the manifest or generator inputs instead.

## Implementation And Validation

- Add focused automated coverage for new or changed behavior. A bug fix should
  include a regression test when practical. If automated coverage is not
  practical, explain why and provide a concrete manual verification procedure.
- Use validation appropriate to the changed surface:
  - Always run `npm run privacy:scan`.
  - Run `npm run docs:check` before completion.
  - Run `npm test` for JavaScript, server, browser UI, shared documentation, or
    configuration changes.
  - Run `swift build --package-path mac/BHyveControllerApp` when macOS wrapper
    files change.
  - Build and test the Windows wrapper when Windows files change and a suitable
    environment is available; otherwise report the validation gap explicitly.
  - For agent-guidance-only documentation changes, the privacy scan,
    documentation-drift check, and focused diff review are sufficient.
- Review the final diff for correctness, security and privacy regressions,
  accidental generated-file edits, and unrelated changes. Report validations
  run, validations skipped, and residual risks clearly.
