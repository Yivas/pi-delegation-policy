---
title: Limits and privacy
description: Understand the product boundary, fail-closed behavior, local data, and safe reporting.
---

## Product boundary

`pi-delegation-policy` guides the main agent by adding one policy block through Pi's public `before_agent_start` event when an active configuration is valid. It does not create, launch, route, supervise, or block subagents. It does not change Pi's main model or thinking level.

The policy evaluates task fit before preference from demand, difficulty, quantity, risk, and error and review cost. In published `0.8.0` `orchestrator`, the main agent must delegate all transferable execution before it begins whenever an enabled capable role and authorized launcher are available, regardless of size: small lookups, code reading, detailed planning, implementation, testing, writing, detailed review, and integration mechanics. Bootstrap is only mandatory instructions, tool discovery, and narrow assignment scope. It must not take over or duplicate pending work; it coordinates only disjoint work, waits through the host, and consumes results before dependent work or finalizing. The main agent retains critical decisions, coordination, safety, evidence evaluation, final acceptance, and concise synthesis, not permission to perform transferable review or integration. It reinspects only a concrete gap, risk, or contradiction and delegates transferable fixes or rechecks. Direct execution requires a briefly stated concrete exception: genuinely non-transferable work, no enabled capable role, a confirmed unavailable authorized launcher, or an explicit user or higher-priority requirement. A final-review or integration label, size, triviality, convenience, economics, transfer cost, or familiarity is not an exception. Published `0.7.0` retains its original policy. It considers only enabled ordinary roles, chooses the least costly enabled role that can satisfy task acceptance and evidence, and keeps work with the main agent when none can. `efficient` and `intensive` break credible Small/Medium ties only while both are enabled; `standard` adds no extra bias. Thinking remains dynamic and advisory: the main agent chooses it for each task instead of inheriting an ambient subagent default.

For every delegated launch, the policy names the selected exact `provider/model` base and requires the per-task thinking choice through the launcher. `pi-subagents` uses `model: "provider/model:LEVEL"`; another launcher may expose a separate field. The extension never supplies a model fallback or enforces that another system follows the guidance.

It has no presets, project configuration, external skill loading, telemetry, credential storage, or network requests. It is not a subagent runner and cannot make another system perform delegation. ContextShunt is its separate, opt-in protection layer; it uses only Pi's public tool hooks and does not replace tools, permission checks, remote backends, or an executor.

Visual Design is an optional specialist for a bounded presentation patch only when behavior and data contracts remain unchanged, the surface is identifiable, and visual quality or user experience is the primary acceptance criterion. It may edit scoped presentation code and assets and run relevant existing checks. In published `0.7.0` and `normal` or `aggressive`, the main agent retains cross-system integration and final acceptance. In published `0.8.0` `orchestrator`, it retains integration responsibility, coordination, and final acceptance while a capable ordinary role performs transferable integration mechanics and detailed review unless a named direct-work exception applies. Visual Design does not own product behavior, logic, data, APIs, routes, architecture, tooling, interaction, semantic or behavioral accessibility, test infrastructure, or integration mechanics.

## ContextShunt limits

ContextShunt starts `off`. In that mode its hooks return immediately without classification, metrics, artifact I/O, or changes. `observe` computes `would-block` decisions but returns the original call and result. `enforce` consults Pi's public `getAllTools()` provenance and blocks only built-in known declared oversized ranges: native `read` and a deliberately narrow PowerShell `Get-Content`/`gc` form with `-TotalCount` or `-First`. Same-named SDK or extension tools remain unchanged; observe may report them only as non-binding heuristics. Composite commands, redirects, pipes, unbounded shell reads, user `!` commands, and unknown or replaced tool contracts are not rewritten or preblocked.

After an authorized tool runs, enforcement considers only one-block successful text results from recognized `read`, `bash`, `powershell`, or `grep` contracts. It preserves the original before returning a compact message. Errors, valid JSON text of every root type, images, binaries, mixed blocks, and unrecognized contracts remain intact. Preservation failures, quota exhaustion, and cancellation leave the original result intact; commands are never run again.

Artifacts have opaque random IDs and live in a private process temporary directory, capped at eight artifacts and 512 KiB per session. Each artifact expires 30 minutes after creation; scheduled cleanup runs while the process is active, recovery does not renew the expiry, and shutdown cancels cleanup and removes the temporary directory. A crash or operating-system suspension can delay cleanup until the process resumes or the OS removes its temporary data, so this is not a guarantee of deletion after the process stops. Recovery accepts exactly one bounded line or byte range. It does not expose source paths or corpus in status or metrics. These bounds are not a sandbox, an access-control system, or protection against every prompt-injection or output route.

An oversized recognized call can be narrowed or granted once only through an explicit user command tied to the matching input, requested range, and a one-minute expiry. Content from a model cannot create an exception. The package has no automatic hook-to-reader bridge. It ships a profile limited to `read`, `grep`, `find`, and `ls`, but only an executor that can load the package asset by path can enforce that profile. This package does not copy it into user directories, disable extensions, or claim isolation it cannot verify.

## Panel and status limits

The panel shows a compact preview and field explanations. Model selection presents model ID first and `[provider]` last, fuzzy-searches provider, model ID, and display name, and can show transient public metadata: name, API, reasoning support, context window, and maximum output. The extension does not persist that metadata.

`/delegate status` shows exact effective references and provenance (`default`, `global`, or `session`), plus sanitized diagnostics. `D:NORM`, `D:AGG`, and `D:ORCH` mean local validation passed; they do not prove a delegated launch occurred or another system followed guidance. The published `0.8.0` package supports all four intensities.

## Fail-closed behavior

In `normal`, `aggressive`, or `orchestrator`, Small, Medium, and Large must each be an explicit model reference or `disabled`, and at least one must be enabled. An absent ordinary role is **not configured** and produces `D:ERR`. Any enabled reference that is missing, unavailable, out of scope, or unauthenticated also produces `D:ERR`. A configured Visual Design reference must be valid. `D:ERR` injects no policy, so an invalid enabled role is not rerouted.

With a valid partial configuration, a different configured enabled ordinary role may cover work only when it can satisfy the same acceptance and evidence. The extension never uses a disabled, unconfigured, or invented role or model. Visual Design does not satisfy the ordinary-role minimum.

`off` always injects nothing and reports `D:OFF`, even with incomplete defaults. If the latest stored session entry is malformed or from a newer schema, restoration forces `off` and retains only a sanitized warning. Turning the policy off affects later runs; it does not rewrite an agent already running.

## Local data and privacy

The extension stores intensity, preference, explicit disabled markers, and provider/model identifiers in local global defaults and Pi session entries. It never stores credentials, prompts, thinking settings, or panel catalog metadata, and it does not send telemetry or make network requests.

Review local configuration before sharing diagnostics. Remove credentials, prompts, personal paths, session files, and unredacted logs. Model identifiers and provider names can still reveal information about your environment.

## Reporting vulnerabilities

Use GitHub's [private vulnerability reporting](https://github.com/Yivas/pi-delegation-policy/security/policy) for an undisclosed vulnerability; do not open a public issue. Include the affected version or commit, operating system, Pi version, reproduction steps, expected behavior, observed behavior, and a minimal sanitized configuration.

For ordinary changes, read the [contribution guide](https://github.com/Yivas/pi-delegation-policy/blob/main/CONTRIBUTING.md).

## More information

- [Commands and status](/pi-delegation-policy/commands-and-status/) explains `D:ERR` diagnosis and next-run behavior.
- [Configuration](/pi-delegation-policy/configuration/) defines policy meanings and inheritance.
- [Source repository](https://github.com/Yivas/pi-delegation-policy)
- [Package on npm](https://www.npmjs.com/package/pi-delegation-policy)
