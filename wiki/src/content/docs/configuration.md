---
title: Configuration
description: Set valid global defaults and session-branch overrides without persisting thinking.
---

## Quick valid configuration

The safest route is to open `/delegate`, choose exact models from Pi's available catalog, and apply
the draft. An active `normal` or `aggressive` configuration needs exact, authenticated Small,
Medium, and Large references in the current scope. UI Design is optional.

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
Pi and authenticated for each provider. The file never stores thinking. See [commands and
status](/pi-delegation-policy/commands-and-status/) for panel editing and validation feedback.

## Global defaults

Global defaults may contain intensity, model preference, exact Small/Medium/Large references, and an
optional UI Design reference. If global intensity is absent, the built-in default is `off`. A global
value is inherited by a session branch until that branch records an override.

Selecting **Save effective configuration as defaults** in the panel copies the complete effective
configuration, including intensity, to the global file. It does not apply the current session draft.

## Session inheritance

`/delegate` stores applied changes in the current session branch. They survive reload, resume, and
tree navigation. Each setting can return to **Use global default** to remove its branch override. A
fork restores the latest valid delegation entry in its active history.

`/delegate reset` is an explicit safety action: it writes `off` for the branch and returns every
other field to its global default. In the editor, **Reset draft to off** makes that same shape only
a local draft until **Apply changes**.

## Intensity

- `off` injects nothing into the next agent run and reports `D:OFF`. Pi rebuilds the system prompt for each run, so a policy from an earlier run is absent; an agent already running keeps its starting prompt.
- `normal` delegates substantial, separable work only when the expected benefit clearly outweighs briefing, supervision, review, and integration. Borderline work stays with the main agent.
- `aggressive` delegates substantial, separable, independently checkable work by default when its objective and acceptance criteria are clear. A plausible benefit can be enough, but tightly coupled work or clearly prohibitive overhead stays with the main agent.

In every mode, the main agent retains global strategy, coordination, integration, final review, and
work whose essential context is too costly or risky to transfer.

## Preference and role selection

The policy evaluates task demand, difficulty, and quantity together. No single factor decides the
role:

- **Small** is habitual for bounded, planned, and verifiable execution. Difficult but well-defined work can remain Small with higher thinking.
- **Medium** can be selected directly when the combined demands materially require planning, ambiguity reduction, broad synthesis, several-module tracing, comparison, context coordination, or difficult decisions. Small does not need to fail first.
- **Large** is exceptional and unblocks genuinely stuck work, such as persistent failures, severe framework conflicts, or contradictory hypotheses. Reliable prior evidence can justify it without ceremonial failed attempts.
- Large quantities of repetitive, independent work favor multiple Small delegations. Agent type does not determine the model role.

Preference shifts credible Small/Medium choices, but a clearly better task fit overrides it:

- `efficient` favors Small more strongly and uses Medium when it provides a material advantage.
- `standard` reproduces the canonical policy and chooses Small on a genuine Small/Medium tie.
- `intensive` normally favors Medium for non-trivial bounded work when both roles are credible, while retaining Small for clearly narrow, routine, mechanical, or especially clear Small work.

All three ordinary roles remain available in every preference. Active role references must be available,
in scope, and authenticated; the extension never substitutes another model or role.

## Thinking

The main agent chooses thinking for each delegated task from task demand, difficulty, quantity, and
model capabilities. Thinking is dynamic and is not configured or persisted by this extension.

## UI Design

UI Design is optional. When configured, it is limited to visual design direction, exploration, and
review. It must not implement an interface, write code, or run tests. When it is disabled, ordinary
roles handle design-related work.

## Legacy defaults

Schema version 1 is inactive and is not migrated automatically. Open `/delegate`, configure schema
version 2, and save the effective configuration as defaults before using an active intensity.

For the complete product boundary, fail-closed behavior, privacy, and reporting guidance, read
[limits and privacy](/pi-delegation-policy/limits-and-privacy/).
