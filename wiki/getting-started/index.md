---
title: Installation and first use
description: Install pi-delegation-policy and reach a valid delegation status safely.
---

# Installation and first use

> Independent Advisor mode and its companion file are available from version `0.17.0`.
> Existing configurations keep Advisor tied to delegation until `on` is selected explicitly.

## Requirements

- Version `0.19.0` requires Pi `0.87.1` or later (`>=0.87.1`) and re-applies its marked policy block in the final provider payload.
- Version `0.14.1` supports Pi `0.84.3` or later (`>=0.84.3`).
- An authenticated Pi model in the current scope for every ordinary role you enable. Visual Design and Advisor are optional.

## 1. Install and reload

```bash
pi install npm:pi-delegation-policy@0.19.0
```

Restart Pi or run `/reload`. Installing or upgrading changes no configuration: a session with no saved
intensity starts at `off`.

## 2. Configure or disable the ordinary roles

Open `/delegate` in Pi's TUI, or press `Alt+G`. Small, Medium, and Large each need an explicit
decision: an exact provider/model that Pi offers, or **Disable for this session**. A disabled role is
a decision, not a missing model, and it is not validated. At least one ordinary role must stay
enabled. **Visual Design** and **Advisor** are optional and do not count toward that minimum.

Every model selector pins **Use global default** and **Disable for this session** above the
searchable list. The list shows the model ID first and `[provider]` last, and searches provider,
model ID, and display name. When Pi supplies public model metadata, the focused row can show name,
API, reasoning support, context window, and maximum output; that metadata is transient and is never
stored. The panel uses text, not only colour, to distinguish `disabled`, `not configured`, and an
exact reference.

Thinking is optional per role. Leave a **thinking** row unset to let the main agent choose a level
for each launch, or configure one fixed level or an inclusive range. The panel lists only the levels
that role's model supports, and a configured level is validated locally when the policy is loaded.

Changes stay in a draft until **Apply changes**; closing a modified draft asks whether to keep editing
or discard. For `pi-subagents`, a delegated launch carries the selected base and level as
`model: "provider/model:LEVEL"`, where `LEVEL` is the fixed level, a level inside the range, or the
level chosen for that run.

## 3. Activate and inspect

Choose `normal` when the expected delegation benefit clearly outweighs briefing, supervision, review,
and integration. Choose `aggressive` for suitable substantial, separable, independently checkable
work. Choose `orchestrator` to delegate all transferable execution before it begins whenever an
enabled capable role and an authorized launcher exist, regardless of size; direct work then needs a
briefly stated exception, and final acceptance stays with the main agent. `off` injects no
execution-delegation guidance.

Apply the draft, then run `/delegate status`. `D:NORM`, `D:AGG`, and `D:ORCH` mean every ordinary
role is enabled with a valid exact reference or explicitly disabled, and at least one is enabled.
`D:ERR` means a role is not configured, an enabled reference is unavailable, out of scope, or
unauthenticated, no ordinary role is enabled, or a configured thinking level is unsupported; it
removes delegation guidance. See [commands and status](/commands-and-status/) to
diagnose it.

## 4. Enable the Advisor when you want it

The Advisor is a consultation role the main agent may launch as a subagent with the profile packaged
in this package. It advises and executes nothing, and the extension never launches it. Configure
**Advisor model** and, optionally, **Advisor thinking**, then set **Advisor mode** in the panel or run
`/delegate advisor on`.

With delegation `off` and mode `on`, status shows `D:OFF A:ON`: consultation-only guidance is
injected and ordinary roles are not required. Mode `off` silences consultation and keeps the saved
model. The default `with-delegation` preserves the previous coupling to active delegation. A
consultation sends a brief to another model and can add latency and cost even with delegation off.

Validation is reported per axis. An enabled Advisor whose model is missing, out of scope,
unauthenticated, or paired with an unsupported thinking level produces `A:ERR` and removes only
consultation: valid delegation and an otherwise authorized ContextShunt reader keep working.
Conversely, invalid delegation settings do not suppress a valid enabled Advisor. A malformed main
delegation file still fails closed, and a malformed or stale Advisor companion affects only Advisor:
the companion keeps its saved model and thinking policy only while it is readable and valid. A corrupt
or unreadable companion cannot supply Advisor settings: settings still present in a legacy delegation
file are retained, and otherwise the Advisor model and thinking policy must be configured again. Read
[configuration](/configuration/#advisor) for the modes, and
[limits and privacy](/limits-and-privacy/#advisor-role) for the signals and
retention.

## 5. Turn on ContextShunt only when needed

Choose **Context protection** in `/delegate`: start with `observe`, then choose `enforce` explicitly
if the reported decisions help. `off` is the default and does no classification, metrics, archive
I/O, or interception. `observe` changes neither a call nor its result. `enforce` covers recognized
native reads, conservative bounded PowerShell reads, and known successful text results; it never
launches a worker, re-runs a command, or bypasses tool permissions. When it preserves a large known
text result, `context_shunt_recover` returns one bounded line or byte range.

[Limits and privacy](/limits-and-privacy/#contextshunt-limits) states the caps,
the reader contract, and what one request sends.

## 6. Know what is saved

- Delegation defaults go to `~/.pi/agent/delegation-policy.json` in schema 7, so version `0.16.0`
  keeps reading delegation after a downgrade.
- Advisor settings go to the `delegation-policy.advisor.json` companion next to it; the main file
  never carries an Advisor mode.
- A branch saves a schema 2 `off` guard, the Advisor entry, and the schema 7 delegation entry, in that
  order. A failure leaves the guard authoritative, so both features stay off for that branch.

Loading never rewrites a file: schemas 2 through 8 are normalized in memory only. **Save effective
configuration as defaults** updates the global files and not the branch. Before installing an older
package, follow the downgrade steps in
[configuration](/configuration/#global-defaults-and-inheritance).

## 7. When a change takes effect

With version `0.19.0` on Pi `0.87.1` or later, the policy is refreshed before each LLM request, so a
change made during a turn affects that turn's next request. A request already in progress, and
subagents already launched, keep the state they started with. Turning everything off removes the
injected block when that version next applies its policy. Version `0.14.1` applies changes on the next
agent run.

## Local checkout (secondary)

For development, from the checkout's parent directory:

```bash
pi install ./pi-delegation-policy
```

## Next steps

- [Configuration](/configuration/) defines the policy values, inheritance, and
  compatible saves.
- [Commands and status](/commands-and-status/) covers keyboard operation and
  status tokens.
