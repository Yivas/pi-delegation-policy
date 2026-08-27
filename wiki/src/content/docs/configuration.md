---
title: Configuration
description: Set valid global defaults and session-branch overrides without persisting thinking.
---

## Quick valid configuration

The safest route is to open `/delegate`, choose exact models from Pi's available catalog, and apply
the draft. An active `normal` or `aggressive` configuration needs exact, authenticated Small,
Medium, and Large references in the current scope. Visual Design is optional.

Global defaults can also be written at `~/.pi/agent/delegation-policy.json` with schema version 2:

```json
{
  "schemaVersion": 2,
  "intensity": "normal",
  "preference": "standard",
  "small": { "provider": "example-provider", "model": "example-small" },
  "medium": { "provider": "example-provider", "model": "example-medium" },
  "large": { "provider": "example-provider", "model": "example-large" },
  "uiDesign": { "provider": "example-provider", "model": "example-ui-design" }
}
```

The provider and model values above are fictional. Replace them with the exact references exposed by
Pi and authenticated for each provider. Configuration stores those values separately as the role's
base identity. At launch, the main agent chooses thinking for the current task and transmits both
values through the launcher's per-run mechanism. `pi-subagents` encodes the level as a suffix:

```text
model: "provider/model:LEVEL"
```

`LEVEL` stands for the level selected for that run; it is not stored in the role reference. A launcher
with a separate per-run thinking field can keep `model: "provider/model"` and send the level there.
This requirement applies to every delegated launch, including Visual Design when that role is configured.
The policy does not substitute another model or inherit an ambient model or thinking default. See
[commands and status](/pi-delegation-policy/commands-and-status/) for panel editing and validation
feedback.

## Global defaults

Global defaults may contain intensity, model preference, exact Small/Medium/Large references, and an
optional Visual Design reference stored under the compatible `uiDesign` key. If global intensity is absent, the built-in default is `off`. A global
value is inherited by a session branch until that branch records an override.

Selecting **Save effective configuration as defaults** in the panel copies the complete effective
configuration, including intensity, to the global file. It does not apply the current session draft.

## Session inheritance

`/delegate` stores applied changes in the current session branch. They survive reload, resume, and
tree navigation. Each setting can return to **Use global default** to remove its branch override. A
fork restores the latest valid delegation entry in its active history.

`/delegate reset` is an explicit safety action: it writes `off` for the branch and returns every
other field to its global default. In the editor, **Reset draft to off** makes that same shape only a
local draft until **Apply changes**.

## Intensity

- `off` injects nothing into the next agent run and reports `D:OFF`. Pi rebuilds the system prompt for each run, so a policy from an earlier run is absent; an agent already running keeps its starting prompt.
- `normal` delegates substantial, separable work only when the expected benefit clearly outweighs briefing, supervision, review, and integration. Borderline work stays with the main agent.
- `aggressive` delegates substantial, separable, independently checkable work by default when its objective and acceptance criteria are clear. A plausible benefit can be enough, but tightly coupled work or clearly prohibitive overhead stays with the main agent.

In every mode, the main agent retains global strategy, coordination, integration, final review, and
work whose essential context is too costly or risky to transfer.

## Preference and role selection

The policy evaluates task fit before preference. It considers the task's:

- demand: execute, search, plan, decide, coordinate, or unblock;
- difficulty: clarity, ambiguity, dependencies, and competing hypotheses;
- quantity: files, modules, systems, sources, and context volume;
- risk: the consequences of a wrong result;
- error and review cost: what can go wrong, how costly it is to detect, and what evidence review requires.

No single factor decides the role. Select the smallest role that can satisfy the acceptance criteria
and evidence requirements.

- **Small** handles bounded, planned, and verifiable execution. Difficult but well-defined work can remain Small with higher thinking.
- **Medium** handles task fits that materially require planning, ambiguity reduction, broad synthesis, tracing several modules, comparison, context coordination, or difficult decisions. Small does not need to fail first.
- **Large** is exceptional and unblocks genuinely stuck work, such as persistent failures, severe framework conflicts, contradictory hypotheses, or reliable prior evidence that ordinary roles have not produced a trustworthy answer.

Large quantities of repetitive, independent work favor multiple Small delegations. Volume alone does
not justify Medium or Large, and agent type does not determine the model role.

Preference is a tie-break between comparably credible Small and Medium fits:

- `efficient` breaks that tie toward Small. It does not override a materially better Medium fit.
- `standard` adds no Small or Medium bias; follow task fit.
- `intensive` breaks that tie toward Medium. It does not override a clearly better Small fit.

All three ordinary roles remain available in every preference. Active role references must be available,
in scope, and authenticated.

## Thinking

The main agent chooses thinking for each delegated task from task demand, difficulty, quantity, risk,
error and review cost, and the selected model's capabilities. It makes that choice for every launch
instead of inheriting a global subagent default. The role alone does not fix the level, and different
tasks using the same role may receive different supported levels.

Thinking is dynamic and advisory. This extension does not configure, validate, or persist it; the
launcher remains responsible for accepting the per-run value.

## Visual Design

Visual Design is an optional specialist; it is not a fourth execution tier. The user-facing name does
not change the schema 2 key: global and session configuration still use `uiDesign`.

Use Visual Design only when all four conditions hold:

1. The primary acceptance criterion is a visual or user-experience result.
2. Product behavior and data contracts are already defined and remain unchanged.
3. The patch is bounded to an identifiable surface, component, or set of assets.
4. It needs no business logic, data flow, APIs, routes, application architecture, tooling, or cross-system coordination.

When eligible, it may design, create, implement, and review scoped presentation code and assets:
layout, styles, responsive presentation, typography, images, icons, logos, SVGs, diagrams, and
documentation visuals. It may address contrast, focus visibility, and other visual accessibility. It
runs and reports the relevant existing checks for its own patch.

Route interaction behavior, state, validation, semantic HTML changes, keyboard mechanics, ARIA
behavior, authentication, permissions, persistence, test infrastructure, and behavior-test ownership
to Small, Medium, or Large by task fit. If any condition fails, split the isolated visual portion or
use an ordinary role for the complete task. The main agent retains cross-domain integration and final
acceptance.

When Visual Design is disabled, ordinary roles handle visual work according to their normal task fit.

## Legacy defaults

Schema version 1 is inactive and is not migrated automatically. Open `/delegate`, configure schema
version 2, and save the effective configuration as defaults before using an active intensity.

For the complete product boundary, fail-closed behavior, privacy, and reporting guidance, read
[limits and privacy](/pi-delegation-policy/limits-and-privacy/).
