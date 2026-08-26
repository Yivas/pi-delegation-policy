---
title: Limits and privacy
description: Understand the product boundary, fail-closed behavior, local data, and safe reporting.
---

## Product boundary

`pi-delegation-policy` guides the main agent by adding one policy block through Pi's public
`before_agent_start` event when the active configuration is valid. It does not create, launch, route,
supervise, or block subagents. It does not change Pi's main model or thinking level.

It has no presets, project configuration, external skill loading, tool interception, model fallback,
enforcement, telemetry, credential storage, or network requests. It is not a subagent runner and
cannot make another system perform delegation.

The optional UI Design role is limited to visual design direction, exploration, and review. It must
not implement an interface, write code, or run tests.

## Fail-closed behavior

An active `normal` or `aggressive` configuration requires valid Small, Medium, and Large model
references. A configured UI Design reference must also be valid. Missing, unavailable,
out-of-scope, or unauthenticated references produce `D:ERR` and inject no policy. The extension does
not substitute another model, role, or thinking level.

`off` is intentionally different: it always injects nothing and reports `D:OFF`, even when defaults
are incomplete. Turning the policy off affects later runs; it does not rewrite an agent that is
already running.

A valid status only means the extension accepted the local configuration. It cannot guarantee that
another system follows the role or thinking guidance once it is injected.

## Local data and privacy

The extension stores intensity, preference, and provider/model identifiers in the local global
defaults file and Pi session entries. It never stores credentials, prompts, or thinking settings, and
it does not send telemetry or make network requests.

Review local configuration before sharing diagnostics. Remove credentials, prompts, personal paths,
session files, and unredacted logs from reports. Model identifiers and provider names can still reveal
information about your environment.

## Reporting vulnerabilities

Use GitHub's [private vulnerability reporting](https://github.com/Yivas/pi-delegation-policy/security/policy)
for an undisclosed vulnerability; do not open a public issue. Include the affected version or commit,
operating system, Pi version, reproduction steps, expected behavior, observed behavior, and a minimal
sanitized configuration.

For ordinary changes, read the [contribution guide](https://github.com/Yivas/pi-delegation-policy/blob/main/CONTRIBUTING.md).

## More information

- [Commands and status](/pi-delegation-policy/commands-and-status/) explains `D:ERR` diagnosis and next-run behavior.
- [Configuration](/pi-delegation-policy/configuration/) defines policy meanings and inheritance.
- [Source repository](https://github.com/Yivas/pi-delegation-policy)
- [Package on npm](https://www.npmjs.com/package/pi-delegation-policy)
