---
title: Limits and privacy
description: Understand the product boundary, fail-closed behavior, local data, and safe reporting.
---

# Limits and privacy

> Independent Advisor mode and its companion file are available from version `0.17.0`.
> Existing configurations keep Advisor tied to delegation until `on` is selected explicitly.

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

## Configuration change notice

From `0.22.0`, an effective configuration change can add an ephemeral notice to the next user turn's
request context, in addition to the current policy. Turning both delegation and Advisor off has a
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

## Fail-closed behavior

In `normal`, `aggressive`, or `orchestrator`, Small, Medium, and Large must each be an explicit model
reference or `disabled`, and at least one must be enabled. An absent ordinary role is **not
configured** and produces `D:ERR`, as does any enabled reference that is missing, unavailable, out of
scope, or unauthenticated, or no enabled ordinary role at all. A configured Visual Design reference is
validated too. When one of these is wrong, the ordinary-role minimum is not met and delegation fails
closed; the ContextShunt reader is unauthorized until the configuration is corrected.

Delegation and Advisor are validated separately. An enabled Advisor whose model, scope,
authentication, or thinking level is wrong produces `A:ERR` when none is valid (`A:PART` when one
of two is valid), leaving
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

Advisor is optional, off by default, and outside the ordinary-role minimum. Configure **Advisor 1**
and optional **Advisor 2**, each with an exact model and thinking policy. Every valid advisor gets the
same question. Weigh disagreements; agreement is not proof. The packaged no-tools/no-extensions
`pi-delegation-policy.advisor` profile advises and executes nothing.

**Advisor launch** inherits globally or per branch, defaulting to `role`:

- `role`: the main agent launches every valid advisor in one background subagent call, with exact
  models and thinking. The extension observes matching attempts but does not launch them.
- `tool`: the always-registered `consult_advisor({ question, brief? })` launches one child per valid
  advisor in parallel through the public `pi-subagents` delegation API, admitted only for the exact
  builds whose launch contract was verified (`0.76.1` and `0.83.1`). Otherwise it returns unavailable
  text. No model, provider or executor fallback is added.

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

### Local content-free log

Records are written only while a policy block is active; both delegation and Advisor off produce no events.
Content-free events go to `~/.pi/agent/delegation-policy.events.jsonl` (or Pi's configured agent dir):
time, extension version, SHA-256 policy-block hash when it changes, intensity, Advisor modes, context
and count; consultation model IDs, status, context and duration. Role observations are attempts, not
proof of completion; duration zero means unknown. Questions, briefs, answers, conversations, project
paths and raw errors are excluded. Writes are serialized, rotate at 256 KiB to one `.1` backup, and
failures never break a request. Shutdown drains queued writes for at most five seconds, then drops
remaining work. An in-flight filesystem operation may finish later, but starts no further operation.
No network telemetry is sent; model identifiers can still be sensitive.

The writer serializes within one process, not across processes; concurrent sessions share no lock.
Role observations cover exact packaged agent targets, including tasks arrays, not arbitrary workflows.
Preflight binds the tool session identity; the public request API cannot prove that the live executor
uses the same session. Terminal mismatch can reject an answer only after context exposure. This
check validates a declared contract, not a sandbox or an executor signature.

### Retention

Questions, briefs, forked conversation and replies can persist in executor argv, temporary files,
sessions, lifecycle records and at each provider. No deletion, external TTL or absence of cost is
promised. Turn Advisor off when session content must not reach those providers. Local log rotation
is not an external retention policy.

## ContextShunt limits

ContextShunt starts `off`. In that mode its hooks return immediately without classification, metrics,
artifact I/O, or changes. `observe` simulates the same admitted-request window as enforcement but
returns the original call and result. `enforce` consults Pi's public `getAllTools()` provenance and
blocks only built-in known declared oversized ranges: native `read` and a deliberately narrow
PowerShell `Get-Content`/`gc` form with `-TotalCount` or `-First`. Declared limits count lines only,
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

The package declares the profile `agents/pi-delegation-policy.bulk-reader.md` so a compatible
executor can discover it by path. It allows only `read`, `grep`, `find`, and `ls`; it is a guided
read-only contract rather than an isolation boundary, and the extension never installs it into user
agent directories nor launches it by itself.

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
| `reader-unavailable` | The external executor is absent, or its build does not match the pinned protocol.                                                 |
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

The reader needs a compatible external executor. The only verified one is `pi-subagents` `0.76.1` on Pi
`1.1.0`; Pi `0.87.1`, the declared minimum, is not verified for the reader. A different executor build,
including `0.69.0`, fails the contract check and returns `reader-unavailable`, with no answer and no
fallback model, provider, or retry.

From `0.19.0`, the reader also accepts the host's permission runtime described below. Version
`0.18.0` and earlier reject any extra runtime, so with host permission rules their reader returns
`reader-unavailable`.

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
