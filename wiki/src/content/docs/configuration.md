---
title: Configuration
description: Set global defaults and session-branch overrides without persisting intensity or thinking.
---

## Global defaults

Global defaults live at `~/.pi/agent/delegation-policy.json` and use schema version 2. They store
model references, model preference, and an optional UI Design model. They never store intensity or
thinking.

```json
{
  "schemaVersion": 2,
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
tree navigation. A session field overrides only the matching global field.

Selecting **Save effective configuration as defaults** copies the effective roles, preference, and
UI Design setting to global defaults. It does not copy intensity.

`/delegate reset` writes an `off` state for the branch and returns non-intensity fields to their
global defaults.

## Intensity and preference

- `off` injects no delegation policy.
- `normal` delegates substantial, bounded, independent work when it helps without losing essential
  context.
- `aggressive` favors delegation when the objective and acceptance criteria are clear.

Preference affects selection guidance, not availability:

- `efficient` favors Small.
- `standard` uses Small for routine work, Medium for planning or broad synthesis, and Large for
  exceptional blockers.
- `intensive` favors Medium.

All three ordinary roles remain available in every preference. The main agent chooses thinking for
each task; this extension does not configure or persist it.

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
