# Contributing

Thanks for helping improve `pi-delegation-policy`.

## Before opening an issue

- Search existing issues.
- Include the package version or commit, Pi version, operating system, and a minimal reproduction.
- Remove credentials, session files, prompts, personal paths, model account identifiers, and
  unredacted logs.
- Report security vulnerabilities through [`SECURITY.md`](SECURITY.md), not a public issue.

## Checks

Run all of them before opening a pull request. CI runs the same commands.

```bash
npm ci
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
npm run pack:check
```

For a documentation change, also run the site checks:

```bash
cd wiki
npm ci
npm run check
```

## Pull requests

A pull request should:

- explain the user-visible behavior and the reason for the change
- include focused tests for behavior changes
- keep the public package English-only
- use fictional examples and provider-agnostic documentation
- preserve exact role references and the absence of model fallbacks
- preserve the boundary: no delegated work or child launches from hooks. Only explicit tools may
  launch through the host-authorized external executor. `context_shunt_delegate` answers one bounded
  question from a preserved artifact, and `consult_advisor` consults configured Advisors when
  `advisorLaunch` is `tool`. Role mode leaves Advisor launches to the main agent. The local log
  records content-free policy, consultation, per-task counter, and launch metadata only, with no
  network telemetry.
- preserve ContextShunt defaults and controls. `off` performs no classification, metrics, I/O, or
  interception. Declared preflight limits count lines, and post-result limits use returned UTF-8 bytes
  and lines. Rejected requests do not consume the admitted-request window.
- preserve originals when an artifact, permission, or recognized contract is unavailable. Keep
  one-time exceptions user-authorized, short-lived, and bound to the exact tool call and input, with
  byte limits checked against the returned result.
- avoid project configuration, credential handling, telemetry, and network requests.

Changes to persisted schemas, public commands, ContextShunt contracts, or the delegated-work policy
need documentation and migration notes.

## Documentation

Each fact has one home, and every other page links to it instead of restating it:

| Document                    | Owns                                                                                       |
| --------------------------- | ------------------------------------------------------------------------------------------ |
| `README.md`                 | Product, install, intensities, roles, commands, state files, development                   |
| `SECURITY.md`               | Security posture, what reaches another model, local records, reporting, supported versions |
| `wiki/getting-started/`     | Install and first activation                                                               |
| `wiki/configuration/`       | Schema, inheritance, saving, roles, thinking, Advisor settings and threads, downgrade      |
| `wiki/commands-and-status/` | Commands, panel keys, status tokens, diagnosis                                             |
| `wiki/limits-and-privacy/`  | Boundary, launch check, logs, retention, ContextShunt caps and reader contract             |
| `CHANGELOG.md`              | What changed in each release                                                               |

Keep version history in the changelog. A "since version X" note stays in the other documents only when
it changes a user decision, such as a Pi floor, an admitted dependency version, a schema
compatibility, or a downgrade step.

## Code of conduct

Participation follows [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).
