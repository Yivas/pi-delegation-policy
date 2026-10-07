# pi-delegation-policy

A local Pi extension that guides the main agent on **when delegation is worth it** and which exact
models to use for Small, Medium, Large, and the optional Visual Design and Advisor roles. It is not a
subagent runner: it never routes, supervises, or collects the results of delegated work.

> **Docs:** [yivas.github.io/pi-delegation-policy](https://yivas.github.io/pi-delegation-policy/).
> Version **0.16.0** is the published release and requires Pi `0.87.1` or later (`>=0.87.1`); it re-applies its marked policy block in the final provider payload.
> Version `0.14.1` supports Pi `0.84.3` or later (`>=0.84.3`).
>
> **Development version:** independent Advisor mode and its companion file are not included in npm `0.16.0`.
> Existing configurations keep Advisor tied to delegation until `on` is selected explicitly.

## Install

```bash
pi install npm:pi-delegation-policy@0.16.0
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

Advisor is an optional consultation role, off by default and outside the ordinary-role minimum. It
advises and executes nothing. The extension never launches it: when the role is enabled the injected
policy tells the main agent to launch the packaged `pi-delegation-policy.advisor` profile as a normal
subagent, with the exact configured model and `thinking.advisor` policy. The profile has no tools and
no extensions, so it reads no files, runs no commands, and reaches no network; it sees only the brief
the main agent writes, and the reply is plain text.

**Advisor mode** is an independent axis you set in the panel or with `/delegate advisor …`:

| Mode              | Effect                                                                                                     |
| ----------------- | ---------------------------------------------------------------------------------------------------------- |
| `on`              | Consult with delegation off. Requires a valid Advisor model; ordinary roles are not required in that case. |
| `off`             | Inject no Advisor guidance and keep the saved model and thinking policy.                                   |
| `with-delegation` | Consult only while delegation is active and an Advisor is configured. Default when the key is absent.      |

`D:OFF A:ON` shows consultation-only guidance; `D:OFF A:OFF` shows nothing injected. `/delegate reset`
turns both off for the branch; `/delegate off` leaves an independently enabled Advisor active.

Errors are reported per axis. An enabled Advisor whose model is missing, out of scope,
unauthenticated, or paired with an unsupported thinking level produces `A:ERR` and removes only
consultation: valid delegation and an otherwise authorized ContextShunt reader keep working.
`D:ERR` removes delegation guidance and leaves a valid enabled Advisor alone. A malformed main
delegation file still fails closed, and a malformed or stale Advisor companion affects only Advisor:
delegation from the main file wins, and the companion keeps its saved model and thinking policy only
while it is readable and valid, so the next save repairs that pair. A corrupt or unreadable companion
cannot supply Advisor settings. Settings still present in a legacy delegation file are retained;
otherwise, configure the Advisor model and thinking policy again.

Consulting sends a brief to another model and can incur latency and cost, including with delegation
off. What travels is what the main agent writes into that task; the extension itself sends no
conversation. See the [limits and privacy reference](https://yivas.github.io/pi-delegation-policy/limits-and-privacy/)
for the signals and the retention of the executor and its provider.

## Where settings live

The extension stores only policy: intensity, preference, Advisor mode, model references, the optional
ContextShunt configuration, and the thinking policies you configure. It stores no credentials, no
prompts, and never the thinking level of an individual run.

- Global defaults: `~/.pi/agent/delegation-policy.json`, written in schema 7 so version `0.16.0`
  keeps reading delegation after a downgrade.
- Advisor companion: `delegation-policy.advisor.json`, holding the current state in schema 8.
- Session: each Apply writes a schema 2 `off` guard, the Advisor entry, and the schema 7 delegation
  entry; the last one commits, and a failure leaves the guard authoritative, so both features stay
  off.

Schemas 2 through 8 are read and normalized in memory without rewriting the file, and loading never
migrates anything on disk. The extension accepts the companion only while its delegation state
matches the delegation file; a reformatted or hand-edited delegation file does not invalidate it. A
version that cannot read a setting never activates it silently.

Each of the two global files is replaced atomically, but the pair is not a filesystem transaction.
The companion is written last, so an interrupted save cannot activate a new Advisor state. A save that
cannot read one of the two previous files stops before writing and reports that nothing changed. If
the companion write fails, the extension attempts to restore the previous delegation file, then checks
both files. It reports no changes only when that check succeeds; otherwise it reports a partial save,
the panel reloads what is on disk, and `/delegate status` explains the diagnostic. A hard stop between
the two replacements can leave the files out of step until the next save, and these checks are not a
lock: another writer can change either file between a check and a replacement.

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
/delegate context off|observe|enforce|status  Set or inspect ContextShunt
```

The editor is a bounded, keyboard-first panel: one row per setting, a compact effective-policy
preview, a hint block for the focused row with its built-in, global, and session sources, and pinned
**Use global default** and **Disable for this session** rows before the searchable model list.
Changes stay in a draft until **Apply changes**; **Save effective configuration as defaults** updates
only the global files.

`/delegate status` reports stable tokens with their source (`default`, `global`, or `session`), for
example `advisor-mode=with-delegation (global); A:OFF` and `thinking-advisor=unset (default)`.
`D:OFF`, `D:NORM`, `D:AGG`, and `D:ORCH` describe delegation; `A:OFF`, `A:ON`, and `A:ERR` describe
Advisor. None of them proves that a launch happened or that another system followed the guidance.

## ContextShunt

ContextShunt is a separate opt-in layer, off by default. `observe` records what enforcement would
block without changing a call or its result; `enforce` blocks only recognized declared excess and
compacts only a known textual result it has already preserved, so `context_shunt_recover` can return
one bounded line or byte range. Errors, structured results, images, binaries, mixed content, and
unknown tool contracts stay unchanged, and nothing is launched from a hook. The reader keys
`readerEnabled`, `readerRole`, and `answerMaxBytes` control the optional
`context_shunt_delegate`/`context_shunt_recover` pair, which needs `enforce`, an active delegation
intensity, a valid configuration, and a compatible external executor (protocol `0.69.0` is the
verified one). Delegation `off` suspends the layer.

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
