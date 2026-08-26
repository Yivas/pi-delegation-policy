---
title: Commands and status
description: Use /delegate and interpret the delegation status shown in Pi.
---

## Commands

| Command                | Effect                                                   |
| ---------------------- | -------------------------------------------------------- |
| `/delegate`            | Open the keyboard-first selector.                        |
| `/delegate off`        | Disable policy injection for the current session branch. |
| `/delegate normal`     | Enable balanced delegation guidance.                     |
| `/delegate aggressive` | Enable delegation-first guidance.                        |
| `/delegate status`     | Show the effective session state.                        |
| `/delegate reset`      | Reset the current session branch to `off`.               |

`Ctrl+Alt+D` opens the selector when the shortcut is available. There is no separate off
shortcut; run `/delegate off` or choose `off` in the selector.

Changes apply to the next agent run. Pi rebuilds the system prompt for each run, so switching to
`off` leaves out a policy injected into an earlier run. It cannot rewrite an agent that is already
running.

## Footer labels

Pi keeps its own footer while the extension adds one textual status label:

| Label    | Meaning                                                                      | What to do                                                                                     |
| -------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `D:OFF`  | Delegation is disabled. Incomplete defaults do not change this label.        | Choose an active intensity only when your roles are ready.                                     |
| `D:NORM` | A valid `normal` configuration is active.                                    | Delegate only with clear expected benefit; keep borderline work with the main agent.           |
| `D:AGG`  | A valid `aggressive` configuration is active.                                | Delegate suitable substantial work by default unless coupling or overhead clearly dominates.   |
| `D:ERR`  | An active configuration has an invalid required role. No policy is injected. | Inspect `/delegate status`, correct the affected role, scope, availability, or authentication. |

## Validation behavior

Active modes require Small, Medium, and Large. UI Design is also required when that option is
configured. A missing, out-of-scope, unavailable, or unauthenticated role produces `D:ERR` and no
policy injection.

The extension never substitutes another model, role, or thinking level.

## Next step

Read [limits and privacy](/pi-delegation-policy/limits-and-privacy/) before relying on delegation
guidance in a workflow.
