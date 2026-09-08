---
title: Configuration
description: Set valid global defaults and session-branch overrides without persisting thinking.
---

## Quick valid configuration

The safest route is to open `/delegate`, choose exact models from Pi's available catalog, and apply the draft. In an active policy, every ordinary role needs an explicit decision: an exact, authenticated reference or `disabled`; at least one ordinary role must be enabled. Visual Design is optional and does not satisfy that minimum.

Global defaults live at `~/.pi/agent/delegation-policy.json` and use schema version 4:

```json
{
  "schemaVersion": 4,
  "intensity": "normal",
  "preference": "standard",
  "small": { "provider": "example-provider", "model": "example-small" },
  "medium": { "provider": "example-provider", "model": "example-medium" },
  "large": null,
  "uiDesign": { "provider": "example-provider", "model": "example-ui-design" },
  "contextShunt": { "mode": "off" }
}
```

The references are fictional. An absent setting inherits in a session or is **not configured** without a global value; an exact `{ "provider", "model" }` reference enables an ordinary role; `null` explicitly disables it. Global `uiDesign`, when present, remains an exact reference; only a session override may use `null` to disable Visual Design.

## Global defaults and session inheritance

Global defaults may contain intensity, preference, tri-state ordinary roles, and the compatible `uiDesign` key. If global intensity is absent, the built-in default is `off`. A branch inherits a global value until it records an override. **Use global default** removes that branch override. A session `null` wins over a global model; a session model wins over a global `null`. Sources are `default`, `global`, or `session`.

**Save effective configuration as defaults** copies the effective configuration to the global file, including ordinary `null` values and the configured ContextShunt mode even when delegation currently suspends it, but does not apply the current session draft or change its branch. `/delegate reset` writes `off` for the branch and returns other fields to global inheritance. In the panel, **Reset draft to off** is only a draft until Apply.

Schema 2 and 3 defaults and session entries remain supported as input and are migrated in memory to schema 4 without a write. Schema 1 remains inactive and is not migrated automatically. The extension restores only the latest delegation entry: a future or malformed latest entry forces the branch off and reports a sanitized diagnostic rather than reactivating older state.

Each session Apply, quick intensity command, ContextShunt mode command, and reset first append a schema 2 `off` guard and then the schema 4 state. If the second append fails, the guard remains and the branch is off. A global save or manual schema-3 edit cannot create that guard.

Published `0.9.0` includes `orchestrator`. Before downgrading:

1. Set the global `intensity` to `off`, `normal`, or `aggressive`, preferably `off`.
2. Run `/delegate off` in every active branch before installing the older package.
3. For `0.6.0`, keep schema 3 and the existing role settings. For `<=0.5.0`, also change global `schemaVersion` to 2 and replace ordinary `null` values with exact model references.

Schema 2 never accepts `orchestrator`. Saving defaults alone does not update branch overrides; changing a branch alone does not repair unsupported global defaults.

## ContextShunt

`contextShunt.mode` is independent from delegation intensity: `off` is the default and does no classification, metrics, archive I/O, or interception; `observe` records decisions without changing calls or results; `enforce` covers only recognized native reads, conservative bounded PowerShell reads, and known successful textual results. Delegation `off` suspends the effective mode without deleting the saved preference.

Optional `readerRole`, limits, and patterns inherit per field between global defaults and the session branch. Preflight limits use declared lines; post-result limits use actual UTF-8 bytes and returned lines. `exceptionPatterns` exempt matching paths only from this optimization; they never grant filesystem access. `delegationHintPatterns` label an already blocked declared excess as a delegation hint; they do not expand coverage or force a bounded read to block. `readerRole` is a requested ordinary role, not an added model configuration; the effective worker model is reported as unknown because this package does not launch or inspect a runner. **Context advanced** in the panel edits the reader role, each limit, and comma-separated patterns. Each value can return to global inheritance by clearing it, and **Reset ContextShunt draft** clears all branch ContextShunt values. The panel calls out a disabled or unconfigured requested role and that the bridge is unavailable. Enforcement provides guided redirection rather than an automatic bridge.

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

## Thinking and Visual Design

The main agent chooses thinking for every delegated task from demand, difficulty, quantity, risk, error and review cost, and the selected model's capabilities. Thinking is dynamic and advisory; this extension does not configure, validate, or persist it. With `pi-subagents`, the selected base and level are sent as `model: "provider/model:LEVEL"`; another launcher may expose a separate per-run field.

Visual Design is an optional specialist, not a fourth execution tier. Use it only when the primary acceptance criterion is visual or user experience, behavior and data contracts remain unchanged, the patch is bounded, and it needs no logic, data flow, APIs, routes, architecture, tooling, or cross-system coordination. When it is configured, evaluate those four conditions before ordinary-role selection for every task or phase. If they hold and the visual portion is being delegated by the main agent's decision or required by the active intensity, Visual Design takes priority over Small, Medium, and Large. Reevaluate eligibility when the task or phase changes. This priority does not require delegation in `normal` or `aggressive`. It may design, create, implement, and review scoped presentation code and assets, including visual accessibility, and run its relevant checks. In published `0.7.0` and `normal` or `aggressive`, the main agent retains integration and final acceptance. In published `0.9.0` `orchestrator`, it retains integration responsibility, coordination, and final acceptance while a capable ordinary role performs transferable integration mechanics and detailed review unless a named direct-work exception applies. Visual Design does not replace ordinary roles or own interaction behavior, state, validation, semantic accessibility, persistence, test infrastructure, or integration mechanics. When disabled, an enabled ordinary role handles eligible visual work by task fit.

For fail-closed behavior, privacy, and reporting guidance, read [limits and privacy](/pi-delegation-policy/limits-and-privacy/).
