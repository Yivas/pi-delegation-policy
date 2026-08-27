---
title: Limits and privacy
description: Understand the product boundary, fail-closed behavior, local data, and safe reporting.
---

## Product boundary

`pi-delegation-policy` guides the main agent by adding one policy block through Pi's public
`before_agent_start` event when the active configuration is valid. It does not create, launch, route,
supervise, or block subagents. It does not change Pi's main model or thinking level.

The policy evaluates task fit before preference. It considers demand, difficulty, quantity, risk, and
error and review cost. `efficient` and `intensive` only break ties between comparably credible Small
and Medium fits; `standard` adds no extra bias. The main agent chooses thinking for every task from
those factors and the selected model's capabilities instead of inheriting an ambient subagent
default. Thinking remains dynamic and advisory, and this extension does not persist it.

For every delegated launch, the policy names the selected role's exact `provider/model` base and
requires the per-task thinking choice to be transmitted through the launcher. `pi-subagents` uses
`model: "provider/model:LEVEL"`; another launcher may expose a separate field. This guidance applies
to Small, Medium, Large, and configured UI Design. The extension does not supply a fallback or enforce
that another system follows the reference or thinking choice.

It has no presets, project configuration, external skill loading, tool interception, model fallback,
enforcement, telemetry, credential storage, or network requests. It is not a subagent runner and
cannot make another system perform delegation.

The optional UI Design role is limited to visual design direction, exploration, and review. It must
not implement an interface, write code, or run tests.

## Panel and status limits

The panel shows a compact effective-policy preview and short explanations for its fields and
selectors. Model selection can show transient public metadata when Pi supplies it: name, API,
reasoning support, context window, and maximum output. The extension does not persist that metadata.

`/delegate status` shows exact effective `provider/model` references and their provenance (`default`,
`global`, or `session`), along with runtime diagnostics. `D:NORM` and `D:AGG` show that the active
configuration passed local validation; they do not mean that a delegated launch occurred or that
another system followed the guidance.

## Fail-closed behavior

An active `normal` or `aggressive` configuration requires valid Small, Medium, and Large model
references. A configured UI Design reference must also be valid. Missing, unavailable,
out-of-scope, or unauthenticated references produce `D:ERR` and inject no policy. The extension does
not substitute another model, role, or thinking level.

`off` is intentionally different: it always injects nothing and reports `D:OFF`, even when defaults
are incomplete. Turning the policy off affects later runs; it does not rewrite an agent that is
already running.

A valid status only means the extension accepted the local configuration. It cannot guarantee that
another system follows the role, model, or thinking guidance once it is injected.

## Local data and privacy

The extension stores intensity, preference, and provider/model identifiers in the local global
defaults file and Pi session entries. It never stores credentials, prompts, thinking settings, or
panel catalog metadata, and it does not send telemetry or make network requests.

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
