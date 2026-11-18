# pi-delegation-policy

A local Pi extension that guides the main agent on **when delegation is worth it** and which exact
models to use for Small, Medium, Large, and the optional Visual Design and Advisor roles. It is not a
general subagent runner. Only explicit tools can request reader work or Advisor consultations through
the authorized host executor; hooks never launch children.

> **Docs:** [yivas.github.io/pi-delegation-policy](https://yivas.github.io/pi-delegation-policy/).
> Version **0.28.1** requires Pi `0.87.1` or later (`>=0.87.1`); it re-applies its marked policy block in the final provider payload.
> Version `0.14.1` supports Pi `0.84.3` or later (`>=0.84.3`).
>
> Independent Advisor mode and its companion file are available from version `0.17.0`.
> Existing configurations keep Advisor tied to delegation until `on` is selected explicitly.

## Install

```bash
pi install npm:pi-delegation-policy@0.28.1
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
| `off`          | No execution-delegation guidance. An independently enabled Advisor still injects its own section; with both off no policy block is injected.                                                                                                                                                                                                            |
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

While delegation is active, a launch check runs before any child starts. It corrects the three cases
that are unambiguous — a role name instead of a model, a role's exact model with no level, and a
child whose model is exactly one configured Advisor's — writes the exact values into the call, and
appends a note to that call's result saying what it applied. Everything else it cannot settle is
refused, with the accepted launches listed. See the
[limits and privacy reference](https://yivas.github.io/pi-delegation-policy/limits-and-privacy/#launch-check).

The policy asks for a brief for every child: the bounded outcome and its owner, the context already
decided, the scope and permissions with the exclusions, how the result is verified, what it returns
and where, and when it stops to ask. An unresolved decision stays a question the child may answer
instead of a settled invariant, and a host agent name such as `worker` or `reviewer` does not replace
the model role. The block adds one emphasis line and one example per enabled role only.

## Advisor

Advisor is optional, off by default, and outside the ordinary-role minimum. Configure **Advisor 1**
and optional **Advisor 2** and **Advisor 3**, each with an exact model. Advisor thinking is not a
setting: role launch lets the main agent choose it per run, and tool launch picks it automatically.
Every valid advisor gets the same question, so each extra advisor adds a consultation at every
checkpoint. Weigh disagreements; agreement is not proof. The packaged no-tools/no-extensions
`pi-delegation-policy.advisor` profile advises and executes nothing.

**Advisor launch** inherits globally or per branch, defaulting to `role`:

- `role`: the main agent launches every valid advisor in one background subagent call, with exact
  models and a thinking level it chooses per run. The extension observes matching attempts but does
  not launch them.
- `tool`: the always-registered `consult_advisor({ question, brief?, evidence? })` launches one
  child per valid advisor in parallel through the public `pi-subagents` delegation API. It requires
  a stable SemVer version `>=0.76.1`, with no upper bound; prereleases and invalid versions are
  rejected. Every launch must still pass the strict contract and terminal-binding checks. Otherwise
  it returns unavailable text. No model, provider or executor fallback is added.

In `tool` launch, a consultation keeps each advisor's conversation for the rest of the operative
task. The first call launches the packaged profiles and is the only turn that carries the verified
launch contract. Later calls in the same task continue each thread with the public RPC `resume`,
passing the new question plus `evidence` for what changed and never a run id, output path, model or
profile. The answer is accepted only from the per-turn output file the extension owns, after the
new run id reports one completed step with the same agent, model and thinking; a resumed turn
relies on the contract the host inherits plus those observed values, not on a re-verified digest.
Any mismatch, timeout or missing answer blocks the thread: it is never retried, replaced by a fresh
launch, or continued from an older run id, and recovery can only use the receipt of the turn that is
actually pending, never an earlier one. A task ends when it settles and cannot be resumed, even if
persisting its closure fails. Its answered records remain closing obligations in the same journal;
a new task cannot bypass them, and recovery must persist their closures before consultation can
restart. Uncertain turns still require terminal proof for their current operation. A fresh prompt,
a branch move or a configuration change starts a new thread, and a prompt an extension sends opens
no task, so a consultation from one starts nothing. The journal is private and content-free; the
answer files and the child sessions keep the host's and provider's normal retention. Output paths
are checked from the trusted agent directory before creating descendants or reading answers;
pre-existing symlinks and junctions in the owned tree are refused. This is not protection against a
malicious host runtime replacing paths concurrently.

Every configured advisor keeps its position in the group and gets an explicit result, so two
answers out of three report `partial`. `/delegate advisor threads status|recover|reset`, or `C` in
the `/delegate` panel, reports the continuity state, reconciles a possibly live turn with public
terminal proof, and abandons threads only when nothing may still be running.

Continuity uses three lock directories of its own beside the journal, all under the same agent
directory: `delegation-policy.advisor-threads.json.lock/<parent>` per session,
`delegation-policy.advisor-threads.json.commit.lock` for each write, and
`delegation-policy.advisor-threads.json.reclaim.lock` for the short reclamation section. A
reclamation gate left behind by a crashed process is never reclaimed automatically, so recovery can
stay blocked until it is cleared by hand; `/delegate advisor threads recover` reports that case and
changes nothing. Clear it only with every Pi process that uses this configuration stopped and
confirmed finished: remove `delegation-policy.advisor-threads.json.reclaim.lock`, and a
`delegation-policy.advisor-threads.json.lock/<parent>` whose recorded owner is gone. Never remove a
lock while a process that uses it may still be running. The locks assume one host and a local
filesystem, and owner liveness is the only OS signal they use.

Both modes ask for consultation after orientation before substantive work, when stuck, before changing
approach, and before declaring a multi-step task done (ask for remaining risks, not approval). Short
reactive steps and mechanics in a settled approach need no new call.

### Advisor reminder

The global **Advisor reminder** row in `/delegate` adds one short reminder to the request context, at
most once per operative task of each instance, so a useful consultation does not depend on the user
remembering to ask for it. It is on by default and stored in `delegation-policy.advisor-reminders.json`;
`off` adds nothing. The reminder is presented only while a valid Advisor is active, the task is live
and the configured launch mode has its launcher among the active tools (`subagent` for `role`,
`consult_advisor` for `tool`), so a session that cannot consult is never told to.

Two observable events arm it: one successful builtin orientation result (`read`, `find`, `grep` or
`ls`), presented in the next request, and the same builtin tool failing in two different rounds. A
batch of results is one round, and a retry of the same request keeps the presentation it already
carried. An attempted consultation ends the reminder for that task even when it fails, and a control
action that only names an Advisor is not a consultation. Turning the reminder off, a branch move, a
new task or the task settling discards it; re-enabling it never restores a presentation the same task
already used. Only the documented `pi-subagents` process markers (`PI_SUBAGENT_CHILD=1`,
`PI_SUBAGENT_RUNNER_PID`) exclude a child; a `/fork` or `/clone` of a human session is still a main
session and keeps the reminder.

The reminder is ephemeral: it is appended to the request copy after the policy block and the
configuration notice, never to the conversation, and it starts no turn, no child and no consultation.
It adds no authority, revokes no instruction, and cannot make a consultation happen; it also cannot
promise to arrive before the first edit, and it only reacts to the builtin tools listed above.

Every consultation runs in fresh context: the request carries the question and a short self-contained
`brief` — objective and constraints, relevant facts, options and proposal, uncertainty — and never the
conversation. A first consultation in a thread requires that brief; a later call in the same task sends
only the new question and evidence. The Advisor therefore sees only what you write in the brief, so a
thin brief weakens the advice. The tool launches each advisor at the highest level its model supports
among `high`, `medium`, `low`, `minimal` and `off`, in that order. A level above `high` is used only by
a model that supports none of them.

One pending call per tool: an advisor group launches one child per configured valid advisor, while the
independent reader can run alongside it (at most four children). Abort, branch change, shutdown and
detected authorization changes cancel the tool group. Partial results preserve a successful answer.
Local timeouts and cancellation do not cap external generation, retries or cost.

**Advisor mode** is an independent axis you set in the panel or with `/delegate advisor …`:

| Mode              | Effect                                                                                                     |
| ----------------- | ---------------------------------------------------------------------------------------------------------- |
| `on`              | Consult with delegation off. Requires a valid Advisor model; ordinary roles are not required in that case. |
| `off`             | Inject no Advisor guidance and keep the saved models.                                                      |
| `with-delegation` | Consult only while delegation is active and an Advisor is configured. Default when the key is absent.      |

`D:OFF A:ON` shows consultation-only guidance; `D:OFF A:OFF` means neither axis injects a policy block. `/delegate reset`
turns both off for the branch; `/delegate off` leaves an independently enabled Advisor active.

Errors are reported per axis. Each entry validates independently: `A:ON` means all valid, `A:PART` means some valid
(consult those), and `A:ERR` means none usable and removes only consultation: valid delegation and an otherwise authorized ContextShunt reader keep working.
`D:ERR` removes delegation guidance and leaves a valid enabled Advisor alone. A malformed main
delegation file still fails closed, and a malformed or stale Advisor companion affects only Advisor:
delegation from the main file wins, and the companion keeps its saved model only while it is readable
and valid, so the next save repairs that pair. A corrupt or unreadable companion cannot supply Advisor
settings. Settings still present in a legacy delegation file are retained; otherwise, configure the
Advisor model again.

Consulting sends the question and brief to another model — the extension never adds your
conversation, and a child that asks to fork the session is refused — and it can incur latency and
cost, including with delegation off. A fork default set in `pi-subagents` itself is outside the
extension's reach, so check that setting if this matters to you. The host sends it only after an explicit launch or tool call, never from a hook. See the [limits and privacy reference](https://yivas.github.io/pi-delegation-policy/limits-and-privacy/)
for the signals and the retention of the executor and its provider.

### Provider extension

Each Advisor has an explicit **Anthropic auth 3.4.3/3.4.4/3.6.0** profile option in the native panel: choosing an
`anthropic` model for an Advisor row asks for **Standard** or **Anthropic auth**. It selects
`pi-delegation-policy.advisor-anthropic-auth`, a separate no-tools profile that preserves the installed
provider extension's normal configuration, startup hook and account diagnostic command. It does not
change the model, inherit all extensions, or alter ContextShunt. Only provider `anthropic`
and an exact managed-user installation are supported; unavailable or incompatible setups fail closed.
The account diagnostic is never invoked during initialization. With this opt-in saved, downgrading to
0.22.2 leaves all Advisors off instead of falling back to the standard profile. Available from
0.23.0. One bounded real-provider background consultation completed in fresh context on
Pi 1.4.0 with pi-subagents 0.83.1. Launch metadata showed only the prompt runtime and configured
provider bridge, with no required extensions or observed tool calls. This does not validate
`consult_advisor`, other builds, or a sole cause of the earlier failure. See the
[configuration reference](https://yivas.github.io/pi-delegation-policy/configuration/#provider-extension)
for the schema-10 option, trusted-code surface and installation limits.

Other providers that only an extension supplies can be admitted from the same panel: choosing such a
model offers your installed packages as `trusted extension, identity only`. The admission is global
and per provider, and the separate profile `pi-delegation-policy.advisor-provider-extension` loads
that one package in the child. Only the package identity is checked before it runs, so it is trusted
code, not a sandbox. See
[admitted provider extensions](https://yivas.github.io/pi-delegation-policy/configuration/#admitted-provider-extensions).

## Where settings live

The extension stores only policy: intensity, preference, Advisor mode, model references, the optional
ContextShunt configuration, and the thinking policies you configure. It stores no credentials, no
prompts, and never the thinking level of an individual run.

- Global defaults: `~/.pi/agent/delegation-policy.json`, schema 7 delegation only.
- Launch correction mode: the global **Launch correction** row in `/delegate` stores
  `delegation-policy.launch-correction.json`, schema 1 with `mode`. Missing or invalid state means
  `correct`, the normal behaviour; `block` is a test mode that refuses every case the check would
  correct. Older versions ignore the file.
- Advisor reminder: the global **Advisor reminder** row stores
  `delegation-policy.advisor-reminders.json`, schema 1 with `mode` (`off` or `remind`). A missing
  file means `remind`; an unreadable or invalid one suspends only the reminder with a diagnostic and
  never changes the delegation or Advisor axis, and the row then reads
  `Unavailable/Suspended · global` instead of showing the suspension as a choice. Older versions
  ignore the file.
- Legacy companion: `delegation-policy.advisor.json`, envelope 1 with schema 8 state for Advisor 1.
  Versions `0.17–0.20` see its mode and model in role mode; `0.16` sees delegation without Advisor.
  None of those versions sees Advisor 2, Advisor 3 or tool launch.
- Advisor extension: `delegation-policy.advisor-extension.json`, envelope 1 with normalized schema-8
  `base`, optional `advisor2`, optional `advisor3`, and `advisorLaunch`. Missing, invalid, unreadable
  or mismatched state falls back to Advisor 1 and role launch with a diagnostic, not `A:ERR` for a
  valid first advisor. Older versions ignore it, and `0.21`–`0.23` fall back to Advisor 1 when it
  holds `advisor3`. A save from one of those versions then drops Advisors 2 and 3.
- Session Apply: schema 2 off guard, extension entry, schema-8 companion, then schema-7 delegation
  commit. The legacy companion remains adjacent to that commit. A failure leaves both axes off.

Schema 9 accepts ordered `advisors: [{provider, model}]` with 1–3 entries and inherited
`advisorLaunch: role|tool`. An omitted list inherits; a list replaces every entry; session
`advisors: null` disables. Legacy `advisor` and `thinking.advisor` are single-advisor shorthand,
not combinable with `advisors`. A per-entry `thinking`, or a `thinking.advisor` saved by an earlier
version, must still be well formed, but it is ignored and dropped on the next save. Schemas 2–9 resolve into the schema-10 effective state in memory without writing. Schema 10 adds the per-Advisor provider opt-in described above; saves without it retain the envelope-1 layout.

Global saves replace delegation, companion, then extension, individually atomically, not as a
transaction. All three previous files must be readable or absent. On failure, restore and verify only
our committed prefix, never a detected foreign write; otherwise report partial save and reload disk.
Checks are not locks. A crash can leave Advisor off or Advisor 1 only in role mode until repaired.

Records are written only while a policy block is active; both delegation and Advisor off produce no
events, except records written in the short window before the next request notices that the policy
is off. Content-free events go to `~/.pi/agent/delegation-policy.events.jsonl` (or Pi's configured
agent dir): time, extension version, SHA-256 policy-block hash when it changes, intensity, Advisor
modes, context and count; consultation model IDs, status, context and duration; one `task` summary
per main-agent task from a user prompt to the next settle (duration, tool calls, edits, the position
of the first edit and of the first consult, whether the consult came before the first edit, subagent
launches and refusals); one `launch` record per subagent call that launches children (allowed or
refused, a closed refusal code, child count, one role code per child, and the closed kinds of
correction applied); an allowed record with no
children appears only in that off window and still counts as a launch, while a refusal (for example
a workflow script or a parallel call without tasks) can also carry no children. Consultation, `task`
and `launch` records repeat the policy hash they ran under. `advisorConsults` counts attempts: a
`consult_advisor` call counts whether or not it reached a model, and its real outcome is the
`consultation` event. `subagentLaunches` counts allowed calls that launch a child other than an
Advisor: a call that launches only Advisors counts as a consult, a mixed call counts as both, and a
refused call counts only as a refusal. Role observations are attempts, not proof of completion;
duration zero means unknown. Questions, briefs, answers, conversations, project paths and raw errors
are excluded. Writes are serialized, rotate at 256 KiB to one `.1` backup, and failures never break
a request. Shutdown drains queued writes for at most five seconds, then drops remaining work. An
in-flight filesystem operation may finish later, but starts no further operation.
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
/delegate advisor 1|2|3 model PROVIDER/MODEL  Configure an entry, in order
/delegate advisor 1|2|3 model remove         Remove an entry; entry 1 removes all
/delegate context off|observe|enforce|status  Set or inspect ContextShunt
```

The editor is a bounded, keyboard-first panel: one row per setting, a compact effective-policy
preview, a hint block for the focused row with its built-in, global, and session sources, and pinned
**Use global default** and **Disable for this session** rows before the searchable model list.
Changes stay in a draft until **Apply changes**; **Save effective configuration as defaults** updates
only the global files.

`/delegate status` reports stable tokens with their source (`default`, `global`, or `session`), for
example `advisor-mode=with-delegation (global); A:OFF` and `thinking-small=unset (default)`.
`D:OFF`, `D:NORM`, `D:AGG`, and `D:ORCH` describe delegation; `A:OFF`, `A:ON`, `A:PART`, and `A:ERR` describe
Advisor. None of them proves that a launch happened or that another system followed the guidance.

The footer also revalidates after all session-start handlers finish. If another extension makes a
configured model available later in startup, the earlier `D:ERR` is replaced with the current status
without waiting for a message or menu action. A model that remains invalid still reports `D:ERR`.

### Configuration change notice

Available from `0.22.0`. The declared Pi peer remains
`>=0.87.1`; the notice hooks and conversion are verified against `0.87.1` with a synthetic harness,
not a full host process or later host versions.

After an effective configuration change — a `/delegate` save, or an edit of the global defaults that
changes effective values — the next user turn carries one extension-owned notice in the request
context. It lists the values that changed since the configuration the model was last shown:
intensity, preference, ordinary roles, Visual Design, thinking policies, Advisor entries, mode and
launch, the ContextShunt mode, and the reader role, toggle and answer limit. The ContextShunt
enforcement tuning (`limits`, `exceptionPatterns`, `delegationHintPatterns`) is left out on purpose:
it changes how much the shunt preserves or compacts, not the assignments the model follows. The
notice is not system policy and never enters the conversation: it exists only in the requests of
that turn, identical across their retries, and it disappears with the turn.

The reference is the configuration the model was actually shown, so changes made before a turn are
grouped, a reversion before the turn reports nothing, and an edit that leaves effective values
unchanged reports nothing. Opening or cancelling the editor writes nothing and reports nothing. A
change made while a turn is already running reaches the policy immediately and is reported on the
next turn; a revision that has not been shown is never consumed by an earlier turn.

Consumption happens when the run ends and its last recorded outcome is a completed response: the
extension reads the last assistant message of the final `agent_end` and keeps the presented revision
only when that response completed. An error the host retries and that then succeeds counts as
completed, so the notice is consumed there. An error or an abort reported before that point leaves
the change pending, and the next user turn reports it again. Residual: an abort or a thrown error
after the last successful response, which the host reports through no later public event, can still
consume the notice; no public signal separates that window.

With delegation off and Advisor off by configuration, one notice says `Delegation and Advisor
disabled by this policy.` and nothing further is injected while both stay off. An Advisor left on but
unusable is not reported as disabled, because the configuration did not disable it. Every notice is
scoped to this extension and revokes no other instruction, permission, or authority. Session starts,
reloads, forks and tree navigation set the reference silently, so no notice appears at startup.
The extension writes no notice text to session history or its local log, so compaction summaries
and branches cannot inherit one from stored history. This does not limit the provider's or other
authorized host components' request retention. A prompt another extension sends with
`sendUserMessage` is not a user turn: it neither receives nor consumes the notice. The notice reports configuration, not availability: an unusable model keeps its value in the
list and the policy block that would assign it may simply be absent, so nothing in the notice
presents that model as usable. For new work, the notice points the model at the current valid
assignments and thinking rules in this policy rather than earlier settings in the conversation.

## ContextShunt

ContextShunt is a separate opt-in layer, off by default. `observe` records what enforcement would
block without changing a call or its result; `enforce` blocks only recognized declared excess and
compacts only a known textual result it has already preserved, so `context_shunt_recover` can return
one bounded line or byte range. Errors, structured results, images, binaries, mixed content, and
unknown tool contracts stay unchanged, and nothing is launched from a hook. The reader keys
`readerEnabled`, `readerRole`, and `answerMaxBytes` control the optional
`context_shunt_delegate`/`context_shunt_recover` pair, which needs `enforce`, an active delegation
intensity, a valid configuration, and a compatible external executor. The reader requires stable
`pi-subagents` SemVer `>=0.76.1`, with no upper bound, and the unchanged strict launch contract.
Older, prerelease, invalid or contract-incompatible builds fail closed with `reader-unavailable`.
The reader was verified with `0.76.1` on Pi `1.1.0`; Pi `0.87.1`, the declared minimum, is not
verified for the reader. Since `0.19.0`,
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
