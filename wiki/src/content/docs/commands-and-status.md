---
title: Commands and status
description: Operate the /delegate panel and interpret its status in Pi.
---

> Independent Advisor mode and its companion file are available from version `0.17.0`.
> Existing configurations keep Advisor tied to delegation until `on` is selected explicitly.

## 1. Commands

Use `/delegate` in Pi's TUI to open the keyboard-first editor; `Alt+G` opens the same editor when
available. The editor requires TUI mode, while these arguments also work in other modes:

| Command                             | Effect                                                                    |
| ----------------------------------- | ------------------------------------------------------------------------- |
| `/delegate`                         | Open the keyboard-first selector.                                         |
| `/delegate off`                     | Disable execution-delegation guidance; an enabled Advisor stays active.   |
| `/delegate normal`                  | Enable balanced delegation guidance.                                      |
| `/delegate aggressive`              | Enable delegation-first guidance.                                         |
| `/delegate orchestrator`            | Delegate all transferable execution while the main agent keeps ownership. |
| `/delegate status`                  | Show the effective session state.                                         |
| `/delegate reset`                   | Turn delegation and Advisor off for the branch.                           |
| `/delegate advisor off`             | Silence consultation and keep its model.                                  |
| `/delegate advisor on`              | Enable consultation even with delegation off.                             |
| `/delegate advisor with-delegation` | Keep the default coupling to active delegation.                           |
| `/delegate context off`             | Stop ContextShunt work for this branch.                                   |
| `/delegate context observe`         | Record what enforcement would block without changing calls.               |
| `/delegate context enforce`         | Enforce recognized budgets and bounded recovery.                          |
| `/delegate context status`          | Show the effective ContextShunt state.                                    |

There is no separate off shortcut: run `/delegate off` or choose `off` in the editor. Quick commands
write the session branch directly. **Reset draft to off** only changes the draft until Apply.

## 2. Edit the panel

The panel starts with an **Effective policy preview** that summarizes the effective intensity, the
active preference behavior, the enabled and disabled ordinary roles, exact role bases, and each
covered role's thinking policy or `:per-run` state. Each setting then occupies one row with its
effective value, and a single hint block under the list explains the focused row and reports its
built-in, global, and session sources.

Move with `Up` and `Down`; press `Enter` or `Space` to edit. Every model field — Small, Medium,
Large, Visual Design, Advisor — starts with two pinned keyboard-selectable rows: **Use global
default**, described as an exact reference, `disabled`, or `not configured`, and **Disable for this
session**. The selector shows the model ID first and `[provider]` last, fuzzy-searches provider, model
ID, and display name, and shows at most 10 rows; `Page Up` and `Page Down` move through longer
results. When Pi supplies public model metadata, the selected row can show name, API, reasoning
support, context window, and maximum output; that metadata is transient and never saved.

The thinking rows — **Small thinking**, **Medium thinking**, **Large thinking**, **Visual Design
thinking**, and **Advisor thinking** — show the effective policy as `unset`, a level such as `high`,
or an inclusive range such as `low..high`. Editing one offers **Use global default**, **Unset for this
session (no policy)**, **Fixed level…**, and **Range (min–max)…**; a range asks for the minimum and
then for the maximum, and the maximum list never goes below the chosen minimum. Both level lists
contain only the levels the role's configured model supports. When the role is disabled or not
configured, or its model is not selectable, the panel states the reason and offers only the unset
actions. Fixed and range are distinguishable from their text, not only from colour.

The Advisor rows close the list, including **Advisor mode**, which offers inheritance, `off`, `on`,
and `with-delegation`.

The panel keeps one explicit draft:

- **Apply changes** or `A` writes the draft to the current branch.
- **Save effective configuration as defaults** updates only the global files and does not apply the
  session draft.
- **Reset draft to off** makes an off draft with ordinary roles inherited until Apply.
- `Escape` returns from a field editor. Closing a modified draft asks whether to **Keep editing** or
  **Discard changes**.

If a global save cannot be completed, the panel says so and never claims that nothing changed when a
file did change: **Could not save global defaults. Nothing was changed on disk.**, **Partially saved:
the delegation file and the Advisor companion may disagree.**, or, when the outcome could not be
confirmed at all, a prompt to check `/delegate status` before retrying. See
[compatible saves](/pi-delegation-policy/configuration/#compatible-saves-and-interruption-recovery).

## 3. Keep the terminal large enough

The editor blocks editing below **26 columns or 9 rows** and displays:

```text
Terminal too small.
Resize to continue editing.
```

At or above that size, both pinned actions and at least one model row remain visible. The panel never
falls back silently to an unbounded or alternate editor.

## 4. Apply changes

The policy block is rebuilt before each LLM request, so a change made during a turn applies to that
turn's next request. A request already in progress keeps the state it started with, and subagents
already launched by the host are not cancelled or reconfigured; turning everything off removes the
block when the extension next applies its policy.

Before every delegated launch, use the selected exact `provider/model` base and that role's thinking
policy. With no policy, choose the level for that task from demand, difficulty, quantity, risk,
review cost, and the selected model's capabilities. With a fixed policy, use exactly that level. With
a range policy, use a level inside its inclusive bounds. A bound policy is never inherited by another
role or by the main agent.

## 5. Read the footer and status output

| Label    | Meaning                                                                | What to do                                                                |
| -------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `D:OFF`  | Delegation is disabled. Incomplete defaults remain inactive.           | Choose an active intensity only when the roles are ready.                 |
| `D:NORM` | A valid `normal` configuration is active.                              | Delegate only with a clear expected benefit.                              |
| `D:AGG`  | A valid `aggressive` configuration is active.                          | Delegate suitable substantial work unless coupling or overhead dominates. |
| `D:ORCH` | A valid `orchestrator` configuration is active.                        | Delegate all transferable execution first and retain final acceptance.    |
| `D:ERR`  | Execution-delegation settings are invalid; a valid Advisor can remain. | Inspect `/delegate status` and correct the role or thinking policy.       |
| `A:OFF`  | No Advisor guidance is injected.                                       | Enable the mode or configure a model if consultation is wanted.           |
| `A:ON`   | Advisor guidance is injected with a valid configured model.            | Consultation may send a brief to that model and incur latency and cost.   |
| `A:ERR`  | Advisor is enabled but unusable, so only consultation is unavailable.  | Read the diagnostic and correct the Advisor model or its thinking policy. |

`/delegate status` keeps stable tokens and reports exact effective references and sources, for
example:

```text
small=disabled (session) | medium=provider/example-medium (global) | large=not configured (default)
ui-design=disabled (default) | advisor=provider/example-advisor (global) | thinking-small=fixed:high (global)
thinking-medium=range:low..high (session) | thinking-large=unset (default) | thinking-ui-design=unset (default)
thinking-advisor=unset (default)
advisor-mode=with-delegation (global); A:ON
```

The source is `default`, `global`, or `session`. The optional role tokens `ui-design=` and `advisor=`
keep their order, and `thinking-advisor=` closes the thinking group. Each thinking policy is reported
as `unset`, `fixed:<level>`, or `range:<min>..<max>`: the token says what the policy allows, not which
level a launch used, and that per-run choice is never stored. `unset (session)` means the branch keeps
no policy even when global defaults set one.

`A:ERR` means an enabled Advisor cannot be used; it does not affect valid delegation or an authorized
ContextShunt reader, and `D:ERR` does not suppress a valid enabled Advisor. With Advisor off, an
unusable companion is reported as a diagnostic in `details=` and the footer keeps `A:OFF`. Read
[errors by axis](/pi-delegation-policy/configuration/#errors-by-axis) for the exact cases. None of
these labels proves that a launch happened or that another system followed the guidance.

A sanitized restoration warning can accompany `D:OFF` when the latest stored session state is invalid
or from a future schema, including a malformed `thinking` entry; it neither enables injection nor
reveals session content.

## 6. Use ContextShunt safely

Choose **Context protection** in the panel or use `/delegate context observe` before
`/delegate context enforce`. `off` performs no ContextShunt work, `observe` changes neither the tool
call nor its result, and `enforce` blocks only a recognized declared excess. When a known successful
text result is too large, enforcement preserves the original in a private temporary artifact and
returns a short recovery instruction; if preservation fails, the original result stays unchanged.

`/delegate status` reports the reader settings as `context-reader-enabled=`,
`context-reader-role=`, and `context-reader-answer-max-bytes=`, each with its source, and notes that
the executor is checked only on invocation. `/delegate context status` reports the same settings as
`context-reader=enabled:<on|off>`, `role:<small|medium|large>`, and `answer-max-bytes:<bytes>`, then
adds `context-limits=`, `context-coverage=`, and `context-events=`, without paths or preserved text.
Nothing starts the reader from a hook.

ContextShunt registers two normal tools. `context_shunt_delegate` takes the opaque artifact ID, one
question of at most 2048 UTF-8 bytes, and the thinking level for that call; it returns an answer with
at most 16 citations to exact line ranges of the preserved snapshot, `insufficient-evidence`, or a
receipt whose `answerArtifactId` `context_shunt_recover` reads back as one bounded line range
(`lineOffset`, `lineLimit`) or byte range (`byteOffset`, `maxBytes`). The serialized result stays
within `answerMaxBytes`. Both tools are always registered, and each call decides its own availability:
with the reader disabled, with delegation `off`, with an effective mode other than `enforce`, with an
invalid configuration, or with the reader role's model unavailable, `context_shunt_delegate` returns
`output-unavailable` and no answer. With no compatible external executor — protocol version `0.69.0`
is the verified one — it fails closed with `reader-unavailable`.

A blocked call can be narrowed, or a real user can approve its matching next call once through the
token shown in the block message. The exception is tied to that tool call and input snapshot,
requested line range, real-result byte maximum, and a one-minute expiry; model text cannot grant it.

## 7. Diagnose `D:ERR`

1. Run `/delegate status` and read the reported role and detail.
2. Check that every ordinary role has an exact current-scope model or is explicitly disabled, and
   check Visual Design if it is configured. Diagnose Advisor separately under `A:ERR`.
3. Confirm each enabled model is authenticated, available, and in scope; the extension has no model
   fallback.
4. Read the `thinking-<role>` token of the role in the detail. A policy that names a level the role's
   model does not support produces this error; change the policy or the model.
5. Apply the corrected draft, then check `/delegate status` again after the next LLM request.

A malformed `thinking` entry is not part of that list: it invalidates its document, so a main
delegation document fails closed while an Advisor companion disables consultation only, and the
sanitized warning in section 5 applies instead.

See [configuration](/pi-delegation-policy/configuration/) for inheritance and policy meanings, and
[limits and privacy](/pi-delegation-policy/limits-and-privacy/) for the fail-closed boundary.
