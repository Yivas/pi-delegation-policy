---
title: Commands and status
description: Operate the /delegate panel and interpret its status in Pi.
---

## 1. Choose how to operate

Use `/delegate` in Pi's TUI to open the keyboard-first editor. `Alt+G` opens the same editor when available. The editor requires TUI mode; these command arguments remain available in other modes. The published `0.9.0` package supports `off`, `normal`, `aggressive`, and `orchestrator` with the stricter `D:ORCH` guidance. Published `0.7.0` retains its permissive historical policy:

| Command                     | Effect                                                   |
| --------------------------- | -------------------------------------------------------- |
| `/delegate`                 | Open the keyboard-first selector.                        |
| `/delegate off`             | Disable policy injection for the current session branch. |
| `/delegate normal`          | Enable balanced delegation guidance.                     |
| `/delegate aggressive`      | Enable delegation-first guidance.                        |
| `/delegate orchestrator`    | Minimize main-agent execution while retaining ownership. |
| `/delegate status`          | Show the effective session state.                        |
| `/delegate reset`           | Reset the current session branch to `off`.               |
| `/delegate context off`     | Stop ContextShunt work for this branch.                  |
| `/delegate context observe` | Record what enforce would block without changing calls.  |
| `/delegate context enforce` | Enforce recognized budgets and bounded recovery.         |
| `/delegate context status`  | Show the effective ContextShunt state.                   |

There is no separate off shortcut: run `/delegate off` or choose `off` in the editor. Quick commands write the session branch directly. Context mode commands do not open a TUI dialog, so they work in non-interactive modes. **Reset draft to off** only changes the draft until Apply.

## 2. Edit the panel

The panel starts with an **Effective policy preview**. It summarizes effective intensity, task fit before preference, active preference behavior, enabled and disabled ordinary roles, exact role bases, and the requirement to choose thinking per launch. It also shows each setting's effective value and built-in, global, and session sources.

Move with `Up` and `Down`; press `Enter` or `Space` to edit. Every model field, including Small, Medium, Large, and Visual Design, starts with two pinned keyboard-selectable rows:

1. **Use global default**, described as an exact reference, `disabled`, or `not configured`.
2. **Disable for this session**.

The selector shows the model ID first and `[provider]` last. Type to fuzzy-search provider, model ID, or display name. At most 10 model rows are visible; use `Page Up` and `Page Down` for longer results. When Pi supplies public model metadata, the selected row can show name, API, reasoning support, context window, and maximum output. The metadata is transient and not saved.

The panel keeps one explicit draft:

- **Apply changes** or `A` writes the draft to the current branch.
- **Save effective configuration as defaults** updates only the global file and does not apply the session draft.
- **Reset draft to off** makes an off draft with ordinary roles inherited until Apply.
- `Escape` returns from a field editor. Closing a modified draft asks whether to **Keep editing** or **Discard changes**.

## 3. Keep the terminal large enough

The editor blocks editing below **26 columns or 9 rows** and displays:

```text
Terminal too small.
Resize to continue editing.
```

At or above that size, both pinned actions and at least one model row remain visible. The panel does not silently fall back to an unbounded or alternate editor.

## 4. Apply and use the next run

Applied changes affect the **next agent run**. Pi rebuilds the system prompt for each run, so turning the policy off excludes a policy block from later runs; an agent already running keeps its starting prompt.

An active policy requires each ordinary role to be explicitly enabled with a valid exact reference or disabled, plus at least one enabled ordinary role. A configured Visual Design reference is also validated. Before every delegated launch, use the selected exact `provider/model` base and choose thinking for that task. With `pi-subagents`, append the selected level as `model: "provider/model:LEVEL"`; use a separate per-run thinking field when another launcher provides one.

An invalid enabled reference produces `D:ERR` and no policy, so it is never rerouted. With a valid partial configuration, guidance may select another configured enabled role only when it can satisfy the task; it never invents a role, model, or thinking level.

## 5. Read the footer and status output

| Label    | Meaning                                                      | What to do                                                                                                                                         |
| -------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `D:OFF`  | Delegation is disabled. Incomplete defaults remain inactive. | Choose an active intensity only when roles are ready.                                                                                              |
| `D:NORM` | A valid `normal` configuration is active.                    | Delegate only with clear expected benefit.                                                                                                         |
| `D:AGG`  | A valid `aggressive` configuration is active.                | Delegate suitable substantial work unless coupling or overhead dominates.                                                                          |
| `D:ORCH` | A valid `orchestrator` configuration is active.              | Published `0.9.0`: delegate all transferable execution first; retain final acceptance. Published `0.7.0` retains its permissive historical policy. |
| `D:ERR`  | An active configuration is invalid. No policy is injected.   | Inspect `/delegate status` and correct the role.                                                                                                   |

`/delegate status` keeps stable tokens and reports exact effective references and sources, for example:

```text
small=disabled (session) | medium=provider/example-medium (global) | large=not configured (default)
```

The source is `default`, `global`, or `session`. The stable Visual Design token remains `ui-design=`. A sanitized restoration warning can accompany `D:OFF` when the latest stored state is invalid or from a future schema; it neither enables injection nor reveals session content.

## 6. Use ContextShunt safely

Choose **Context protection** in the panel or use `/delegate context observe` before `/delegate context enforce`. `off` performs no ContextShunt work. `observe` changes neither the tool call nor its result. `enforce` blocks only a recognized declared excess; when a known successful text result is too large, it first preserves the original in a private temporary artifact and then returns a short recovery instruction. If preservation fails, the original result remains unchanged.

`/delegate context status` reports the requested reader role and `model=unknown`: this package has no automatic hook-to-worker bridge. The packaged `agents/pi-delegation-policy.bulk-reader.md` profile allows only `read`, `grep`, `find`, and `ls` when a compatible executor loads it from the package path. It is not installed into user agent directories or automatically run. If an executor cannot load a path-based profile, use the guided redirection and exact bounded reads instead.

A blocked call can be narrowed, or a real user can approve its matching next call once through the token shown in the block message. The exception is tied to that operation, requested range, and one-minute expiry; model text cannot grant it.

## 7. Diagnose `D:ERR`

1. Run `/delegate status` and read the reported role and detail.
2. Check that every ordinary role has an exact current-scope model or is explicitly disabled. Check Visual Design if configured.
3. Confirm each enabled model is authenticated, available, and in scope; the extension has no model fallback.
4. Apply the corrected draft, run `/delegate status` again, and wait for the next agent run.

See [configuration](/pi-delegation-policy/configuration/) for inheritance and policy meanings, and [limits and privacy](/pi-delegation-policy/limits-and-privacy/) for the fail-closed boundary.
