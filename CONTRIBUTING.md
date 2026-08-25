# Contributing

Thanks for helping improve `pi-delegation-policy`.

## Before opening an issue

- Search existing issues.
- Include the package version or commit, Pi version, operating system, and a minimal reproduction.
- Remove credentials, session files, prompts, personal paths, model account identifiers, and unredacted logs.
- Report security vulnerabilities through [`SECURITY.md`](SECURITY.md), not a public issue.

## Pull requests

Pull requests should:

- explain the user-visible behavior and the reason for the change;
- include focused tests for behavior changes;
- keep the public package English-only;
- use fictional examples and provider-agnostic documentation;
- preserve exact role references and the absence of model fallbacks;
- preserve the boundary: this package guides the main agent and does not create, launch, route, supervise, or block subagents;
- avoid project configuration, credential handling, telemetry, and network requests;
- run `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm test`, and `npm run build`.

Changes to schema 2, public commands, or the delegated-work policy need documentation and migration notes.

## Code of conduct

Participation follows [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).
