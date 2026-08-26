---
title: Configuration
description: Set global defaults and session-branch overrides without persisting thinking.
---

## Global defaults

Global defaults live at `~/.pi/agent/delegation-policy.json` and use schema version 2. They store
optional intensity, model references, model preference, and an optional UI Design model. They never
store thinking.

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

The values in this example are fictional. Each active ordinary role must resolve to the exact
provider and model exposed by Pi in the current scope and authenticated for its provider.

## Session branches

`/delegate` stores changes in the current session branch. Those changes survive reload, resume, and
tree navigation. A branch inherits global intensity and other defaults until it records matching
overrides; missing global intensity falls back to `off`. A fork restores the latest valid delegation
entry in its active history.

Each setting in the editor can return to **Use global default**. Model fields provide local fuzzy
search by provider, model ID, and display name; searching does not hide the inheritance action.
Selecting **Save effective configuration as defaults** copies the complete effective configuration,
including intensity, to the global file without applying the session draft.

`/delegate reset` remains an explicit safety action: it writes `off` for the branch and returns all
other fields to their global defaults.

## Intensity and preference

- `off` injects no delegation policy into the next agent run. Pi rebuilds the system prompt for each
  run, so an earlier policy block is absent; an agent already running keeps its starting prompt.
- `normal` delegates substantial, separable work only when the expected benefit clearly outweighs
  briefing, supervision, review, and integration. Borderline work stays with the main agent.
- `aggressive` delegates substantial, separable, independently checkable work by default when its
  objective and acceptance criteria are clear. Plausible benefit can be enough, but tightly coupled
  work or clearly prohibitive overhead stays with the main agent.

The policy evaluates task demand, difficulty, and quantity together. No single factor selects a
role:

- Small is habitual for bounded, planned, and verifiable execution. Difficult but well-defined work
  can remain Small with higher thinking.
- Medium can be selected directly for meaningful planning, ambiguity reduction, broad synthesis,
  several-module tracing, comparison, context coordination, or difficult decisions. Small does not
  need to fail first.
- Large is exceptional and unblocks genuinely stuck work, including persistent failures, severe
  framework conflicts, or contradictory hypotheses. Reliable prior evidence can justify it without
  ceremonial failed attempts.
- Repetitive independent volume favors multiple Small delegations rather than a larger role.

Preference shifts credible Small/Medium choices; a clearly better task fit overrides it:

- `efficient` favors Small more strongly and uses Medium when it provides a material advantage.
- `standard` reproduces the canonical policy and chooses Small on a genuine Small/Medium tie.
- `intensive` normally favors Medium for non-trivial bounded work when both roles are credible, but
  retains Small for clearly narrow, routine, mechanical, or especially clear Small work.

All three ordinary roles remain available in every preference. Agent type does not select the model
role. The main agent chooses thinking for each task from its demand, difficulty, quantity, and model
capabilities; this extension does not configure or persist it.

## UI Design

UI Design is optional. When configured, it is limited to visual design direction, exploration, and
review. It must not implement an interface, write code, or run tests. When it is off, ordinary roles
handle design-related work.

## Legacy defaults

Schema version 1 is inactive and is not migrated automatically. Open `/delegate`, configure schema
version 2, and save effective defaults before using an active intensity.

## Next step

Read [commands and status](/pi-delegation-policy/commands-and-status/) to operate the extension
and diagnose its footer labels.
