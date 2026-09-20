---
title: Configuration
description: Set valid global defaults, session-branch overrides, and optional thinking policies per role.
---

## Quick valid configuration

The safest route is to open `/delegate`, choose exact models from Pi's available catalog, and apply the draft. In an active policy, every ordinary role needs an explicit decision: an exact, authenticated reference or `disabled`; at least one ordinary role must be enabled. Visual Design, and Advisor, are optional and do not satisfy that minimum.

Global defaults live at `~/.pi/agent/delegation-policy.json` and use schema version 7:

```json
{
  "schemaVersion": 7,
  "intensity": "normal",
  "preference": "standard",
  "small": { "provider": "example-provider", "model": "example-small" },
  "medium": { "provider": "example-provider", "model": "example-medium" },
  "large": null,
  "uiDesign": { "provider": "example-provider", "model": "example-ui-design" },
  "advisor": { "provider": "example-provider", "model": "example-advisor" },
  "thinking": {
    "small": { "level": "high" },
    "medium": { "min": "low", "max": "high" }
  },
  "contextShunt": { "mode": "off" }
}
```

The references are fictional. An absent setting inherits in a session or is **not configured** without a global value; an exact `{ "provider", "model" }` reference enables an ordinary role; `null` explicitly disables it. Global `uiDesign` and `advisor`, when present, remain exact references; only a session override may use `null` to disable that optional role.

`thinking` is optional and holds at most one policy per role. Omitting it, or omitting a role inside it, changes nothing: the main agent chooses that role's level for each launch, as before. See [Thinking](#thinking) for the three states and their validation.

## Global defaults and session inheritance

Global defaults may contain intensity, preference, tri-state ordinary roles, the compatible `uiDesign` and `advisor` keys, and one thinking policy per role. If global intensity is absent, the built-in default is `off`. A branch inherits a global value until it records an override. **Use global default** removes that branch override. A session `null` wins over a global model; a session model wins over a global `null`. A session thinking `null` keeps no policy for that role in the branch even when global defaults set one. Sources are `default`, `global`, or `session`.

**Save effective configuration as defaults** copies the effective configuration to the global file, including ordinary `null` values, the effective thinking policies, and the configured ContextShunt mode even when delegation currently suspends it, but does not apply the current session draft or change its branch. A role with no effective policy is written without one, never as `null`. `/delegate reset` writes `off` for the branch and returns other fields to global inheritance. In the panel, **Reset draft to off** is only a draft until Apply.

Schema 2 through 6 defaults and session entries remain supported as input and are migrated in memory to schema 7 without a write: a schema 2 through 5 document has no thinking policy, and any document below schema 7 carries no `advisor`. Schema 1 remains inactive and is not migrated automatically. The extension restores only the latest delegation entry: a future or malformed latest entry forces the branch off and reports a sanitized diagnostic rather than reactivating older state.

Each session Apply, quick intensity command, ContextShunt mode command, and reset first append a schema 2 `off` guard and then the schema 7 state. If the second append fails, the guard remains and the branch is off. A global save or manual schema-3 edit cannot create that guard.

Published `0.9.0` includes `orchestrator`. Before downgrading:

1. Set the global `intensity` to `off`, `normal`, or `aggressive`, preferably `off`.
2. Run `/delegate off` in every active branch before installing the older package.
3. For `0.6.0`, keep schema 3 and the existing role settings. For `<=0.5.0`, also change global `schemaVersion` to 2 and replace ordinary `null` values with exact model references.

A package that cannot read schema 7 treats the document as invalid: global defaults fall back to empty defaults with `off` and no injection, and a branch falls back to `off` with a sanitized notice. The guarded branch write already presents schema 2 `off` to older versions.

Schema 2 never accepts `orchestrator`. Saving defaults alone does not update branch overrides; changing a branch alone does not repair unsupported global defaults.

## ContextShunt

`contextShunt.mode` is independent from delegation intensity: `off` is the default and does no classification, metrics, archive I/O, or interception; `observe` records decisions without changing calls or results; `enforce` covers only recognized native reads, conservative bounded PowerShell reads, and known successful textual results. Delegation `off` suspends the effective mode without deleting the saved preference.

Optional `readerRole`, limits, and patterns inherit per field between global defaults and the session branch. Preflight limits use declared lines; post-result limits use actual UTF-8 bytes and returned lines. `exceptionPatterns` exempt matching paths only from this optimization; they never grant filesystem access. `delegationHintPatterns` label an already blocked declared excess as a delegation hint; they do not expand coverage or force a bounded read to block. `readerRole` is a requested ordinary role rather than an added model configuration: no separate reader model is stored, and the reader uses that role's exact resolved model when it is invoked. **Context advanced** in the panel edits reader enablement, the reader role, the answer cap, each limit, and comma-separated patterns. Each value can return to global inheritance by clearing it, and **Reset ContextShunt draft** clears all branch ContextShunt values. The hint block reports whether the reader is on and, when it is, whether the selected ordinary role is enabled, still **not configured**, or has a model the local validation rejected. Enforcement provides guided redirection rather than an automatic bridge.

Three further keys control the opt-in inline reader, which stays off by default:

- `readerEnabled` (boolean, built-in `false`) — allow `context_shunt_delegate` to answer from a preserved artifact. A false value changes nothing else.
- `readerRole` (`small`, `medium`, or `large`, default `small`) — the existing ordinary role whose exact model answers the question. The role must be enabled and its model available.
- `answerMaxBytes` (integer, 1024 to 16384, default 8192) — the cap on the serialized result the reader returns to the main agent, including its citations and envelope.

All three inherit per field and are editable under **Reader enabled**, **Reader role**, and **Reader answer max bytes**. The reader also needs an effective mode of `enforce`, an active delegation intensity, and a valid configuration. It requires a compatible external executor: protocol version `0.69.0` is the verified one, and another build fails closed with `reader-unavailable`. A valid reader configuration looks like this:

```json
{
  "schemaVersion": 7,
  "contextShunt": {
    "mode": "enforce",
    "readerEnabled": true,
    "readerRole": "medium",
    "answerMaxBytes": 8192
  }
}
```

Read [limits and privacy](/pi-delegation-policy/limits-and-privacy/#contextshunt-reader) for the request, the answer contract, and retention.

Schema 4 still accepts a positive `limits.readerOutputBytes` from older saved files, but ignores it and never writes it again. Schema 4 writes a guarded schema 2 `off` entry before session state. Before installing a package that cannot read schema 4, set the global and branch ContextShunt mode to `off`; no schema rewrite happens automatically.

## Intensity

- `off` injects nothing into the next agent run and reports `D:OFF`. An already running agent keeps its starting prompt.
- `normal` delegates substantial, separable work only when expected benefit clearly outweighs briefing, supervision, review, and integration. Borderline work stays with the main agent.
- `aggressive` delegates suitable substantial, separable, independently checkable work by default when its objective and acceptance criteria are clear. Tightly coupled work or clearly prohibitive overhead stays with the main agent.
- `orchestrator` delegates all transferable execution before performing it whenever an enabled capable role and authorized launcher are available, regardless of size. This includes small lookups, code reading, detailed planning, implementation, testing, writing, detailed review, and integration mechanics. Bootstrap is limited to mandatory instructions, tool discovery, and narrow assignment scope; it must not pre-solve or broadly inspect the repository. Batch small tasks without recursive fanout. After assigning, do not take the task over or run an equivalent worker while it is pending; coordinate only disjoint work, wait through the host, and consume the result before dependent work or finalizing. The main agent retains strategy, objectives, critical user decisions, coordination, safety, evidence evaluation, final acceptance, and concise synthesis; responsibility does not permit personal review or integration execution. Reinspect only a concrete gap, risk, or contradiction, then delegate transferable fixes or rechecks. Direct execution is allowed only for genuinely non-transferable work, no enabled capable role, a confirmed unavailable authorized launcher, or an explicit user or higher-priority requirement. State that exception briefly before the minimum direct work, do not repeat it while unchanged, and resume delegation when it ends. A final-review or integration label, triviality, convenience, economics, transfer cost, size, or familiarity is not a bypass. Published `0.9.0` uses this stricter guidance; published `0.7.0` retains its original wording.

In `normal` and `aggressive`, the main agent retains global strategy, coordination, integration, final review, and work whose essential context is too costly or risky to transfer. In `orchestrator`, it retains final responsibility and acceptance without a direct-execution exception for transferable detail.

## Preference and role selection

The policy considers demand, difficulty, quantity, risk, acceptance criteria, evidence, and review cost. It first removes disabled roles, then chooses the least costly enabled role that can satisfy the work. A more capable enabled role may cover work normally suited to a disabled role only when it can meet the same acceptance and evidence. If no enabled role is sufficient, the main agent keeps the work.

- **Small** handles bounded, planned, and verifiable execution. Difficult but well-defined work can remain Small with higher thinking.
- **Medium** handles planning, ambiguity reduction, broad synthesis, several modules, comparison, context coordination, or difficult decisions. Small does not need to fail first.
- **Large** is exceptional when Small and Medium are enabled alternatives and unblocks genuinely stuck work. In a partial configuration, it may cover other delegable work only when it is the least costly enabled role that can satisfy the same acceptance and evidence.

Large quantities of repetitive independent work favor multiple Small delegations. Volume alone does not justify Medium or Large, and agent type does not determine the role.

`efficient` breaks a credible Small/Medium tie toward Small. `intensive` breaks the same tie toward Medium. `standard` adds no bias. If Small or Medium is disabled, all three preferences are inert: they do not redirect work to Large or another role.

## Thinking

The main agent chooses thinking for every delegated task from demand, difficulty, quantity, risk, error and review cost, and the selected model's capabilities. That per-launch choice is the default, and the extension neither stores it nor reports it. What you may configure is a policy per role. Configuring one is optional; leaving a role unset keeps the per-launch behavior exactly as before.

Each role has three states:

- **Unset** (key absent) — the main agent chooses the level for each launch.
- **Fixed** (`{ "level": "<name>" }`) — every launch of that role uses exactly that level, and the main agent must not change it.
- **Range** (`{ "min": "<name>", "max": "<name>" }`) — the main agent chooses a level inside the inclusive bounds.

The level names are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`, in lower case. A range whose `min` and `max` are the same level is normalized to a fixed level. A configured policy is binding: the injected block states `fixed <level> (must not change)` or `range <min>..<max> inclusive (choose within it)` for that role, and the level cannot come from an ambient launcher default or from another role.

The extension validates each configured level locally against the role's resolved model when an active policy is loaded. A well-formed level the model does not support produces `D:ERR`, names the role, the level, and the model, and injects no policy. It never substitutes or clamps a level. A policy on a disabled or **not configured** role, or on Visual Design while it is disabled, is stored and inert until that role is enabled again; it adds no error.

A `thinking` entry outside those three states is a malformed document rather than a policy error: an unrecognized level name (including an empty string or a number), an empty or malformed policy object such as `{}` for a role, a `min` above its `max`, mixed or unknown keys inside a policy, a non-object, an unknown role key, or `null` in global defaults. The `thinking` object itself may be empty; that simply means no role has a policy. Malformed documents follow the strict contract described above: global defaults fall back to empty defaults with no injection, and a session branch falls back to `off` with a sanitized notice. That case does not produce `D:ERR`.

With `pi-subagents`, the selected base and level are sent as `model: "provider/model:LEVEL"`; a fixed policy shows its literal level instead of the `LEVEL` placeholder. Another launcher may expose a separate per-run field. The stored policy appears in the panel and in `/delegate status`.

## Visual Design

Visual Design is an optional specialist, not a fourth execution tier. Use it only when the primary acceptance criterion is visual or user experience, behavior and data contracts remain unchanged, the patch is bounded, and it needs no logic, data flow, APIs, routes, architecture, tooling, or cross-system coordination. When it is configured, evaluate those four conditions before ordinary-role selection for every task or phase. If they hold and the visual portion is being delegated by the main agent's decision or required by the active intensity, Visual Design takes priority over Small, Medium, and Large. Reevaluate eligibility when the task or phase changes. This priority does not require delegation in `normal` or `aggressive`. It may design, create, implement, and review scoped presentation code and assets, including visual accessibility, and run its relevant checks. In published `0.7.0` and `normal` or `aggressive`, the main agent retains integration and final acceptance. In published `0.9.0` `orchestrator`, it retains integration responsibility, coordination, and final acceptance while a capable ordinary role performs transferable integration mechanics and detailed review unless a named direct-work exception applies. Visual Design does not replace ordinary roles or own interaction behavior, state, validation, semantic accessibility, persistence, test infrastructure, or integration mechanics. When disabled, an enabled ordinary role handles eligible visual work by task fit.

## Advisor

Advisor is an optional consultation model, not an execution role. It is off by default, does not count toward the ordinary-role minimum, and configures exactly like Visual Design: an exact `{ "provider", "model" }` reference in global defaults, where only a session override may use `null` to turn it off. `thinking.advisor` accepts the same three states as any other role.

When the advisor is configured and valid, the main agent may consult it with the explicit `advisor_ask` tool, which takes a question, optional extra context, and the thinking level for that call. The advisor answers briefly from a bounded window of the conversation, and it executes no work: it cannot read files, run commands, or delegate. Configuring nothing here changes nothing about the policy: the tool answers `advisor-unavailable` and the agent continues, and the injected block adds no advisor line.

A configured advisor whose model is missing, unavailable, out of scope, or unauthenticated produces `D:ERR` and injects no policy, exactly like Visual Design. That validation is shared: the same error also leaves the ContextShunt reader unauthorized until the configuration is corrected. This coupling is deliberate and documented rather than incidental. Read [limits and privacy](/pi-delegation-policy/limits-and-privacy/#advisor-limits) for the tool contract, the bounded window, and retention.

For fail-closed behavior, privacy, and reporting guidance, read [limits and privacy](/pi-delegation-policy/limits-and-privacy/).
