---
title: Limits and privacy
description: Understand the product boundary, fail-closed behavior, local data, and safe reporting.
---

## Product boundary

`pi-delegation-policy` requires Pi `0.87.1` or later and adds one policy block when an active configuration is valid. Its public `context_with_system` hook refreshes only the marked block in the first system message before each LLM request, so changes made during a turn apply to the next request. `off` removes only that block. It preserves the host system message, tools, context, other extension sections, and conversation; it does not route, supervise, or accept subagent results, and it never launches anything from a hook. Its only launch belongs to one explicit tool that asks the host-authorized external executor for one bounded answer: `context_shunt_delegate`, for one question about an already-preserved text artifact. The optional advisor is a role the main agent launches as a subagent, not a launch of this extension. The reader tool never replaces delegation, the launcher, tool permissions, or a remote backend. It does not change Pi's main model or thinking level.

The policy evaluates task fit before preference from demand, difficulty, quantity, risk, and error and review cost. In published `0.9.0` `orchestrator`, the main agent must delegate all transferable execution before it begins whenever an enabled capable role and authorized launcher are available, regardless of size: small lookups, code reading, detailed planning, implementation, testing, writing, detailed review, and integration mechanics. Bootstrap is only mandatory instructions, tool discovery, and narrow assignment scope. It must not take over or duplicate pending work; it coordinates only disjoint work, waits through the host, and consumes results before dependent work or finalizing. The main agent retains critical decisions, coordination, safety, evidence evaluation, final acceptance, and concise synthesis, not permission to perform transferable review or integration. It reinspects only a concrete gap, risk, or contradiction and delegates transferable fixes or rechecks. Direct execution requires a briefly stated concrete exception: genuinely non-transferable work, no enabled capable role, a confirmed unavailable authorized launcher, or an explicit user or higher-priority requirement. A final-review or integration label, size, triviality, convenience, economics, transfer cost, or familiarity is not an exception. Published `0.7.0` retains its original policy. It considers only enabled ordinary roles, chooses the least costly enabled role that can satisfy task acceptance and evidence, and keeps work with the main agent when none can. `efficient` and `intensive` break credible Small/Medium ties only while both are enabled; `standard` adds no extra bias.

Thinking has three per-role states and one default. With no configured policy, the main agent chooses the level for each launch instead of inheriting an ambient subagent default. A configured fixed level or inclusive range is binding guidance for that role, and the extension checks locally that the level belongs to the role's resolved model. None of this can make another system follow the guidance.

For every delegated launch, the policy names the selected exact `provider/model` base and that role's thinking policy. `pi-subagents` uses `model: "provider/model:LEVEL"`, with a fixed policy shown as its literal level; another launcher may expose a separate field. The extension never supplies a model fallback or enforces that another system follows the guidance.

It has no presets, project configuration, external skill loading, telemetry, credential storage, or network request of its own; the external executor performs the reader call, and the host's subagent mechanism performs the advisor launch. It is not a subagent runner and cannot make another system perform delegation. ContextShunt is its separate, opt-in protection layer; it uses only Pi's public tool hooks and does not replace tools, permission checks, remote backends, or an executor.

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

One `context_shunt_delegate` request may be in flight at a time.

### What one request sends

The reader task carries the preserved snapshot text, its opaque source ID, its line count, and the question. It carries no conversation, no other tool call or result, and no other artifact. The launch payload that the external executor receives also carries the working directory, the reader profile's name, the model and the thinking level for that call, and opaque request, run, and node identifiers that correlate the launch with its result. The snapshot is sent during the preflight that resolves the launch contract as well, before any launch.

Both the snapshot and the answer are untrusted data rather than instructions. The extension never follows text inside them and never executes it.

The reader needs a compatible external executor. Protocol version `0.69.0` is the verified one; a different executor build fails the contract check and returns `reader-unavailable`, with no answer and no fallback model, provider, or retry.

### Retention

The preserved snapshot and the answer may persist in the executor's argv, temporary files, sessions, and lifecycle records, and at the model provider. The project promises no deletion, no external TTL, and no absence of cost. A failed reader call leaves no answer artifact.

## Advisor role

The advisor is a role, not a tool. It is off by default, and the extension registers nothing for it: no tool, no executor, no in-flight counter, no lifecycle cleanup. When `advisor` is configured and valid, the injected policy tells the main agent when consulting it is worth it and to launch `pi-delegation-policy.advisor`, the profile that ships in this package, as a normal subagent through Pi's own subagent mechanism. That launch belongs to the host, not to this extension, and it uses the exact configured model and that role's `thinking.advisor` policy.

The profile declares no tools and no extensions. It cannot read files, run commands, delegate, or reach the network; it sees the task text that arrives with it and returns plain text. Its consultation signals are observable in the work: viable approaches trade off explicit requirements, evidence supports conflicting explanations that call for different actions, or a proposed change involves destructive data operations, difficult rollback, or compatibility changes for existing consumers. The policy makes consulting step 1 of the decision order and also tells the main agent to consider the advisor before asking the user when that would improve the options, trade-offs or recommendation it presents. They are signals with observable conditions, not a threshold that forces a call, and the policy does not promise obedience.

Because the advisor sees nothing else, the brief has to be self-sufficient: the objective and the decision, the constraints, the current state and the relevant evidence, the options and their consequences, what was tried or is proposed and why, and the open uncertainty. The advisor is a conversation rather than a single answer: continuing the thread through the host's resume mechanism is what lets the main agent clarify, challenge or go deeper, so a follow-up continues the same session instead of opening a new one with the same background.

A configured advisor whose model is missing, unavailable, out of scope, or unauthenticated produces `D:ERR` and injects no policy, exactly like Visual Design. That validation is shared: the same error also leaves the ContextShunt reader unauthorized until the configuration is corrected.

### What the advisor receives

The extension no longer assembles a conversation window and sends nothing on its own initiative. The task is whatever the main agent writes into it, and only the main agent decides what that contains; nothing in the policy bounds that text, and there is no aggregate cap and no exclusion list. The extension keeps no advisor thread: the subagent session belongs to the host, and the advisor's provider is the executor's provider. The host's resume mechanism continues that session, so nothing is rebuilt or re-sent by the extension.

### Retention

The task text the main agent writes and the advisor's reply may persist in the executor's argv, temporary files, sessions, and lifecycle records, and at the model provider. The project promises no deletion, no external TTL, and no absence of cost, and it makes those same statements for the ContextShunt reader.

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

The extension stores intensity, preference, explicit disabled markers, provider/model identifiers, and each role's thinking policy in local global defaults and Pi session entries. It never stores credentials, prompts, panel catalog metadata, or the thinking level chosen for an individual run. It sends no telemetry and makes no network request of its own; the external executor performs the reader call, and the host's subagent mechanism performs the advisor launch.

Consulting the advisor is a deliberate exception to what stays local. With an advisor configured, the main agent may launch the packaged `pi-delegation-policy.advisor` profile through the host's subagent mechanism, and what travels to the advisor's model is what the main agent writes into the task, through the host-authorized external executor. The extension itself sends no conversation on its own initiative. Read [Advisor role](#advisor-role) for the triggers and retention.

With the reader enabled, `context_shunt_delegate` is the other exception: it sends its model, through the same executor, the preserved snapshot described in [ContextShunt reader](#contextshunt-reader) together with the question and the launch payload above. The reader tool runs only when the agent calls it, and it can never read a path or the conversation on its own.

Review local configuration before sharing diagnostics. Remove credentials, prompts, personal paths, session files, and unredacted logs. Model identifiers and provider names can still reveal information about your environment.

## Reporting vulnerabilities

Use GitHub's [private vulnerability reporting](https://github.com/Yivas/pi-delegation-policy/security/policy) for an undisclosed vulnerability; do not open a public issue. Include the affected version or commit, operating system, Pi version, reproduction steps, expected behavior, observed behavior, and a minimal sanitized configuration.

For ordinary changes, read the [contribution guide](https://github.com/Yivas/pi-delegation-policy/blob/main/CONTRIBUTING.md).

## More information

- [Commands and status](/pi-delegation-policy/commands-and-status/) explains `D:ERR` diagnosis and next-run behavior.
- [Configuration](/pi-delegation-policy/configuration/) defines policy meanings and inheritance.
- [Source repository](https://github.com/Yivas/pi-delegation-policy)
- [Package on npm](https://www.npmjs.com/package/pi-delegation-policy)
