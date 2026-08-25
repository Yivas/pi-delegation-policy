---
title: Limits and privacy
description: Understand the product boundary, fail-closed behavior, and safe reporting practices.
---

## Product boundary

`pi-delegation-policy` guides the main agent. It does not create, launch, route, supervise, or block
subagents. It does not change Pi's main model or thinking level.

It has no presets, project configuration, external skill loading, tool interception, model fallback,
credential storage, telemetry, or network requests.

## Fail-closed behavior

When an active configuration is incomplete or invalid, the extension reports `D:ERR` and injects no
policy. `off` is intentionally different: it always injects nothing and reports `D:OFF`, even when
defaults are incomplete.

This protects against accidental substitution, but it does not enforce that another system honors
the guidance once it is injected.

## Local data

The extension stores provider and model identifiers in global defaults and session entries. Review
configuration before sharing diagnostics. Remove credentials, prompts, personal paths, session
files, and unredacted logs from reports.

## Security and contributions

Report vulnerabilities through the repository's [security policy](https://github.com/Yivas/pi-delegation-policy/security/policy), not a public issue. For ordinary changes, read the
[contribution guide](https://github.com/Yivas/pi-delegation-policy/blob/main/CONTRIBUTING.md).

## More information

- Browse the [source repository](https://github.com/Yivas/pi-delegation-policy).
- View the package on [npm](https://www.npmjs.com/package/pi-delegation-policy).
