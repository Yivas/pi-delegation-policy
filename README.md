# pi-delegation-policy

A local Pi extension that guides the main agent on **when delegation is worth it** and which exact
models to use for Small, Medium, Large, and the optional Visual Design and Advisor roles. It is not a
general subagent runner. Only explicit tools can request reader work or Advisor consultations through
the authorized host executor; hooks never launch children.

> **Docs:** [yivas.github.io/pi-delegation-policy](https://yivas.github.io/pi-delegation-policy/).
> Version **0.21.1** requires Pi `0.87.1` or later (`>=0.87.1`); it re-applies its marked policy block in the final provider payload.
> Version `0.14.1` supports Pi `0.84.3` or later (`>=0.84.3`).
>
> Independent Advisor mode and its companion file are available from version `0.17.0`.
> Existing configurations keep Advisor tied to delegation until `on` is selected explicitly.

## Install

```bash
pi install npm:pi-delegation-policy@0.21.1
# restart Pi, or run /reload
```

1. Open `/delegate`, or press `Alt+G` in Pi's TUI.
2. Give Small, Medium, and Large an explicit decision each: an exact authenticated `provider/model`,
   or **Disable for this session**. At least one ordinary role must stay enabled. Visual Design and
   Advisor are optional and do not count toward that minimum.
3. Choose an intensity and **Apply changes**, then confirm `/delegate status`.
4. Optionally set a thinking policy per role, or leave the row unset to choose a level per launch.

Global defaults live in `~/.pi/agent/delegation-policy.json`; any branch can override them and return
to inheritance later.

## Intensities

| Intensity      | What the guidance asks                                                                                                                                                                                                                                                                                                                                  |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `off`          | No execution-delegation guidance. An independently enabled Advisor still injects its own section; with both off nothing is injected.                                                                                                                                                                                                                    |
| `normal`       | Delegate substantial, separable work only when the expected benefit clearly outweighs briefing, supervision, review, and integration. Borderline work stays with the main agent.                                                                                                                                                                        |
| `aggressive`   | Delegate suitable substantial, separable, independently checkable work by default when objective and acceptance criteria are clear.                                                                                                                                                                                                                     |
| `orchestrator` | Delegate all transferable execution before it begins whenever an enabled capable role and an authorized launcher exist, regardless of size: small lookups, reading, detailed planning, edits, tests, writing, detailed review, and integration mechanics. Direct work needs a briefly stated exception, and final acceptance stays with the main agent. |

The configuration reference states the full orchestrator rule, its exceptions, and the preference
tie-breaks.

## Roles, models, and thinking

Active delegation needs an explicit decision for every ordinary role: an exact `provider/model`
reference, or **disabled**. A disabled role is a decision, not a missing model, and it is not
validated. An absent role, an unavailable, out-of-scope or unauthenticated reference, or zero enabled
ordinary roles produces `D:ERR` and removes execution-delegation guidance.

The policy considers only enabled ordinary roles. It compares task fit first and then chooses the
least costly enabled role that can satisfy the acceptance criteria and evidence; when none can, the
work stays with the main agent. It never invents a role, model, or thinking level. Preference
(`efficient`, `standard`, `intensive`) is a tie-break between Small and Medium only, and it is inert
when either is disabled.

Visual Design is an optional specialist. It is eligible only when the primary acceptance criterion is
visual, behavior and data contracts stay unchanged, the surface is bounded, and no logic, data, API,
route, architecture, or cross-system work is involved. When those conditions hold and the visual
portion is being delegated, it takes priority over Small, Medium, and Large for that portion;
`normal` and `aggressive` are not required to delegate more because of it.

Thinking is optional per role and has three states: unset (the main agent chooses the level for each
launch), a fixed level, or an inclusive range. A configured level is validated locally against that
role's resolved model; an unsupported level is a `D:ERR` cause. The level chosen for one run is never
stored. With `pi-subagents` the launcher form is `model: "provider/model:LEVEL"`.

## Advisor

Advisor is optional, off by default, and outside the ordinary-role minimum. Configure **Advisor 1**
and optional **Advisor 2**, each with an exact model and thinking policy. Every valid advisor gets the
same question. Weigh disagreements; agreement is not proof. The packaged no-tools/no-extensions
`pi-delegation-policy.advisor` profile advises and executes nothing.

**Advisor launch** inherits globally or per branch, defaulting to `role`:

- `role`: the main agent launches every valid advisor in one background subagent call, with exact
  models and thinking. The extension observes matching attempts but does not launch them.
- `tool`: the always-registered `consult_advisor({ question, brief? })` launches one child per valid
  advisor in parallel through the public `pi-subagents` delegation API, pinned to `0.76.1`. Otherwise
  it returns unavailable text. No model, provider or executor fallback is added.

Both modes ask for consultation after orientation before substantive work, when stuck, before changing
approach, and before declaring a multi-step task done (ask for remaining risks, not approval). Short
reactive steps and mechanics in a settled approach need no new call.

Context is `fork` while the session fits in half of every valid advisor's window, `fresh` above that or
with an unknown window, and returns to fork below 35%. Unknown token usage keeps the last mode. Fork
sends the conversation to each provider, with only the question as the task. Fresh requires a short
self-contained `brief`: objective, constraints, relevant facts, options and uncertainty. The tool
retries only an explicitly rejected fork, once with fresh and only with a supplied brief. Fixed thinking
uses its exact level; a range uses its maximum; unset uses `high` if supported, otherwise the first
supported level. Role mode leaves range/unset selection to the main agent.

One pending call per tool: an advisor group launches one child per configured valid advisor, while the
independent reader can run alongside it (at most three children). Abort, branch change, shutdown and
detected authorization changes cancel the tool group. Partial results preserve a successful answer.
Local timeouts and cancellation do not cap external generation, retries or cost.

**Advisor mode** is an independent axis you set in the panel or with `/delegate advisor …`:

| Mode              | Effect                                                                                                     |
| ----------------- | ---------------------------------------------------------------------------------------------------------- |
| `on`              | Consult with delegation off. Requires a valid Advisor model; ordinary roles are not required in that case. |
| `off`             | Inject no Advisor guidance and keep the saved model and thinking policy.                                   |
| `with-delegation` | Consult only while delegation is active and an Advisor is configured. Default when the key is absent.      |

`D:OFF A:ON` shows consultation-only guidance; `D:OFF A:OFF` shows nothing injected. `/delegate reset`
turns both off for the branch; `/delegate off` leaves an independently enabled Advisor active.

Errors are reported per axis. Each entry validates independently: `A:ON` means all valid, `A:PART` means one of two valid
(consult that one), and `A:ERR` means none usable and removes only consultation: valid delegation and an otherwise authorized ContextShunt reader keep working.
`D:ERR` removes delegation guidance and leaves a valid enabled Advisor alone. A malformed main
delegation file still fails closed, and a malformed or stale Advisor companion affects only Advisor:
delegation from the main file wins, and the companion keeps its saved model and thinking policy only
while it is readable and valid, so the next save repairs that pair. A corrupt or unreadable companion
cannot supply Advisor settings. Settings still present in a legacy delegation file are retained;
otherwise, configure the Advisor model and thinking policy again.

Consulting sends a brief, or with `fork` the conversation so far, to another model and can incur
latency and cost, including with delegation off. The host sends it only after an explicit launch or tool call, never from a hook. See the [limits and privacy reference](https://yivas.github.io/pi-delegation-policy/limits-and-privacy/)
for the signals and the retention of the executor and its provider.

## Where settings live

The extension stores only policy: intensity, preference, Advisor mode, model references, the optional
ContextShunt configuration, and the thinking policies you configure. It stores no credentials, no
prompts, and never the thinking level of an individual run.

- Global defaults: `~/.pi/agent/delegation-policy.json`, schema 7 delegation only.
- Legacy companion: `delegation-policy.advisor.json`, envelope 1 with schema 8 state for Advisor 1.
  Versions `0.17–0.20` see its mode, model and thinking in role mode; `0.16` sees delegation without
  Advisor. None of those versions sees Advisor 2 or tool launch.
- Advisor extension: `delegation-policy.advisor-extension.json`, envelope 1 with normalized schema-8
  `base`, optional `advisor2` (including thinking), and `advisorLaunch`. Missing, invalid, unreadable
  or mismatched state falls back to Advisor 1 and role launch with a diagnostic, not `A:ERR` for a
  valid first advisor. Older versions ignore it.
- Session Apply: schema 2 off guard, extension entry, schema-8 companion, then schema-7 delegation
  commit. The legacy companion remains adjacent to that commit. A failure leaves both axes off.

Schema 9 accepts ordered `advisors: [{provider, model, thinking?}]` with 1–2 entries and inherited
`advisorLaunch: role|tool`. An omitted list inherits; a list replaces both entries and their thinking;
session `advisors: null` disables. Legacy `advisor` and `thinking.advisor` are single-advisor shorthand,
not combinable with `advisors`. Schemas 2–8 resolve into the effective list in memory without writing.

Global saves replace delegation, companion, then extension, individually atomically, not as a
transaction. All three previous files must be readable or absent. On failure, restore and verify only
our committed prefix, never a detected foreign write; otherwise report partial save and reload disk.
Checks are not locks. A crash can leave Advisor off or Advisor 1 only in role mode until repaired.

Records are written only while a policy block is active; both delegation and Advisor off produce no events.
Content-free events go to `~/.pi/agent/delegation-policy.events.jsonl` (or Pi's configured agent dir):
time, extension version, SHA-256 policy-block hash when it changes, intensity, Advisor modes, context
and count; consultation model IDs, status, context and duration. Role observations are attempts, not
proof of completion; duration zero means unknown. Questions, briefs, answers, conversations, project
paths and raw errors are excluded. Writes are serialized, rotate at 256 KiB to one `.1` backup, and
failures never break a request. Shutdown drains queued writes for at most five seconds, then drops
remaining work. An in-flight filesystem operation may finish later, but starts no further operation.
No network telemetry is sent; model identifiers can still be sensitive.

Before downgrading to a package that cannot read schema 4, set global and branch ContextShunt to
`off`. Before downgrading to `0.6.0`, set intensity to `off`, `normal`, or `aggressive` and run
`/delegate off` in every active branch. For `<=0.5.0`, convert global defaults to schema 2 and
replace ordinary `null` values with exact references. The downgrade guarantee of this line is for
schema 7 readers such as `0.16.0`; earlier versions keep their existing limitations.

## Commands

```text
/delegate                          Open the editor
/delegate off|normal|aggressive|orchestrator  Set the branch intensity
/delegate status                   Show effective session state
/delegate reset                    Turn delegation and Advisor off for the branch
/delegate advisor off|on|with-delegation      Set the Advisor mode
/delegate advisor launch role|tool           Select the launch surface
/delegate advisor 1|2 model PROVIDER/MODEL    Configure an entry
/delegate advisor 1|2 model remove           Remove entry 2, or both from entry 1
/delegate advisor 1|2 thinking unset|LEVEL|MIN MAX  Set thinking
/delegate context off|observe|enforce|status  Set or inspect ContextShunt
```

The editor is a bounded, keyboard-first panel: one row per setting, a compact effective-policy
preview, a hint block for the focused row with its built-in, global, and session sources, and pinned
**Use global default** and **Disable for this session** rows before the searchable model list.
Changes stay in a draft until **Apply changes**; **Save effective configuration as defaults** updates
only the global files.

`/delegate status` reports stable tokens with their source (`default`, `global`, or `session`), for
example `advisor-mode=with-delegation (global); A:OFF` and `thinking-advisor=unset (default)`.
`D:OFF`, `D:NORM`, `D:AGG`, and `D:ORCH` describe delegation; `A:OFF`, `A:ON`, `A:PART`, and `A:ERR` describe
Advisor. None of them proves that a launch happened or that another system followed the guidance.

## ContextShunt

ContextShunt is a separate opt-in layer, off by default. `observe` records what enforcement would
block without changing a call or its result; `enforce` blocks only recognized declared excess and
compacts only a known textual result it has already preserved, so `context_shunt_recover` can return
one bounded line or byte range. Errors, structured results, images, binaries, mixed content, and
unknown tool contracts stay unchanged, and nothing is launched from a hook. The reader keys
`readerEnabled`, `readerRole`, and `answerMaxBytes` control the optional
`context_shunt_delegate`/`context_shunt_recover` pair, which needs `enforce`, an active delegation
intensity, a valid configuration, and a compatible external executor. The only verified executor is
`pi-subagents` `0.76.1` on Pi `1.1.0`; Pi `0.87.1`, the declared minimum, is not verified for the
reader. Other executor builds, including `0.69.0`, fail closed with `reader-unavailable`. Since `0.19.0`,
the reader also accepts the exact `@gotgenes/pi-permission-system` `33.0.3` runtime that a host adds for
permission rules; the host owns those rules, and the reader never reads or changes them. Delegation
`off` suspends the layer.

The [limits and privacy reference](https://yivas.github.io/pi-delegation-policy/limits-and-privacy/)
states the caps, the answer contract, and what one request sends.

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

Tests use local mocks; they make no paid model calls and no network requests. See
[CONTRIBUTING.md](https://github.com/Yivas/pi-delegation-policy/blob/main/CONTRIBUTING.md).

## Attribution and license

ContextShunt adapts the large-read routing pattern described in
[Spotify Engineering's article on Portal and `shunt`](https://engineering.atspotify.com/2026/9/portal-by-spotify-cut-my-claude-code-token-usage-by-90/)
and its [`shunt` plugin](https://github.com/spotify/portal-ai-plugins/tree/main/plugins/shunt). It is
an independent adaptation for Pi and claims no affiliation or endorsement.

MIT. See [LICENSE](LICENSE).
