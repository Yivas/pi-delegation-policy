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
- preserve the boundary: this package does not create, launch, route, or manage subagents;
- preserve exact assignments and the absence of hidden fallbacks;
- run `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm test`, and `npm run build`.

Changes to configuration schemas or public commands need documentation and migration notes.

## Code of conduct

Participation follows [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).
