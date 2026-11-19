# pi-delegation-policy

A local Pi extension that guides the main agent on **when delegation is worth it** and which exact
models to use for Small, Medium, Large, and the optional Visual Design and Advisor roles. It is not a
general subagent runner: it adds one policy block to the request, one ephemeral notice after an
effective configuration change, and an optional Advisor reminder. It never changes Pi's main model,
thinking level, or tool permissions, and no hook launches a child. Only explicit tools reach the
authorized host executor: `context_shunt_delegate`, and `consult_advisor` when Advisor launch is
`tool`.

[Documentation](https://yivas.github.io/pi-delegation-policy/) · Version **0.29.0**

- Requires Pi `0.87.1` or later (`>=0.87.1`).
- Version `0.14.1` supports Pi `0.84.3` or later (`>=0.84.3`). From `0.15.0` the floor is `0.87.1`.

## Install

```bash
pi install npm:pi-delegation-policy@0.29.0
# restart Pi, or run /reload
```

1. Open `/delegate`, or press `Alt+G` in Pi's TUI.
2. Give Small, Medium, and Large an explicit decision each: an exact authenticated `provider/model`,
   or **Disable for this session**. At least one ordinary role must stay enabled. Visual Design and
   Advisor are optional and do not count toward that minimum.
3. Choose an intensity and **Apply changes**, then confirm `/delegate status`.
4. Optionally set a thinking policy per role, or leave the row unset to choose a level per launch.

Global defaults live in `~/.pi/agent/delegation-policy.json`. Any branch can override them and return
to inheritance later. Installing or upgrading changes no configuration: a session with no saved
intensity starts at `off`.

## Intensities

| Intensity      | What the guidance asks                                                                                                                                                                                                                                                                                                                                       |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `off`          | No execution-delegation guidance. An independently enabled Advisor still injects its own section; with both off no policy block is injected.                                                                                                                                                                                                                 |
| `normal`       | Delegate substantial, separable work only when the expected benefit clearly outweighs briefing, supervision, review, and integration. Borderline work stays with the main agent.                                                                                                                                                                             |
| `aggressive`   | Delegate suitable substantial, separable, independently checkable work by default when objective and acceptance criteria are clear.                                                                                                                                                                                                                          |
| `orchestrator` | Delegate all transferable execution before it begins whenever an enabled capable role and an authorized launcher exist, regardless of size: small lookups, reading, detailed planning, edits, tests, writing, detailed review, and integration mechanics. Direct work then needs a briefly stated exception, and final acceptance stays with the main agent. |

The [configuration reference](https://yivas.github.io/pi-delegation-policy/configuration/#intensities)
states the full orchestrator rule and its exceptions.

## Roles, models, and thinking

Active delegation needs an explicit decision for every ordinary role: an exact `provider/model`
reference, or **disabled**. A disabled role is a decision, not a missing model, and it is not
validated. An absent role, an unavailable, out-of-scope or unauthenticated reference, or zero enabled
ordinary roles produces `D:ERR` and removes execution-delegation guidance. There is no model,
provider, role, or thinking fallback.

The policy compares task fit first and then chooses the least costly enabled role that can satisfy the
acceptance criteria and evidence. When none can, the work stays with the main agent. Preference
(`efficient`, `standard`, `intensive`) is a tie-break between Small and Medium only, and it is inert
when either is disabled.

Visual Design and Vision are optional specialist roles, and each holds up to three exact models.
Visual Design exists because you chose those models for work whose result is judged by eye; Vision
exists because you chose models that can read images. Neither is part of the cheapest-role comparison,
which covers Small, Medium, and Large only. A configured role adds one rule per family and one line
per entry: Visual Design produces or changes how something looks, Vision reports what an image shows.
The block also states which configured models the host reports as `text+image`, `text only`, or
`unverified`, so image work is never handed to a model that cannot see it. An unusable entry is a
warning and costs only that entry, never the delegation axis.

Entries are configured from `/delegate`; [commands and status](https://yivas.github.io/pi-delegation-policy/commands-and-status/)
lists the exact forms.

Thinking is optional for each ordinary role and for every optional entry, and has three states: unset
(the main agent chooses the level for each launch), a fixed level, or an inclusive range. Advisor thinking
is not a setting. The delegation document carries thinking for the ordinary roles and for Visual
Design entry 1 only; the sidecar is the only place that accepts thinking for the other entries, one
policy per entry. A configured level is validated locally against that role's resolved model. For an
ordinary role an unsupported level is a `D:ERR` cause; for an optional entry, including the mirrored
document `thinking.uiDesign` of Visual Design entry 1, it is a warning that costs only that entry.
The level chosen for one run is never stored. With `pi-subagents` the launcher form is
`model: "provider/model:LEVEL"`.

## Launch check

While delegation is active, or while an Advisor is enabled, a check runs before any child starts. It
corrects the three cases that are unambiguous (a role name instead of a model, a role's exact model
with no level, and a child whose model is exactly one configured Advisor's), writes the exact values
into the call, and appends a note to that call's result saying what it applied. Everything else it
cannot settle is refused, with the accepted launches listed. Workflow scripts are refused while
delegation is active. `resume` keeps the child's original model. A child that will run with an
Advisor profile is refused if the call asks for `context: "fork"`.

See the [limits and privacy reference](https://yivas.github.io/pi-delegation-policy/limits-and-privacy/#launch-check)
for the accepted forms and the refusal reasons.

## Child briefs

The policy asks for a brief for every child: the bounded outcome and its owner, the context already
decided, the scope and permissions with the exclusions, how the result is verified, what it returns
and where, and when it stops to ask. An unresolved decision stays a question the child may answer
instead of a settled invariant, and a host agent name such as `worker` or `reviewer` does not replace
the model role. The block adds one emphasis line and one example per enabled role only, so `off` and
Advisor-only sessions carry no brief guidance.

## Advisor

Advisor is optional, outside the ordinary-role minimum, and has no model until you configure one. Its
mode defaults to `with-delegation`, so a configured Advisor is consulted while delegation is active.
`on` enables consultation with delegation off, and `off` silences it while keeping the saved models.
Configure **Advisor 1** and optional **Advisor 2** and **Advisor 3**, each with an exact model. Every
valid advisor gets the same question, so each extra advisor adds a consultation at every checkpoint.
Weigh disagreements, because agreement is neither proof nor authority.

- **`role` launch** (default): the main agent launches every valid advisor in one background subagent
  call. The extension observes matching attempts but does not launch them.
- **`tool` launch**: the always-registered `consult_advisor({ question, brief?, evidence? })` launches
  one child per valid advisor in parallel through the public `pi-subagents` API. It requires a stable
  SemVer version `>=0.76.1`, with no upper bound, and the strict launch contract.

Every consultation runs in fresh context: the request carries the question and a short self-contained
brief (objective and constraints, relevant facts, options and proposal, uncertainty) and never your
conversation. A first consultation in a task requires that brief. In `tool` launch, later calls in the
same task continue each advisor's thread and send only the new question plus `evidence`. The Advisor
therefore sees only what you write in the brief, so a thin brief weakens the advice. A call that asks
to fork the session for an Advisor is refused.

Consulting sends the question and brief to another model and can incur latency and cost, including
with delegation off. One residual stays outside the extension's reach: a fork default configured in
`pi-subagents` itself is not read here and the host would honour it. The
[configuration reference](https://yivas.github.io/pi-delegation-policy/configuration/#advisor) covers
threads, recovery, provider extensions, and the exact option names. The
[limits and privacy reference](https://yivas.github.io/pi-delegation-policy/limits-and-privacy/#advisor-role)
covers what each mode sends and retains.

`D:OFF A:ON` shows consultation-only guidance, and `D:OFF A:OFF` means neither axis injects a policy
block. `/delegate reset` turns both off for the branch, and `/delegate off` leaves an independently
enabled Advisor active. Errors are reported per axis: `A:PART` means some advisors are valid and
usable, `A:ERR` means none is and removes only consultation, and `D:ERR` leaves a valid enabled
Advisor alone.

### Advisor reminder

The global **Advisor reminder** row adds one short reminder to the request context, at most once per
operative task of each instance, so a useful consultation does not depend on the user remembering to
ask. It is on by default, is presented only while a valid Advisor is active and the configured launch
mode has its launcher among the active tools, and never starts a turn, a child, or a consultation.

## ContextShunt

ContextShunt is a separate opt-in layer, off by default. `observe` records what enforcement would
block without changing a call or its result. `enforce` blocks only recognized declared excess and
compacts only a known textual result it has already preserved, so `context_shunt_recover` can return
one bounded line or byte range. Errors, structured results, images, binaries, mixed content, and
unknown tool contracts stay unchanged, and nothing is launched from a hook. The reader keys
`readerEnabled`, `readerRole`, and `answerMaxBytes` control the optional
`context_shunt_delegate`/`context_shunt_recover` pair, which needs `enforce`, an active delegation
intensity, a valid configuration, and a compatible external executor. The reader requires stable
`pi-subagents` SemVer `>=0.76.1` and also accepts the exact `@gotgenes/pi-permission-system` `33.0.3`
runtime when the host adds it to the child. Delegation `off` suspends the layer.

The [limits and privacy reference](https://yivas.github.io/pi-delegation-policy/limits-and-privacy/)
states the caps, the answer contract, and what one request sends.

## Commands

```text
/delegate                          Open the editor
/delegate off|normal|aggressive|orchestrator  Set the branch intensity
/delegate status                   Show effective session state
/delegate reset                    Turn delegation and Advisor off for the branch
/delegate advisor off|on|with-delegation      Set the Advisor mode
/delegate advisor launch role|tool           Select the launch surface
/delegate advisor 1|2|3 model PROVIDER/MODEL  Configure an entry, in order
/delegate advisor 1|2|3 model inherit  Return every Advisor entry to global inheritance
/delegate advisor 1|2|3 model remove   Remove an entry; entry 1 removes all
/delegate advisor threads status|recover|reset  Inspect, recover or reset threads
/delegate context off|observe|enforce|status  Set or inspect ContextShunt
/delegate context allow TOKEN LINES BYTES  Approve the next matching blocked read once
```

The editor is a bounded, keyboard-first panel: one row per setting, a compact effective-policy
preview, a hint block for the focused row with its built-in, global, and session sources, and pinned
**Use global default** and **Disable for this session** rows before the searchable model list.
Changes stay in a draft until **Apply changes**. **Save effective configuration as defaults** updates
only the global files.

`/delegate status` reports stable tokens with their source (`default`, `global`, or `session`), for
example `advisor-mode=with-delegation (global); A:OFF` and `thinking-small=unset (default)`.
`D:OFF`, `D:NORM`, `D:AGG`, and `D:ORCH` describe delegation. `A:OFF`, `A:ON`, `A:PART`, and `A:ERR`
describe Advisor. Those labels describe configuration only; `launches=` is the field that reports
launches, counted by role from the guard's own records, so a configured role that never ran stays
visible at zero (the Advisor row at zero is the exception: it needs an entry configured and its mode
active, though a recorded launch still prints), and a child the guard could not match to an enabled
role counts as `unattributed`. Neither proves a child finished or followed its brief. See
[commands and status](https://yivas.github.io/pi-delegation-policy/commands-and-status/) for the panel
keys, the status field order, and the `D:ERR` diagnosis.

### Configuration change notice

After an effective configuration change (a `/delegate` save, or an edit of the global defaults that
changes effective values), the next user turn carries one extension-owned notice in the request
context. It lists the values that changed since the configuration the model was last shown and is not
system policy: it never enters the conversation, it disappears with the turn, and it reports
configuration rather than availability. Grouped changes report once, a reversion reports nothing, and
opening or cancelling the editor writes nothing. With delegation and Advisor both off, one notice says
`Delegation and Advisor disabled by this policy.` and nothing further is injected while both stay off.
The [limits and privacy reference](https://yivas.github.io/pi-delegation-policy/limits-and-privacy/#configuration-change-notice)
states how a notice is consumed and the accepted window it cannot close.

## Where state lives

Settings live under `~/.pi/agent`, or Pi's configured agent directory. The extension stores no
credentials, no prompts, and never the thinking level of an individual run.

- **Global defaults**: `delegation-policy.json`, schema 7: intensity, preference, the tri-state
  ordinary roles, `uiDesign`, the thinking policies, and the ContextShunt configuration.
- **Advisor 1**: `delegation-policy.advisor.json`, envelope 1 with schema 8 state.
- **Advisors 2 and 3 and the launch mode**: `delegation-policy.advisor-extension.json`, envelope 1
  with a normalized schema-8 `base`, optional `advisor2` and `advisor3`, and `advisorLaunch`. With a
  provider opt-in saved it becomes envelope 2, which older readers treat as every Advisor off.
- **Provider admissions**: `delegation-policy.provider-extensions.json`, schema 1 with the package
  and version admitted per provider.
- **Launch correction mode**: `delegation-policy.launch-correction.json`, schema 1 with `mode`
  (`correct` by default, or `block`).
- **Advisor reminder**: `delegation-policy.advisor-reminders.json`, schema 1 with `mode` (`remind` by
  default, or `off`).
- **Advisor threads**: `delegation-policy.advisor-threads.json`, plus
  `.lock/<parent>`, `.commit.lock`, and `.reclaim.lock` beside it. The journal is private and
  content-free.
- **Local events**: `delegation-policy.events.jsonl`, content-free, rotated at 256 KiB with one
  backup.

A session Apply writes a schema 2 off guard, the extension entry, the schema-8 companion, and then the
schema-7 delegation commit. A failure leaves both axes off. Loading never rewrites a file: schemas 2
through 9 resolve into the schema-10 effective state in memory, and schema 9 accepts an ordered
`advisors` list of one to three entries.

The [persistence reference](https://yivas.github.io/pi-delegation-policy/configuration/#persistence-and-compatibility)
lists which versions read which schema, and the
[downgrade steps](https://yivas.github.io/pi-delegation-policy/configuration/#downgrade) you must
take before installing an older package.

## Development

```bash
npm ci
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
npm run pack:check
```

Tests use local mocks. They make no paid model calls and no network requests. See
[CONTRIBUTING.md](https://github.com/Yivas/pi-delegation-policy/blob/main/CONTRIBUTING.md).

## Attribution and license

ContextShunt adapts the large-read routing pattern described in
[Spotify Engineering's article on Portal and `shunt`](https://engineering.atspotify.com/2026/9/portal-by-spotify-cut-my-claude-code-token-usage-by-90/)
and its [`shunt` plugin](https://github.com/spotify/portal-ai-plugins/tree/main/plugins/shunt). It is
an independent adaptation for Pi and claims no affiliation or endorsement.

MIT. See [LICENSE](LICENSE).
