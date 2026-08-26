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

`Alt+G` opens the same editor when the shortcut is available. There is no separate off
shortcut; run `/delegate off` or choose `off` in the editor.

## Editor controls

The interactive editor requires Pi's TUI mode; quick command arguments remain available in other
modes. The editor uses one bounded panel and keeps the current draft while you move between settings.
Every setting shows its effective value together with the built-in, global, and session values.

- Use `Up` and `Down` to move, then `Enter` or `Space` to edit.
- In a model field, results follow Pi's `/model` layout: model ID first and `[provider]` last. Type
  to search by provider, model ID, or display name. Up to ten model rows remain visible; use
  `Page Up` and `Page Down` for longer result sets.
- Select **Use global default** to remove that session override. UI Design also offers
  **Disable for this session**.
- Select **Apply changes** or press `A` to write the draft to the current branch.
- **Save effective configuration as defaults** changes the global file without applying the draft.
- **Reset draft to off** stays local until it is applied.
- `Escape` returns from a field. Closing a modified draft requires explicit confirmation.

The panel adjusts its viewport to the terminal height. It scrolls complete settings and model
results rather than extending beyond the screen.

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
