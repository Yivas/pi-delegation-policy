---
title: Commands and status
description: Operate the /delegate panel and interpret its status in Pi.
---

## 1. Choose how to operate

Use `/delegate` in Pi's TUI to open the keyboard-first editor. `Alt+G` opens the same editor when
the shortcut is available. The editor requires TUI mode; these command arguments remain available in
other modes:

| Command                | Effect                                                   |
| ---------------------- | -------------------------------------------------------- |
| `/delegate`            | Open the keyboard-first selector.                        |
| `/delegate off`        | Disable policy injection for the current session branch. |
| `/delegate normal`     | Enable balanced delegation guidance.                     |
| `/delegate aggressive` | Enable delegation-first guidance.                        |
| `/delegate status`     | Show the effective session state.                        |
| `/delegate reset`      | Reset the current session branch to `off`.               |

There is no separate off shortcut: run `/delegate off` or choose `off` in the editor. Quick
commands write the session branch directly. The editor's **Reset draft to off** is different: it
only changes the draft until you apply it.

## 2. Edit the panel

The panel shows each setting's effective value and its built-in, global, and session sources. Move
with `Up` and `Down`; press `Enter` or `Space` to edit.

For model fields, the presentation matches Pi's `/model` selector: the model ID comes first and
`[provider]` comes last. Type to fuzzy-search provider, model ID, or display name. At most 10 model
rows are visible; use `Page Up` and `Page Down` to move through longer results. **Use global
default** remains pinned while searching, and UI Design also offers **Disable for this session**.

The panel keeps one explicit draft while you move between fields:

- Choose **Apply changes** or press `A` to write the draft to the current branch.
- **Save effective configuration as defaults** updates the global file without applying the session draft.
- **Reset draft to off** sets an off draft and returns other draft fields to their global defaults; it remains local until Apply.
- `Escape` returns from a field editor. Closing a modified draft asks for explicit confirmation to **Keep editing** or **Discard changes**.

## 3. Keep the terminal large enough

The editor blocks editing below **24 columns or 9 rows** and displays:

```text
Terminal too small.
Resize to continue editing.
```

Resize the terminal, then reopen or continue in the panel. It does not silently fall back to an
unbounded or alternate editor.

## 4. Apply and use the next run

Applied changes affect the **next agent run**. Pi rebuilds the system prompt for each run, so turning
the policy off excludes a policy block from later runs; an agent that is already running keeps the
prompt it started with.

Active modes require exact, available, in-scope, authenticated Small, Medium, and Large references.
An optional UI Design reference is validated when configured. The extension never substitutes a
different model, role, or thinking level.

## 5. Read the footer

Pi keeps its own footer while the extension adds one textual status label:

| Label    | Meaning                                                                      | What to do                                                                                     |
| -------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `D:OFF`  | Delegation is disabled. Incomplete defaults do not change this label.        | Choose an active intensity only when your roles are ready.                                     |
| `D:NORM` | A valid `normal` configuration is active.                                    | Delegate only with clear expected benefit; keep borderline work with the main agent.           |
| `D:AGG`  | A valid `aggressive` configuration is active.                                | Delegate suitable substantial work by default unless coupling or overhead clearly dominates.   |
| `D:ERR`  | An active configuration has an invalid required role. No policy is injected. | Inspect `/delegate status`, correct the affected role, scope, availability, or authentication. |

## 6. Diagnose `D:ERR`

1. Run `/delegate status` and read the reported role and detail.
2. In `/delegate`, check that Small, Medium, and Large each have the exact provider and model ID required by the current Pi scope. Check UI Design too if it is configured.
3. Confirm the provider is authenticated and the model is available and in scope; the extension has no fallback.
4. Apply the corrected draft, run `/delegate status` again, and wait for the next agent run.

See [configuration](/pi-delegation-policy/configuration/) for inheritance and policy meanings, and
[limits and privacy](/pi-delegation-policy/limits-and-privacy/) for the fail-closed boundary.
