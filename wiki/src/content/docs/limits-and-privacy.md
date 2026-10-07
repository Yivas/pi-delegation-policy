---
title: Limits and privacy
description: Understand the product boundary, fail-closed behavior, local data, and safe reporting.
---

> **Development version:** independent Advisor mode and its companion file are not included in npm `0.16.0`.
> Existing configurations keep Advisor tied to delegation until `on` is selected explicitly.

## Product boundary

`pi-delegation-policy` requires Pi `0.87.1` or later and adds one policy block while an active
configuration is valid. Its public `context_with_system` hook refreshes only the marked block in the
system message before each LLM request, so a change made during a turn applies to the next request.
The final provider request re-applies the current marked block inside the recognized instruction
fields of the outgoing payload, so a host or another extension that replaces the system prompt
afterwards cannot drop it; a payload whose shape is not recognized is left untouched. Turning
delegation and Advisor off removes only that block. The host system message, tools, context, other
extension sections, and conversation are preserved.

The extension does not route, supervise, or collect delegated work, and it never launches anything
from a hook. Its only launch belongs to one explicit tool, `context_shunt_delegate`, which asks the
host-authorized external executor for one bounded answer about an already-preserved text artifact.
The optional Advisor is a role the main agent launches as a subagent, not a launch of this extension.
Neither replaces delegation, the launcher, tool permissions, or a remote backend, and neither changes
Pi's main model or thinking level.

It has no presets, project configuration, external skill loading, telemetry, credential storage, or
network request of its own; the external executor performs the reader call, and the host's subagent
mechanism performs the Advisor launch. The extension cannot make another system follow a configured
role or thinking choice.

## Fail-closed behavior

In `normal`, `aggressive`, or `orchestrator`, Small, Medium, and Large must each be an explicit model
reference or `disabled`, and at least one must be enabled. An absent ordinary role is **not
configured** and produces `D:ERR`, as does any enabled reference that is missing, unavailable, out of
scope, or unauthenticated, or no enabled ordinary role at all. A configured Visual Design reference is
validated too. When one of these is wrong, the ordinary-role minimum is not met and delegation fails
closed; the ContextShunt reader is unauthorized until the configuration is corrected.

Delegation and Advisor are validated separately. An enabled Advisor whose model, scope,
authentication, or thinking level is wrong produces `A:ERR` and removes only consultation, leaving
valid delegation and an otherwise authorized reader available; invalid delegation does not suppress a
valid enabled Advisor. With Advisor off, an unusable Advisor state is reported as a diagnostic while
the footer keeps `A:OFF`. See
[errors by axis](/pi-delegation-policy/configuration/#errors-by-axis).

A configured thinking policy is validated locally against that role's resolved model. A well-formed
level the model does not support is a `D:ERR` cause and injects no policy, and the diagnostic names
the role, the level, and the model. A malformed `thinking` entry is a document error rather than
`D:ERR`: it invalidates the whole document, so global defaults fall back to empty defaults and a
branch falls back to `off` with a sanitized notice. A policy set for a disabled or unconfigured role
is stored and inert and adds no error.

If the latest stored session entry is malformed or from a newer schema, restoration forces both
delegation and Advisor off and keeps only a sanitized warning. Changes affect the next LLM request,
not one already in progress, and never cancel a subagent the host already launched.

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

The Advisor is a role, not a tool. It is off by default, and the extension registers nothing for it:
no tool, no executor, no in-flight counter, no lifecycle cleanup. When the role is enabled, configured
and valid, the injected policy favors a brief consultation while the main agent shapes or reconsiders
a substantive choice and tells it to launch `pi-delegation-policy.advisor`, the profile that ships in
this package, as a normal subagent through Pi's subagent mechanism, with the exact configured model
and its `thinking.advisor` policy. That launch belongs to the host, not to this extension.

The profile declares no tools and no extensions. It cannot read files, run commands, delegate, or
reach the network; it sees the task text that arrives with it and returns plain text. Because it sees
nothing else, the brief has to be self-sufficient: it puts the objective, the constraints, the facts,
and the open choice first, with the agent's proposal and reasons after if there is one. The agent asks
for an approach, criteria, or critical assumptions rather than approval or a forced list of defects.
The advisor is a conversation rather than a single answer, and continuing the thread through the
host's resume mechanism is what lets the main agent clarify, challenge, or go deeper. The advice is
reused while the decision holds instead of reopening on every turn.

Consulting the advisor is a deliberate exception to what stays local. What travels to the advisor's
model is what the main agent writes into the task, through the host-authorized external executor. The
extension assembles no conversation window and sends nothing on its own initiative; nothing in the
policy bounds that text, and there is no aggregate cap and no exclusion list. The extension keeps no
advisor thread: the subagent session belongs to the host, and the advisor's provider is the executor's
provider.

### Retention

The task text and the reply may persist in the executor's argv, temporary files, sessions, and
lifecycle records, and at the model provider. The project promises no deletion, no external TTL, and
no absence of cost. Consultations can add latency and cost even with delegation off.

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

The reader needs a compatible external executor. Protocol version `0.69.0` is the verified one; a
different executor build fails the contract check and returns `reader-unavailable`, with no answer and
no fallback model, provider, or retry.

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

Use GitHub's [private vulnerability reporting](https://github.com/Yivas/pi-delegation-policy/security/policy)
for an undisclosed vulnerability; do not open a public issue. Include the affected version or commit,
operating system, Pi version, reproduction steps, expected behavior, observed behavior, and a minimal
sanitized configuration. For ordinary changes, read the
[contribution guide](https://github.com/Yivas/pi-delegation-policy/blob/main/CONTRIBUTING.md).

## More information

- [Getting started](/pi-delegation-policy/getting-started/) installs and configures the extension.
- [Configuration](/pi-delegation-policy/configuration/) defines policy values and inheritance.
- [Commands and status](/pi-delegation-policy/commands-and-status/) explains operation and diagnostics.
- [Source repository](https://github.com/Yivas/pi-delegation-policy)
- [Package on npm](https://www.npmjs.com/package/pi-delegation-policy)
