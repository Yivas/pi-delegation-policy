---
title: Configuration
description: Set valid global defaults and session-branch overrides without persisting thinking.
---

## Quick valid configuration

The safest route is to open `/delegate`, choose exact models from Pi's available catalog, and apply the draft. In an active policy, every ordinary role needs an explicit decision: an exact, authenticated reference or `disabled`; at least one ordinary role must be enabled. Visual Design is optional and does not satisfy that minimum.

Global defaults live at `~/.pi/agent/delegation-policy.json` and use schema version 3:

```json
{
  "schemaVersion": 3,
  "intensity": "normal",
  "preference": "standard",
  "small": { "provider": "example-provider", "model": "example-small" },
  "medium": { "provider": "example-provider", "model": "example-medium" },
  "large": null,
  "uiDesign": { "provider": "example-provider", "model": "example-ui-design" }
}
```

The references are fictional. An absent setting inherits in a session or is **not configured** without a global value; an exact `{ "provider", "model" }` reference enables an ordinary role; `null` explicitly disables it. Global `uiDesign`, when present, remains an exact reference; only a session override may use `null` to disable Visual Design.

## Global defaults and session inheritance

Global defaults may contain intensity, preference, tri-state ordinary roles, and the compatible `uiDesign` key. If global intensity is absent, the built-in default is `off`. A branch inherits a global value until it records an override. **Use global default** removes that branch override. A session `null` wins over a global model; a session model wins over a global `null`. Sources are `default`, `global`, or `session`.

**Save effective configuration as defaults** copies the effective configuration to the global file, including ordinary `null` values, but does not apply the current session draft or change its branch. `/delegate reset` writes `off` for the branch and returns other fields to global inheritance. In the panel, **Reset draft to off** is only a draft until Apply.

Schema 2 defaults and session entries remain supported as input and are migrated in memory to schema 3 without a write. Schema 1 remains inactive and is not migrated automatically. The extension restores only the latest delegation entry: a future or malformed latest entry forces the branch off and reports a sanitized diagnostic rather than reactivating older state.

Each session Apply, quick intensity command, and reset first append a schema 2 `off` guard and then the schema 3 state. If the second append fails, the guard remains and the branch is off. A global save or manual schema-3 edit cannot create that guard. Before downgrading after either action, run `/delegate off` in every active branch and manually replace every global ordinary `null` with an exact schema 2 reference before installing `0.5.0` or earlier.

## Intensity

- `off` injects nothing into the next agent run and reports `D:OFF`. An already running agent keeps its starting prompt.
- `normal` delegates substantial, separable work only when expected benefit clearly outweighs briefing, supervision, review, and integration. Borderline work stays with the main agent.
- `aggressive` delegates suitable substantial, separable, independently checkable work by default when its objective and acceptance criteria are clear. Tightly coupled work or clearly prohibitive overhead stays with the main agent.

In every mode, the main agent retains global strategy, coordination, integration, final review, and work whose essential context is too costly or risky to transfer.

## Preference and role selection

The policy considers demand, difficulty, quantity, risk, acceptance criteria, evidence, and review cost. It first removes disabled roles, then chooses the least costly enabled role that can satisfy the work. A more capable enabled role may cover work normally suited to a disabled role only when it can meet the same acceptance and evidence. If no enabled role is sufficient, the main agent keeps the work.

- **Small** handles bounded, planned, and verifiable execution. Difficult but well-defined work can remain Small with higher thinking.
- **Medium** handles planning, ambiguity reduction, broad synthesis, several modules, comparison, context coordination, or difficult decisions. Small does not need to fail first.
- **Large** is exceptional when Small and Medium are enabled alternatives and unblocks genuinely stuck work. In a partial configuration, it may cover other delegable work only when it is the least costly enabled role that can satisfy the same acceptance and evidence.

Large quantities of repetitive independent work favor multiple Small delegations. Volume alone does not justify Medium or Large, and agent type does not determine the role.

`efficient` breaks a credible Small/Medium tie toward Small. `intensive` breaks the same tie toward Medium. `standard` adds no bias. If Small or Medium is disabled, all three preferences are inert: they do not redirect work to Large or another role.

## Thinking and Visual Design

The main agent chooses thinking for every delegated task from demand, difficulty, quantity, risk, error and review cost, and the selected model's capabilities. Thinking is dynamic and advisory; this extension does not configure, validate, or persist it. With `pi-subagents`, the selected base and level are sent as `model: "provider/model:LEVEL"`; another launcher may expose a separate per-run field.

Visual Design is an optional specialist, not a fourth execution tier. Use it only when the primary acceptance criterion is visual or user experience, behavior and data contracts remain unchanged, the patch is bounded, and it needs no logic, data flow, APIs, routes, architecture, tooling, or cross-system coordination. It may design, create, implement, and review scoped presentation code and assets, including visual accessibility, and run its relevant checks. It does not replace ordinary roles or own interaction behavior, state, validation, semantic accessibility, persistence, test infrastructure, integration, or final acceptance. When disabled, an enabled ordinary role handles eligible visual work by task fit.

For fail-closed behavior, privacy, and reporting guidance, read [limits and privacy](/pi-delegation-policy/limits-and-privacy/).
