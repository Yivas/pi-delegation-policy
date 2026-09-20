---
title: Limits and privacy
description: Understand the product boundary, fail-closed behavior, local data, and safe reporting.
---

## Product boundary

`pi-delegation-policy` guides the main agent by adding one policy block through Pi's public `before_agent_start` event when an active configuration is valid. It does not route, supervise, or accept subagent results, and it never launches anything from a hook. Its only launches belong to two explicit tools that ask the host-authorized external executor for one bounded answer: `context_shunt_delegate` for one question about an already-preserved text artifact, and `advisor_ask` for one piece of advice. Neither replaces delegation, the launcher, tool permissions, or a remote backend. It does not change Pi's main model or thinking level.

The policy evaluates task fit before preference from demand, difficulty, quantity, risk, and error and review cost. In published `0.9.0` `orchestrator`, the main agent must delegate all transferable execution before it begins whenever an enabled capable role and authorized launcher are available, regardless of size: small lookups, code reading, detailed planning, implementation, testing, writing, detailed review, and integration mechanics. Bootstrap is only mandatory instructions, tool discovery, and narrow assignment scope. It must not take over or duplicate pending work; it coordinates only disjoint work, waits through the host, and consumes results before dependent work or finalizing. The main agent retains critical decisions, coordination, safety, evidence evaluation, final acceptance, and concise synthesis, not permission to perform transferable review or integration. It reinspects only a concrete gap, risk, or contradiction and delegates transferable fixes or rechecks. Direct execution requires a briefly stated concrete exception: genuinely non-transferable work, no enabled capable role, a confirmed unavailable authorized launcher, or an explicit user or higher-priority requirement. A final-review or integration label, size, triviality, convenience, economics, transfer cost, or familiarity is not an exception. Published `0.7.0` retains its original policy. It considers only enabled ordinary roles, chooses the least costly enabled role that can satisfy task acceptance and evidence, and keeps work with the main agent when none can. `efficient` and `intensive` break credible Small/Medium ties only while both are enabled; `standard` adds no extra bias.

Thinking has three per-role states and one default. With no configured policy, the main agent chooses the level for each launch instead of inheriting an ambient subagent default. A configured fixed level or inclusive range is binding guidance for that role, and the extension checks locally that the level belongs to the role's resolved model. None of this can make another system follow the guidance.

For every delegated launch, the policy names the selected exact `provider/model` base and that role's thinking policy. `pi-subagents` uses `model: "provider/model:LEVEL"`, with a fixed policy shown as its literal level; another launcher may expose a separate field. The extension never supplies a model fallback or enforces that another system follows the guidance.

It has no presets, project configuration, external skill loading, telemetry, credential storage, or network request of its own; the external executor performs the advisor and reader calls. It is not a subagent runner and cannot make another system perform delegation. ContextShunt is its separate, opt-in protection layer; it uses only Pi's public tool hooks and does not replace tools, permission checks, remote backends, or an executor.

Visual Design is an optional specialist for a bounded presentation patch only when behavior and data contracts remain unchanged, the surface is identifiable, and visual quality or user experience is the primary acceptance criterion. It may edit scoped presentation code and assets and run relevant existing checks. When configured, the main agent evaluates those four conditions before ordinary-role selection for every task or phase. If an eligible visual portion is being delegated by the main agent's decision or the active intensity requires delegation, Visual Design takes priority over Small, Medium, and Large; it is reevaluated when the task or phase changes. The priority does not force delegation in `normal` or `aggressive`. In published `0.7.0` and `normal` or `aggressive`, the main agent retains cross-system integration and final acceptance. In published `0.9.0` `orchestrator`, it retains integration responsibility, coordination, and final acceptance while a capable ordinary role performs transferable integration mechanics and detailed review unless a named direct-work exception applies. Visual Design does not own product behavior, logic, data, APIs, routes, architecture, tooling, interaction, semantic or behavioral accessibility, test infrastructure, or integration mechanics.

## ContextShunt limits

ContextShunt starts `off`. In that mode its hooks return immediately without classification, metrics, artifact I/O, or changes. `observe` simulates the same admitted-request window as enforcement but returns the original call and result. `enforce` consults Pi's public `getAllTools()` provenance and blocks only built-in known declared oversized ranges: native `read` and a deliberately narrow PowerShell `Get-Content`/`gc` form with `-TotalCount` or `-First`. Declared limits count lines only; rejected calls do not consume or renew the shared tool-and-declared-path window. Same-named SDK or extension tools remain unchanged; observe may report them only as non-binding heuristics. Composite commands, redirects, pipes, unbounded shell reads, user `!` commands, and unknown or replaced tool contracts are not rewritten or preblocked.

After an authorized tool runs, enforcement considers only one-block successful text results from recognized `read`, `bash`, `powershell`, or `grep` contracts. It counts UTF-8 bytes and LF, CRLF, or CR lines from the returned text, then preserves the original before returning a compact message. A valid `read` offset is 1-indexed; invalid offsets stay with the original tool. Errors, valid JSON text of every root type, images, binaries, mixed blocks, and unrecognized contracts remain intact. Preservation failures, quota exhaustion, and cancellation leave the original result intact; commands are never run again.

Artifacts have opaque random IDs and live in a private process temporary directory, capped at eight artifacts and 512 KiB per session. Each artifact expires 30 minutes after creation; scheduled cleanup runs while the process is active, recovery does not renew the expiry, and shutdown cancels cleanup and removes the temporary directory. A crash or operating-system suspension can delay cleanup until the process resumes or the OS removes its temporary data, so this is not a guarantee of deletion after the process stops. Recovery accepts exactly one bounded line or byte range. It does not expose source paths or corpus in status or metrics. These bounds are not a sandbox, an access-control system, or protection against every prompt-injection or output route.

An oversized recognized call can be narrowed or granted once only through an explicit user command tied to the matching input, tool call, requested range, and a one-minute expiry. The line limit applies to the declared range and the byte limit to the real returned result. At most eight consumed authorizations are retained; an evicted, changed, expired, cancelled, agent-ended, branch-changed, or terminal result uses the ordinary post-result limits. Pending user-authorized tokens survive a normal agent end until their expiry. This fixed safety bound has no configuration setting. Content from a model cannot create an exception. Nothing starts the reader from a hook: it runs only when the agent explicitly calls `context_shunt_delegate`. The package ships a profile limited to `read`, `grep`, `find`, and `ls`, but only an executor that can load the package asset by path can enforce that profile. This package does not copy it into user directories, disable extensions, or claim isolation it cannot verify.

## ContextShunt reader

The inline reader is opt-in and off by default: `contextShunt.readerEnabled` resolves to `false`. A call is authorized only with an effective mode of `enforce`, an active delegation intensity, a valid configuration, and the ordinary role named by `contextShunt.readerRole` enabled with an available model. In any other state `context_shunt_delegate` returns a bounded error and no answer, and nothing is launched.

Input is validated before anything is launched:

- `artifactId` — the opaque ID of a live preserved artifact.
- `question` — required, not empty, at most 2048 UTF-8 bytes.
- `thinking` — required; one level the reader role's resolved model supports.

The answer comes only from the preserved snapshot of that one artifact. It carries a status, a short answer, and at most 16 citations to exact line ranges of that snapshot. `answered` requires at least one citation, and `insufficient-evidence` carries none. A citation to another source, an out-of-range or repeated range, a blank answer, or any other JSON shape is rejected as `invalid-answer` and never reaches the agent.

The serialized tool result — answer, citations, and envelope — stays within `contextShunt.answerMaxBytes` (1024 to 16384, 8192 by default). A validated answer over that cap is preserved as a separate artifact and returned as a receipt carrying its ID, which `context_shunt_recover` reads back with one bounded line range (`lineOffset`, `lineLimit`) or byte range (`byteOffset`, `maxBytes`). The extension does not truncate JSON or citations and never returns a raw executor response. If the answer cannot be preserved, the result is `output-unavailable` and the source artifact stays as it was.

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

One `context_shunt_delegate` request may be in flight at a time, independently of `advisor_ask`.

### What one request sends

The reader task carries the preserved snapshot text, its opaque source ID, its line count, and the question. It carries no conversation, no other tool call or result, and no other artifact. The launch payload that the external executor receives also carries the working directory, the reader profile's name, the model and the thinking level for that call, and opaque request, run, and node identifiers that correlate the launch with its result. The snapshot is sent during the preflight that resolves the launch contract as well, before any launch.

Both the snapshot and the answer are untrusted data rather than instructions. The extension never follows text inside them and never executes it.

The reader needs a compatible external executor. Protocol version `0.69.0` is the verified one; a different executor build fails the contract check and returns `reader-unavailable`, with no answer and no fallback model, provider, or retry.

### Retention

The preserved snapshot and the answer may persist in the executor's argv, temporary files, sessions, and lifecycle records, and at the model provider. The project promises no deletion, no external TTL, and no absence of cost. A failed reader call leaves no answer artifact.

## Advisor limits

`advisor_ask` is the only way to consult the advisor. It is registered always, and availability is decided when it is called: with no advisor configured, with delegation `off`, with a configuration that produces `D:ERR`, or with a model that is not available, it returns `advisor-unavailable` and the agent continues. It is never invoked from a hook, and the advisor cannot read files, run commands, or delegate.

Input, validated before anything is launched:

- `question` — required, not empty, at most 2048 UTF-8 bytes.
- `context` — optional, at most 4096 UTF-8 bytes, written by the main agent.
- `thinking` — required; one level the advisor's resolved model supports and inside the configured `thinking.advisor` policy. A fixed policy is binding, so another level is rejected.

The answer is plain text, at most 8192 UTF-8 bytes, returned with the model and the level that produced it. An answer over the cap, or a blank one, becomes a bounded error; the extension writes no artifact, temporary file, or recovery surface for advice.

Failures use six bounded codes that carry no paths, content, or secrets:

| Code                      | Meaning                                                                                                                           |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `advisor-unavailable`     | No advisor is configured, delegation is `off`, the configuration is invalid, or the advisor model is not available.               |
| `advisor-invalid-request` | The input is empty, over a cap, uses a level the model or policy does not allow, or the bounded request cannot be assembled.      |
| `advisor-busy`            | Another `advisor_ask` call is already in flight.                                                                                  |
| `advisor-failed`          | The executor failed, the launch contract did not match, or the advice exceeded its cap.                                           |
| `advisor-timed-out`       | The request used its whole local time budget.                                                                                     |
| `advisor-cancelled`       | The request was revoked by a branch change, by applying or discarding a panel draft, by `off` or `reset`, or by session shutdown. |

One request per explicit tool may be in flight at a time. A busy `advisor_ask` neither cancels nor disturbs a ContextShunt reader request already in flight, and the reverse holds too.

The advisor's plain-text path has been exercised end to end in a real session against a configured provider: two sequential questions reached the advisor through the external executor and the approved profile, the second one repeating a six-digit number chosen in the first, which shows the rebuilt thread carries the conversation, and a pair of parallel calls was refused with `advisor-busy`. It still has no packed matrix coverage, so outside those runs its launch contract is checked against a simulated preflight rather than a real executor response. The package pins protocol version `0.69.0`, so a different executor build fails the preflight and `advisor_ask` reports `advisor-unavailable`, with no advice and no partial output.

### What one request contains

The request is the question, the extra context, the advisor thread rebuilt from the session history (at most the six newest exchanges), and a bounded window of the current conversation. The four parts share one hard cap of 12288 UTF-8 bytes. The thread keeps its newest exchanges first; the window is trimmed from its oldest entry, and when the newest entry alone no longer fits only its head is kept. If the question and the extra context cannot fit at all, the tool reports `advisor-invalid-request` rather than sending a partial request.

The window includes:

- text from your messages and from the agent;
- one line per tool call: for `read`, `grep`, `find`, and `ls`, the tool name plus the declared path or pattern, capped at 256 bytes; for every other tool, including shell, write, edit, and MCP tools, the tool name alone — never its arguments, and never its result;
- the marker `[image omitted]` where one of your messages contained an image, instead of its content.

The window excludes tool results, shell executions, messages injected by extensions, compaction and branch summaries, every session entry that is not a message, and the agent's thinking.

Two further details of the request are worth naming. A thread exchange rebuilt from the history is truncated with an ellipsis when its stored text exceeds its own cap — 2048 UTF-8 bytes for a question, 8192 for an advice — although a history this extension produced never reaches that, because both values were already capped when they were written. Separately, the launch payload that the external executor receives also carries the working directory, the advisor profile's name, the model and the thinking level for that call, and opaque request, run, and node identifiers that correlate the launch with its result. None of those entries is conversation content.

### Retention

The request and the reply may persist in the executor's argv, temporary files, sessions, and lifecycle records, and at the model provider. The project promises no deletion, no external TTL, and no absence of cost, and it makes those same statements for the ContextShunt reader.

## Inspiration and scope

ContextShunt takes its large-read routing pattern from the approach described in [Spotify Engineering's article on Portal and `shunt`](https://engineering.atspotify.com/2026/9/portal-by-spotify-cut-my-claude-code-token-usage-by-90/) and the [Spotify `shunt` plugin](https://github.com/spotify/portal-ai-plugins/tree/main/plugins/shunt). This is an independent adaptation for Pi: it does not integrate Portal or AiKA, launch a worker automatically, or claim affiliation or endorsement. The package preserves Pi's own `off|observe|enforce` modes, bounded recovery, and guided read-only profile.

## Panel and status limits

The panel shows a compact preview, one row per setting, and a hint block with the focused row's explanation and sources. Model selection presents model ID first and `[provider]` last, fuzzy-searches provider, model ID, and display name, and can show transient public metadata: name, API, reasoning support, context window, and maximum output. The extension does not persist that metadata.

`/delegate status` shows exact effective references and provenance (`default`, `global`, or `session`), one `thinking-<role>` token per role, plus sanitized diagnostics. `D:NORM`, `D:AGG`, and `D:ORCH` mean local validation passed; they do not prove a delegated launch occurred or another system followed guidance. The published `0.9.0` package supports all four intensities.

## Fail-closed behavior

In `normal`, `aggressive`, or `orchestrator`, Small, Medium, and Large must each be an explicit model reference or `disabled`, and at least one must be enabled. An absent ordinary role is **not configured** and produces `D:ERR`. Any enabled reference that is missing, unavailable, out of scope, or unauthenticated also produces `D:ERR`. A configured Visual Design or Advisor reference must be valid too. `D:ERR` injects no policy, so an invalid enabled role is not rerouted, and the same check leaves the ContextShunt reader unauthorized until the configuration is corrected.

With a valid partial configuration, a different configured enabled ordinary role may cover work only when it can satisfy the same acceptance and evidence. The extension never uses a disabled, unconfigured, or invented role or model. Visual Design does not satisfy the ordinary-role minimum.

A configured thinking policy is validated locally against that role's resolved model. A well-formed level the model does not support is another `D:ERR` cause and injects no policy; the diagnostic names the role, the level, and the model. A malformed `thinking` entry is a document error rather than `D:ERR`: it invalidates the whole file, so global defaults fall back to empty defaults and a branch falls back to `off` with a sanitized notice. A policy set for a disabled or unconfigured role is stored and inert, and adds no error.

`off` always injects nothing and reports `D:OFF`, even with incomplete defaults. If the latest stored session entry is malformed or from a newer schema, restoration forces `off` and retains only a sanitized warning. Turning the policy off affects later runs; it does not rewrite an agent already running.

## Local data and privacy

The extension stores intensity, preference, explicit disabled markers, provider/model identifiers, and each role's thinking policy in local global defaults and Pi session entries. It never stores credentials, prompts, panel catalog metadata, or the thinking level chosen for an individual run. It sends no telemetry and makes no network request of its own; the external executor performs the advisor and reader calls.

Using `advisor_ask` is a deliberate exception to what stays local. With an advisor configured, that tool sends the advisor's model, through the host-authorized external executor: the bounded window described in [Advisor limits](#advisor-limits), the advisor thread so far, your question, and any extra context the agent wrote, capped at 12288 UTF-8 bytes together. Images are replaced by a marker; tool results, shell executions, extension messages, both summary kinds, tool arguments outside the four-tool allowlist, and the agent's thinking are never included.

With the reader enabled, `context_shunt_delegate` is the other exception: it sends its model, through the same executor, the preserved snapshot described in [ContextShunt reader](#contextshunt-reader) together with the question and the launch payload above. Neither tool runs unless the agent calls it, and neither can read a path or the conversation on its own.

Review local configuration before sharing diagnostics. Remove credentials, prompts, personal paths, session files, and unredacted logs. Model identifiers and provider names can still reveal information about your environment.

## Reporting vulnerabilities

Use GitHub's [private vulnerability reporting](https://github.com/Yivas/pi-delegation-policy/security/policy) for an undisclosed vulnerability; do not open a public issue. Include the affected version or commit, operating system, Pi version, reproduction steps, expected behavior, observed behavior, and a minimal sanitized configuration.

For ordinary changes, read the [contribution guide](https://github.com/Yivas/pi-delegation-policy/blob/main/CONTRIBUTING.md).

## More information

- [Commands and status](/pi-delegation-policy/commands-and-status/) explains `D:ERR` diagnosis and next-run behavior.
- [Configuration](/pi-delegation-policy/configuration/) defines policy meanings and inheritance.
- [Source repository](https://github.com/Yivas/pi-delegation-policy)
- [Package on npm](https://www.npmjs.com/package/pi-delegation-policy)
