---
title: Limits and privacy
description: Understand the product boundary, fail-closed behavior, local data, and safe reporting.
---

# Limits and privacy

## Product boundary

`pi-delegation-policy` requires Pi `0.87.1` or later and adds one policy block while an active
configuration is valid. Its public `context_with_system` hook refreshes only the marked block in the
system message before each LLM request, so a change made during a turn applies to the next request.
The final provider request re-applies the current marked block inside the recognized instruction
fields of the outgoing payload, so a host or another extension that replaces the system prompt
afterwards cannot drop it; a payload whose shape is not recognized is left untouched. Turning
delegation and Advisor off removes only that block. The host system message, tools, context, other
extension sections, and stored conversation are preserved.

The extension never launches children from hooks. Only explicit tools launch through the authorized
external executor: `context_shunt_delegate` for a preserved artifact, and `consult_advisor` in tool
mode. Default role mode leaves Advisor launches to the main agent. Neither replaces permissions,
backends, delegation, or Pi's main model or thinking. There is no network telemetry or direct network
client; the executor performs model calls. A content-free local log is described below.

### Launch check

While delegation is active, or while an Advisor is enabled, the extension checks a `subagent` call
before anything launches. It corrects the three cases that are unambiguous instead of refusing them
by default (the global row can still be set to `block`, which refuses every call it would otherwise
correct):

- a role name in place of a model (`small`, `medium`, `large`, `visual-design`, `ui-design`,
  `uidesign`, `advisor`, `advisor-1` to `advisor-3`, case-insensitive) becomes that role's exact
  provider/model with a level;
- a role's exact model with no `:LEVEL` gains one: the role's fixed level, the lowest supported level
  inside its range, or `medium` clamped to what the model supports when it has no policy;
- a child whose model is exactly one configured Advisor's runs with that Advisor's profile, whatever
  profile it named or omitted.

The correction is written into the call the host already validated, so it changes what executes; the
stored transcript keeps what the model sent. The extension then appends a note to that call's tool
result saying what it applied, so the agent sees the difference. Corrections apply per child and to a
shared top-level `model` once; a call whose children would resolve differently, or whose model fits
more than one role or Advisor, is refused instead of guessed.

Everything else is refused as before: a child with no model, a model that is not the exact model of
an enabled role, a thinking level or Advisor profile it cannot settle, or an Advisor profile with a
model that is not that Advisor's. Parallel tasks and chain steps are checked one by one, and one
invalid child refuses the whole call; a top-level `model` applies to children that state none.
Workflow scripts, inline, by path, by name or through `options.script`, are refused because their
models live in code the extension cannot read: launch one child, use `tasks` or `chain`, or
`workflow: "parallel"` with every model stated. Calls with `action` are management or control and
pass; `resume` keeps the child's original model. A child that will run with an Advisor profile is
refused if the call asks for `context: "fork"`, because an Advisor answers from the brief the
extension writes and never from your conversation. With delegation off and Advisor on, only Advisor
profile launches are checked, and scripts are not.

The refusal lists the accepted launches. The check applies to every `subagent` tool call in the
session, including ones other skills request: council mode, which uses a workflow script, is refused
while delegation is active. Slash commands, RPC and schedules created earlier do not pass through
this tool call and are not checked. The check sees only the call: it cannot decide whether work
should have been delegated. An invalid delegation configuration refuses new ordinary launches until
it is fixed; valid Advisors keep working.

A test mode refuses every corrected case instead, keeping the pre-correction behaviour for
measurement. It is the global **Launch correction** row in `/delegate`, stored in
`delegation-policy.launch-correction.json` next to the global defaults and described in the
[configuration reference](/configuration/#launch-correction-mode).

## Configuration change notice

An effective configuration change can add an ephemeral notice to the next user turn's request
context, in addition to the current policy. Turning both delegation and Advisor off has a
single exception to zero injection: one notice says they were disabled **by this policy**; subsequent
turns inject nothing while both stay off. This does not revoke authority from the user, host, or
another extension and does not itself cancel children or initiate a turn.

Pi converts the custom message to user-role text and drops its custom metadata. Its text identifies
it as an extension notice, not something the user wrote. The extension does not write notice text to
session history or its local log, so stored summaries and branches cannot inherit the notice. This
is not a promise about request retention by providers or other authorized host components.

The presented revision is consumed at final settlement when the last recorded assistant response
completed; a failed attempt followed by a successful retry counts as completed. A final reported
error, abort, or unknown outcome preserves the change for another user turn. Pi has no public signal
for an abort or exception after the last successful response and before final settlement: that
accepted window can still consume a notice. A newer, unpresented configuration change is not consumed
by the earlier response.

The Pi peer remains `>=0.87.1`. Notice hooks and conversion were verified against `0.87.1` public APIs
and a synthetic registered-hook harness, not a full host process or later hosts. The harness encodes
that host's `input` then `before_agent_start` order. No real-provider notice test, model-obedience
measurement or provider-cache measurement is claimed. [Configuration](/configuration/#configuration-change-notice)
lists the tracked settings.

## Advisor reminder

An automatic reminder, on by default, adds one short extension-owned line to the request context at
most once per operative task of each instance. It is armed by one successful builtin orientation
result (`read`, `find`, `grep`, `ls`) or by the same builtin tool failing in two different rounds, and
it is presented only while a valid Advisor is active, the task is live and the configured launch mode
has its launcher among the active tools. An attempted consultation ends it for that task even when it
fails; a control action that only names an Advisor is not a consultation.

The line lives in the request copy after the policy block and the configuration notice, never in the
conversation, and it starts no turn, child or consultation. It adds no authority and revokes no
instruction. It is sent to the provider, so it is not a promise about cost or retention, and it is
not a guarantee that a consultation happens: a presentation is not evidence of obedience, and it can
arrive after the first edit. It reacts only to the builtin tools above, never to shell text, stdout,
the user's words or a model's intent, and it is not a classifier of task complexity. Only the
documented `pi-subagents` process markers (`PI_SUBAGENT_CHILD=1`, `PI_SUBAGENT_RUNNER_PID`) exclude a
child; a `/fork` or `/clone` of a human session keeps the reminder, and a missing marker proves
nothing, so the approved scope also covers foreground children that load this policy and can consult.

The mode is stored in `delegation-policy.advisor-reminders.json`, schema 1 with `mode` (`off` or
`remind`). A missing file means `remind`; an unreadable or invalid one suspends only the reminder with
a diagnostic and never changes the delegation or Advisor axis, and the panel row then reads
`Unavailable/Suspended · global` instead of presenting the suspension as a choice. The extension writes no reminder text
to session history or its local log. [Configuration](/configuration/#advisor-reminder) describes the
row and the file.

## Fail-closed behavior

In `normal`, `aggressive`, or `orchestrator`, Small, Medium, and Large must each be an explicit model
reference or `disabled`, and at least one must be enabled. An absent ordinary role is **not
configured** and produces `D:ERR`, as does any enabled reference that is missing, unavailable, out of
scope, or unauthenticated, or no enabled ordinary role at all. A configured Visual Design reference is
validated too. When one of these is wrong, the ordinary-role minimum is not met and delegation fails
closed; the ContextShunt reader is unauthorized until the configuration is corrected.

Delegation and Advisor are validated separately. An enabled Advisor whose model, scope or
authentication is wrong produces `A:ERR` when none is valid (`A:PART` when only some are valid),
leaving
valid delegation and an otherwise authorized reader available; invalid delegation does not suppress a
valid enabled Advisor. With Advisor off, an unusable Advisor state is reported as a diagnostic while
the footer keeps `A:OFF`. See
[errors by axis](/configuration/#errors-by-axis).

A configured thinking policy is validated locally against that role's resolved model. A well-formed
level the model does not support is a `D:ERR` cause and injects no policy, and the diagnostic names
the role, the level, and the model. A malformed `thinking` entry is a document error rather than
`D:ERR`: it invalidates the whole document, so global defaults fall back to empty defaults and a
branch falls back to `off` with a sanitized notice. A policy set for a disabled or unconfigured role
is stored and inert and adds no error.

If the latest stored session entry is malformed or from a newer schema, restoration forces both
delegation and Advisor off and keeps only a sanitized warning. Changes affect the next LLM request,
not one already in progress. Role subagents remain host-owned; detected tool authorization changes
cancel the extension-owned group.

## Local data and privacy

The extension stores intensity, preference, Advisor mode, explicit disabled markers, provider/model
identifiers, the optional ContextShunt configuration, and each role's thinking policy in local
global defaults and Pi session entries. It never stores credentials, prompts, panel catalog metadata,
or the thinking level chosen for an individual run. It sends no telemetry and makes no network
request of its own.

Review local configuration before sharing diagnostics: model identifiers and provider names can
reveal information about your environment. Remove credentials, prompts, personal paths, session
files, and unredacted logs from anything you publish.

## Advisor role

Advisor has no model by default and stays outside the ordinary-role minimum. Its entries, launch mode,
and mode are configured in [configuration](/configuration/#advisor). This section states only what a
consultation sends and retains. The packaged no-tools/no-extensions
`pi-delegation-policy.advisor` profile advises and executes nothing.

In `role` mode the main agent launches each valid advisor and the extension only observes matching
attempts. In `tool` mode the always-registered `consult_advisor({ question, brief?, evidence? })`
launches one child per valid advisor through the public `pi-subagents` delegation API. It requires
stable SemVer `>=0.76.1`, with no upper bound, and it rejects prereleases and invalid versions. Every
launch must still pass the strict contract and terminal-binding checks, or it returns unavailable text.
No model, provider or executor fallback is added.

Every consultation runs in fresh context: the request carries the question and a short self-contained
`brief` — objective and constraints, relevant facts, options and proposal, uncertainty — and the
extension never adds the conversation. A first consultation in a thread requires that brief; a later
call in the same task sends only the new question and evidence. A call that asks for
`context: "fork"` — on the child, in the call's `options` or at the top level — is refused when an
Advisor is involved. One residual stays outside the extension's reach: a default such as
`defaultSubagentContext: "fork"` lives in the `pi-subagents` configuration, which the extension does
not read, so check it if this matters to you. The Advisor therefore sees only what you write in the
brief, so a thin brief weakens the advice.

One pending call per tool: an advisor group launches one child per configured valid advisor, while the
independent reader can run alongside it (at most four children). Abort, branch change, shutdown and
detected authorization changes cancel the tool group. Partial results preserve a successful answer.
Local timeouts and cancellation do not cap external generation, retries or cost.

### Optional provider extension

The separate `pi-delegation-policy.advisor-anthropic-auth` profile can load the exact managed-user
`@gotgenes/pi-anthropic-auth` 3.4.3, 3.4.4 or 3.6.0 installation after a per-Advisor opt-in. It
preserves that extension's normal configuration, startup hook, provider aliases and account diagnostic
command. Trusted host code can access its normal authentication and files even though the model has no
tools. The diagnostic can query account information only when explicitly invoked and is never run by
initialization or availability probes. This is not a sandbox or a metadata-only extension.

Only the verified absolute entry is loaded, and other configured extensions are not inherited. Missing
APIs, a package or entry mismatch, or an initialization error leaves the dispatch guard closed without
choosing builtin transport. The check does not sign code or eliminate a resolution-to-load race.
[Configuration](/configuration/#provider-extension) lists the supported installations and why a
downgrade to `0.22.2` silences all Advisors when an opt-in is saved.

An [admitted provider extension](/configuration/#admitted-provider-extensions) works the same way for
any other provider, with a weaker check: only its installed identity and listed user source are
verified before it runs, not its exact surface. Once loaded it is trusted host code with your files,
network and its own accounts. Withdrawing its provider after a failed check does not undo its side
effects, and the admission applies to every session.

### Local content-free log

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
`/delegate status` reads this log back, and only this log: it tails the current file and its rotated
predecessor, bounded to the last 4 MiB of each, and reports allowed launches per role plus a refusal
count. The tail can cut a line, which is skipped, so the report may undercount and never invents a
record; a missing or unreadable log reports `launches=none recorded`. Reading it changes no file and
touches no launch.

No network telemetry is sent; model identifiers can still be sensitive.

The writer serializes within one process, not across processes; concurrent sessions share no lock.
Role observations cover exact packaged agent targets, including tasks arrays, not arbitrary workflows.
Preflight binds the tool session identity; the public request API cannot prove that the live executor
uses the same session. Terminal mismatch can reject an answer only after context exposure. This
check validates a declared contract, not a sandbox or an executor signature.

### Retention

Questions, briefs and replies can persist in executor argv, temporary files,
sessions, lifecycle records and at each provider. No deletion, external TTL or absence of cost is
promised. Turn Advisor off when session content must not reach those providers. Local log rotation
is not an external retention policy.

## ContextShunt limits

ContextShunt starts `off`. In that mode its hooks return immediately without classification, metrics,
artifact I/O, or changes. `observe` simulates the same admitted-request window as enforcement but
returns the original call and result. `enforce` consults Pi's public `getAllTools()` provenance and
blocks only built-in known declared oversized ranges: native `read`, and a deliberately narrow
`Get-Content`/`gc` form with `-TotalCount` or `-First` accepted on the `bash` and `powershell` tools.
Declared limits count lines only,
and rejected calls do not consume or renew the shared tool-and-declared-path window. Same-named SDK or
extension tools remain unchanged; observe may report those names only as non-binding heuristics.
Composite commands, redirects, pipes, unbounded shell reads, user `!` commands, and unknown or
replaced tool contracts are not rewritten or preblocked.

After an authorized tool runs, enforcement considers only one-block successful text results from
recognized `read`, `bash`, `powershell`, or `grep` contracts. It counts UTF-8 bytes and LF, CRLF, or CR
lines from the returned text, then preserves the original before returning a compact message. A valid
`read` offset is 1-indexed; invalid offsets stay with the original tool. Errors, valid JSON text of
every root type, images, binaries, mixed blocks, and unrecognized contracts remain intact. Preservation
failures, quota exhaustion, and cancellation leave the original result intact, and commands are never
run again.

Artifacts have opaque random IDs and live in a private process temporary directory, capped at eight
artifacts and 512 KiB per session. Each artifact expires 30 minutes after creation; scheduled cleanup
runs while the process is active, recovery does not renew the expiry, and shutdown cancels cleanup and
removes the temporary directory. A crash or operating-system suspension can delay cleanup until the
process resumes or the OS removes its temporary data, so this is not a guarantee of deletion after the
process stops. Recovery accepts exactly one bounded line or byte range, and neither status nor metrics
expose source paths or corpus.

These bounds are not a sandbox, an access-control system, or protection against every prompt-injection
or output route.

An oversized recognized call can be narrowed or granted once only through an explicit user command
tied to the matching input, tool call, requested range, and a one-minute expiry. The line limit
applies to the declared range and the byte limit to the real returned result. At most eight consumed
authorizations are retained; an evicted, changed, expired, cancelled, agent-ended, branch-changed, or
terminal result uses the ordinary post-result limits. Pending user-authorized tokens survive a normal
agent end until their expiry. This fixed safety bound has no configuration setting, and content from a
model cannot create an exception. Nothing starts the reader from a hook: it runs only when the agent
explicitly calls `context_shunt_delegate`.

## ContextShunt reader

The inline reader is opt-in and off by default: `contextShunt.readerEnabled` resolves to `false`. A
call is authorized only with an effective mode of `enforce`, an active delegation intensity, a valid
configuration, and the ordinary role named by `contextShunt.readerRole` enabled with an available
model. In any other state `context_shunt_delegate` returns a bounded error and no answer, and nothing
is launched.

The launch uses the packaged profile `agents/pi-delegation-policy.context-shunt-inline-reader.md`: fresh
context, empty `tools:` and `extensions:`, a replace prompt, no project resources, and the internal
`structured_output` tool as its only surface. It analyzes the supplied snapshot and cites only the
ranges it was given. It cannot read files, run commands, delegate, or see the conversation.
`context_shunt_delegate` launches it through the external executor, and nothing launches it from a
hook. The package also ships the guided `pi-delegation-policy.bulk-reader` profile for discovery by a
compatible executor. This extension never installs it into user agent directories and never launches
it.

Input is validated before anything is launched:

- `artifactId` — the opaque ID of a live preserved artifact.
- `question` — required, not empty, at most 2048 UTF-8 bytes.
- `thinking` — required; one level the reader role's resolved model supports.

The answer comes only from the preserved snapshot of that one artifact. It carries a status, a short
answer, and at most 16 citations to exact line ranges of that snapshot. `answered` requires at least
one citation, and `insufficient-evidence` carries none. A citation to another source, an out-of-range
or repeated range, a blank answer, or any other JSON shape is rejected as `invalid-answer` and never
reaches the agent.

The serialized tool result — answer, citations, and envelope — stays within `contextShunt.answerMaxBytes`
(1024 to 16384, 8192 by default). A validated answer over that cap is preserved as a separate artifact
and returned as a receipt carrying its ID, which `context_shunt_recover` reads back with one bounded
line range (`lineOffset`, `lineLimit`) or byte range (`byteOffset`, `maxBytes`). The extension does not
truncate JSON or citations and never returns a raw executor response. If the answer cannot be
preserved, the result is `output-unavailable` and the source artifact stays as it was.

Failures use bounded codes that carry no paths, content, or secrets:

| Code                 | Meaning                                                                                                                           |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `invalid-request`    | The input is missing, empty, over a cap, or uses a level the reader role's model does not support.                                |
| `evidence-expired`   | The preserved source is gone, so no answer is returned without recoverable evidence.                                              |
| `invalid-answer`     | The reader result failed the approved contract, the source ID, the line ranges, or the citation cardinality.                      |
| `output-unavailable` | The call is not authorized, or the validated answer cannot be preserved within the cap.                                           |
| `reader-unavailable` | The external executor is absent, below the stable SemVer minimum, or contract-incompatible.                                       |
| `reader-busy`        | Another `context_shunt_delegate` call is in flight.                                                                               |
| `reader-cancelled`   | The request was revoked by a branch change, by applying or discarding a panel draft, by `off` or `reset`, or by session shutdown. |
| `reader-timed-out`   | The request used its whole local time budget.                                                                                     |
| `reader-failed`      | The executor failed, or its launch contract did not match.                                                                        |

One `context_shunt_delegate` request may be in flight at a time.

### What one request sends

The reader task carries the preserved snapshot text, its opaque source ID, its line count, and the
question. It carries no conversation, no other tool call or result, and no other artifact. The launch
payload that the external executor receives also carries the working directory, the reader profile's
name, the model and the thinking level for that call, and opaque request, run, and node identifiers
that correlate the launch with its result. The snapshot is sent during the preflight that resolves the
launch contract as well, before any launch.

Both the snapshot and the answer are untrusted data rather than instructions. The extension never
follows text inside them and never executes it.

The reader requires stable `pi-subagents` SemVer `>=0.76.1`, with no upper bound. Prereleases,
invalid versions and older builds, including `0.69.0`, return `reader-unavailable` before REQUEST.
Every launch must still pass the unchanged strict contract checks: the version floor does not
promise future-build compatibility. The reader was verified with `0.76.1` on Pi `1.1.0`;
Pi `0.87.1`, the declared minimum, is not verified for the reader. There is no fallback model,
provider, or retry.

The reader also accepts the host's permission runtime described below. Builds up to `0.18.0` reject
any extra runtime, so with host permission rules their reader returns `reader-unavailable`.

The contract check accepts a child that loads only the packaged prompt runtime. It also accepts that
runtime followed by the exact `@gotgenes/pi-permission-system` `33.0.3` entry, which the host adds when
it has permission rules. Any other extension, another version, a reordered or duplicated list, or a
child that inherits global context fails the check. If the permission package is not installed, the
reader uses the prompt-only launch. If the host adds a permission entry whose package, version, or
manifest does not verify, the check rejects it.

The host owns its permission rules. The reader never reads, copies, normalizes, or changes them, and
it never grants itself an exception. A default `ask` decision can block a headless child that has no
authorizer; the reader then fails closed and does not fall back to another model, provider, or launch.
In isolated synthetic runs, a child that the host allows only for structured output completes. When the
host asks or denies that output, the reader fails closed, with no accepted answer and no second
delegation request. An `ask` decision can make two model calls inside that one request. Neither the
reader nor the request sets a ceiling on generation, retries, or cost, and the local timeout does not
limit them.

The host may append its own tool-surface block to the child's system prompt. In those synthetic runs
the block held exactly Pi's two universal guidelines, and the child prompt gained no project context,
skills, resources, or source text. The working directory in that prompt comes from host metadata,
not from the tool's model-supplied arguments. The child model can call only `structured_output`,
and the host may remove or deny that tool.

This is an exact compatibility check for one verified runtime, not a support guarantee for the host.
The verified combination is `pi-subagents` `0.76.1` on Pi `1.1.0`, with a synthetic loopback provider. A
real provider, personal permission rules, and Pi `0.87.1` were not tested with this reader. The runtime
the host loads is trusted host code, not authority granted to the model. Version labels and digests are
not signatures: the digests check only their format. The preflight is bound to the session of the tool's
context. The public API does not show that the launch request runs in that same session, so a mismatched
terminal digest rejects the answer only after the snapshot has been sent. The check confirms the contract
the executor declares, not the executor's code.

### Retention

The preserved snapshot and the answer may persist in the executor's argv, temporary files, sessions,
and lifecycle records, and at the model provider. The project promises no deletion, no external TTL,
and no absence of cost. A failed reader call leaves no answer artifact.

## Panel and status limits

The panel shows a compact preview, one row per setting, and a hint block with the focused row's
explanation and sources. Model selection presents the model ID first and `[provider]` last, and can
show transient public metadata that the extension never persists.

`/delegate status` shows exact effective references and provenance (`default`, `global`, or
`session`), one `thinking-<role>` token per role, and sanitized diagnostics. `D:NORM`, `D:AGG`, and
`D:ORCH` mean local validation passed; they do not prove that a delegated launch occurred or that
another system followed the guidance.

## Reporting vulnerabilities

For an undisclosed vulnerability, use [GitHub's vulnerability reporting page](https://github.com/Yivas/pi-delegation-policy/security/advisories/new); do not open a public issue. Include the affected version or commit,
operating system, Pi version, reproduction steps, expected behavior, observed behavior, and a minimal
sanitized configuration. For ordinary changes, read the
[contribution guide](https://github.com/Yivas/pi-delegation-policy/blob/main/CONTRIBUTING.md).

## More information

- [Getting started](/getting-started/) installs and configures the extension.
- [Configuration](/configuration/) defines policy values and inheritance.
- [Commands and status](/commands-and-status/) explains operation and diagnostics.
- [Source repository](https://github.com/Yivas/pi-delegation-policy)
- [Package on npm](https://www.npmjs.com/package/pi-delegation-policy)
