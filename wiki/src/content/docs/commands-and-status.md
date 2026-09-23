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

The panel starts with an **Effective policy preview**. It summarizes effective intensity, task fit before preference, active preference behavior, enabled and disabled ordinary roles, exact role bases, and each covered role's thinking policy or `:per-run` state. Each setting then occupies one row with its effective value, and a single hint block under the list explains the focused row and reports its built-in, global, and session sources.

Move with `Up` and `Down`; press `Enter` or `Space` to edit. Every model field, including Small, Medium, Large, Visual Design, and Advisor, starts with two pinned keyboard-selectable rows:

1. **Use global default**, described as an exact reference, `disabled`, or `not configured`.
2. **Disable for this session**.

The selector shows the model ID first and `[provider]` last. Type to fuzzy-search provider, model ID, or display name. At most 10 model rows are visible; use `Page Up` and `Page Down` for longer results. When Pi supplies public model metadata, the selected row can show name, API, reasoning support, context window, and maximum output. The metadata is transient and not saved. The optional Advisor model row and its thinking row close the list, after Visual Design.

**Small thinking**, **Medium thinking**, **Large thinking**, **Visual Design thinking**, and **Advisor thinking** set the optional per-role thinking policy. Each row shows the effective policy as `unset`, one level such as `high`, or an inclusive range such as `low..high`; the built-in, global, and session values for the focused row appear in the hint block under the list. Editing one offers **Use global default** (which drops the session override), **Unset for this session (no policy)**, **Fixed level…**, and **Range (min–max)…**. A range asks for the minimum and then for the maximum, and the maximum list never goes below the chosen minimum.

Both level lists contain only the levels the role's configured model supports, in canonical order. When the role is disabled or not configured, or its model is not selectable in the panel, the panel states the reason and offers only the two unset actions. Fixed and range remain distinguishable from their text, not only from colour.

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

## 4. Apply changes

The published package `0.14.1` applies changes on the next agent run. The unreleased source on `main` requires Pi `0.87.1` or later and refreshes policy before each LLM request, so changes affect the next request in the active turn as well. A request already in progress and subagents already launched keep their existing state; turning the policy off removes the block when that version next applies its policy.

An active policy requires each ordinary role to be explicitly enabled with a valid exact reference or disabled, plus at least one enabled ordinary role. Configured Visual Design and Advisor references are also validated. Before every delegated launch, use the selected exact `provider/model` base and that role's thinking policy. With no policy, choose the level for that task from demand, difficulty, quantity, risk, review cost, and the selected model's capabilities. With a fixed policy, use exactly that level and do not change it. With a range policy, use a level inside its inclusive bounds. A bound policy is not an ambient launcher default and is never inherited by another role or by the main agent. With `pi-subagents`, append the chosen or fixed level as `model: "provider/model:LEVEL"`; a fixed policy shows its literal level in the role line instead of the `LEVEL` placeholder. Use a separate per-run thinking field when another launcher provides one.

An invalid enabled reference produces `D:ERR` and no policy, so it is never rerouted. A well-formed thinking level the role's resolved model does not support is also `D:ERR`, and the detail names the role, the level, and the model. With a valid partial configuration, guidance may select another configured enabled role only when it can satisfy the task; it never invents a role, model, or thinking level and never clamps a level to fit. When Visual Design is configured, every task or phase evaluates its four eligibility conditions before ordinary-role selection. For an eligible visual portion that is already being delegated, or whose delegation the active intensity requires, it takes priority over Small, Medium, and Large; reevaluate when the task or phase changes. This does not make `normal` or `aggressive` delegate more work.

An optional Advisor does not require delegation and does not change the ordinary-role minimum. When it is configured and valid, the injected policy makes consulting it step 1 of the decision order and tells the main agent to launch `pi-delegation-policy.advisor`, the profile that ships in this package, as a normal subagent with the exact configured model and that role's thinking policy. The signals are observable in the work: viable approaches trade off explicit requirements, evidence supports conflicting explanations that call for different actions, or a proposed change involves destructive data operations, difficult rollback, or compatibility changes for existing consumers. When a decision belongs to the user, the main agent considers the advisor before asking, so the question reaches the user with better options and trade-offs. The profile executes no work of its own and has no tools, so the brief it receives has to stand alone: the decision, the constraints, the current state and evidence, the options and their consequences, what was tried, and the open uncertainty. It is a conversation rather than a single answer, and a follow-up continues the same thread through the host's resume mechanism. With no advisor configured, no advisor section is injected and nothing else changes. Read [limits and privacy](/pi-delegation-policy/limits-and-privacy/#advisor-role) for the role, its signals, and retention.

## 5. Read the footer and status output

| Label    | Meaning                                                      | What to do                                                                                                                                         |
| -------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `D:OFF`  | Delegation is disabled. Incomplete defaults remain inactive. | Choose an active intensity only when roles are ready.                                                                                              |
| `D:NORM` | A valid `normal` configuration is active.                    | Delegate only with clear expected benefit.                                                                                                         |
| `D:AGG`  | A valid `aggressive` configuration is active.                | Delegate suitable substantial work unless coupling or overhead dominates.                                                                          |
| `D:ORCH` | A valid `orchestrator` configuration is active.              | Published `0.9.0`: delegate all transferable execution first; retain final acceptance. Published `0.7.0` retains its permissive historical policy. |
| `D:ERR`  | An active configuration is invalid. No policy is injected.   | Inspect `/delegate status` and correct the role or thinking policy.                                                                                |

`/delegate status` keeps stable tokens and reports exact effective references and sources, for example:

```text
small=disabled (session) | medium=provider/example-medium (global) | large=not configured (default)
ui-design=disabled (default) | advisor=provider/example-advisor (global) | thinking-small=fixed:high (global)
thinking-medium=range:low..high (session) | thinking-large=unset (default) | thinking-ui-design=unset (default)
thinking-advisor=unset (default)
```

The source is `default`, `global`, or `session`. The stable optional-role tokens remain `ui-design=` and `advisor=`, in that order, and `thinking-advisor=` closes the thinking group. Each role also reports its thinking policy as `unset`, `fixed:<level>`, or `range:<min>..<max>`; the token says what the policy allows, not which level a launch used, and that per-run choice is never stored. `unset (session)` means the branch keeps no policy even when global defaults set one. A sanitized restoration warning can accompany `D:OFF` when the latest stored state is invalid or from a future schema, including a malformed `thinking` entry; it neither enables injection nor reveals session content.

## 6. Use ContextShunt safely

Choose **Context protection** in the panel or use `/delegate context observe` before `/delegate context enforce`. `off` performs no ContextShunt work. `observe` changes neither the tool call nor its result. `enforce` blocks only a recognized declared excess; when a known successful text result is too large, it first preserves the original in a private temporary artifact and then returns a short recovery instruction. If preservation fails, the original result remains unchanged.

`/delegate status` reports the reader settings as `context-reader-enabled=`, `context-reader-role=`, and `context-reader-answer-max-bytes=`, each with its `default`, `global`, or `session` source, and notes that the executor is checked only on invocation. `/delegate context status` reports the same settings as `context-reader=enabled:<on|off>`, `role:<small|medium|large>`, and `answer-max-bytes:<bytes>`, each with its source, then adds `context-limits=preflight-lines … ; postresult-utf8-bytes …`, `context-coverage=known builtin text only …`, and `context-events=blocked:…,would-block:…,bounded:…,exceptions:…,archive-failures:…,uncovered:…`, without paths or preserved text. Nothing starts the reader from a hook. The packaged `agents/pi-delegation-policy.bulk-reader.md` profile allows only `read`, `grep`, `find`, and `ls` when a compatible executor loads it from the package path. It is not installed into user agent directories or automatically run. If an executor cannot load a path-based profile, use the guided redirection and exact bounded reads instead.

ContextShunt also registers two normal tools. `context_shunt_delegate` takes the opaque artifact ID, one question of at most 2048 UTF-8 bytes, and the thinking level for that call. It returns an answer with at most 16 citations to exact line ranges of the preserved snapshot, `insufficient-evidence`, or a receipt whose `answerArtifactId` `context_shunt_recover` reads back — one bounded line range (`lineOffset`, `lineLimit`) or byte range (`byteOffset`, `maxBytes`). The serialized result stays within `answerMaxBytes`. Both tools are always registered, and each call decides its own availability: with the reader disabled, with delegation `off`, with an effective mode other than `enforce`, with the invalid configuration that produces `D:ERR`, or with the reader role's model unavailable, `context_shunt_delegate` returns `output-unavailable` and no answer. With no compatible external executor — protocol version `0.69.0` is the verified one — it fails closed with `reader-unavailable`. Read [limits and privacy](/pi-delegation-policy/limits-and-privacy/#contextshunt-reader) for the input caps, the answer contract, the remaining codes, and retention.

A blocked call can be narrowed, or a real user can approve its matching next call once through the token shown in the block message. The exception is tied to that tool call and immutable input snapshot, requested line range, real-result byte maximum, and one-minute expiry; model text cannot grant it.

## 7. Diagnose `D:ERR`

1. Run `/delegate status` and read the reported role and detail.
2. Check that every ordinary role has an exact current-scope model or is explicitly disabled. Check Visual Design and Advisor if configured.
3. Confirm each enabled model is authenticated, available, and in scope; the extension has no model fallback.
4. Read the `thinking-<role>` token of the role in the detail. A `fixed:<level>` or `range:<min>..<max>` policy that names a level the role's model does not support produces this error; change the policy or the model.
5. Apply the corrected draft and run `/delegate status` again. With published `0.14.1`, wait for the next agent run; with unreleased `main` on Pi `0.87.1+`, wait for the next LLM request.

A malformed `thinking` entry is not part of this list: it invalidates the whole document, so no policy is injected at all and the sanitized warning in section 5 applies instead.

See [configuration](/pi-delegation-policy/configuration/) for inheritance and policy meanings, and [limits and privacy](/pi-delegation-policy/limits-and-privacy/) for the fail-closed boundary.
