# Changelog

## Unreleased

### Changed

- **Breaking:** Require Pi `0.87.1` or later. The extension now refreshes its marked policy block exclusively through `context_with_system` before each LLM request, so changes made during a turn affect the next request. The former `before_agent_start` path is removed; Pi `0.84.3` and `0.85.1` are no longer supported.

## 0.14.1 - 2026-09-21

### Changed

- Say that the advisor consultation comes before investing effort, not after finding results. The step 1 added in `0.14.0` asked the main agent to evaluate a second opinion before committing to an approach, but the first real session after that release read it as permission to save the consultation for later: it decided to "keep the question for when I have findings" and used the advisor as a validator of finished work. By the time it consulted, the advisor corrected its main conclusion. The step now names that deferral as the mistake to avoid. No new obligation: a routine decision still needs no call.

## 0.14.0 - 2026-09-21

### Changed

- Put the advisor consultation rule where the main agent reads procedure. It is now step 1 of the numbered `Decision order` and has its own `Advisor consultation:` section, instead of a paragraph inside the intensity rule that the decision steps never mentioned. Consulting is still a signal, not a quota.
- Replace the advisor's self-assessed triggers with observable ones. "An ambiguous decision", "one that is hard to undo", "a risk the main agent cannot resolve alone" and "a substantial doubt about architecture, plan, tooling or approach" all asked the main agent to notice its own doubt, and the same paragraph offered "routine decisions need none" as the way out. The signals are now features of the work: viable approaches trade off explicit requirements; evidence supports conflicting explanations that call for different actions; or a proposed change involves destructive data operations, difficult rollback, or compatibility changes for existing consumers. Public delivery surface is deliberately not one of them, because ordinary public changes are routine.
- Soften the rule for decisions that belong to the user. The main agent now considers the advisor before asking when its advice could improve the options, trade-offs or recommendation it presents, rather than consulting the advisor first.

## 0.13.0 - 2026-09-20

### Added

- Add the Advisor as a full policy role, configured in `/delegate` like the others: one exact `provider/model` reference in global defaults, or `null` in a session override to turn it off, plus its own optional `thinking.advisor` policy. When `advisor` is configured and valid, the injected policy states when consulting it is worth it — an ambiguous decision, one that is hard to undo, a risk the main agent cannot resolve alone, or a substantial doubt about architecture, plan, tooling or approach — and, when a decision belongs to the user, to consult the advisor first for options, trade-offs and a recommendation to bring together with the question. Those are triggers with clear conditions, not a quota: routine decisions need no call, and nothing forces one.
- Require a self-sufficient brief. The advisor cannot see the conversation, read files, or use tools, so every brief carries the objective and the decision, the constraints, the current state and the relevant evidence, the options and their consequences, what was tried or is proposed and why, and the open uncertainty. It is a conversation rather than a single ruling: the main agent continues the same thread through the host's resume mechanism to clarify, challenge or go deeper, and does not restart it for the same matter.
- Ship that advisor as the packaged profile `pi-delegation-policy.advisor`, with no tools and no extensions. It cannot read files, run commands, delegate, or reach the network, and it returns plain text for the task the main agent writes. Pi's subagent mechanism discovers it and launches it as a normal subagent with the exact configured model and that role's thinking policy, so the advisor appears in the roster and fleet like any other subagent.

### Changed

- **Breaking:** the Advisor is no longer a tool. `advisor_ask` and its automatic conversation window are removed, hours after `0.12.0` published them. `src/advisor-executor.ts`, `src/advisor-context.ts`, its six error codes, its 12288-byte aggregate cap, its exclusion rules, and its busy guard are gone with it. The reason: the advisor becomes a normal, visible and resumable subagent instead of a second private launch path with its own hermetic contract, and the extension goes back to launching exactly one thing, the ContextShunt reader.
- The extension no longer sends conversation on its own initiative. What reaches the advisor's provider is what the main agent writes into the task, through the same host-authorized external executor, with the same retention statement and no promise of deletion. The bounded window, its 12288-byte cap, its exclusions, and `advisor-busy` no longer exist, and public documentation no longer describes them.

### Removed

- Remove the `advisor_ask` tool registration, its authorization, counters, and lifecycle cleanup from `src/index.ts`, together with its tests and its package-content and boundary-scan entries. A configured advisor whose model is invalid still produces `D:ERR` and injects no policy, and that shared check still leaves the ContextShunt reader unauthorized.

## 0.12.0 - 2026-09-20

### Added

- Add an optional `Advisor` role with its own model reference and thinking policy. It is off by default, does not count as an ordinary role, and configures like Visual Design: an exact reference in global defaults and `null` only as a session override. Configuring no advisor changes nothing: no extra policy text and no new requirement.
- Add the explicit `advisor_ask` tool: a required `question`, optional `context`, and the `thinking` level for that call, answered with at most 8 KiB of plain-text advice plus the model and the level that produced it. Advice over the cap becomes a bounded error with no artifact or recovery surface. Failures use six bounded codes — `advisor-unavailable`, `advisor-invalid-request`, `advisor-busy`, `advisor-failed`, `advisor-timed-out`, and `advisor-cancelled` — that carry no paths, content, or secrets. One request per explicit tool may be in flight, so a busy advisor neither cancels nor disturbs an in-flight ContextShunt reader request.
- Add the Advisor model and thinking rows at the end of the `/delegate` panel and the `advisor=` and `thinking-advisor=` tokens to `/delegate status`, without renaming or renumbering existing tokens.

### Changed

- Raise the written schema to version 7 for the top-level `advisor` key. Defaults and session entries from schemas 2 through 6 are still read and normalized in memory without rewriting them, and a document that declares an older version is rejected if it carries `advisor` or `thinking.advisor`.
- State what `advisor_ask` sends. The request is a bounded window of message text — your messages and the agent's own text, with images replaced by `[image omitted]` — one line per tool call, and the advisor thread rebuilt from the history, capped at 12288 UTF-8 bytes together with the question and extra context. A tool line names the declared path or pattern for `read`, `grep`, `find`, and `ls` only, capped at 256 bytes; every other tool contributes its name alone, never its arguments. Tool results, shell executions, extension-injected messages, compaction and branch summaries, non-message entries, and the agent's thinking are excluded.
- Document that a configured advisor whose model is missing, out of scope, or unauthenticated produces `D:ERR` and injects no policy, and that the shared validation also leaves the ContextShunt reader unauthorized until the configuration is corrected. The coupling is a deliberate, documented consequence.
- State the advisor's current evidence accurately: its plain-text path has been exercised end to end in a real session against a configured provider, including the conversation thread and the busy guard, but no packed matrix covers it, so its launch contract is otherwise checked against a simulated preflight.
- Pin the external executor protocol version to `0.69.0`, the build actually exercised, and align the launch validator with that build's contract shape: contract version `3` and definition projection version `2`, taken from `src/api/preflight.ts` and `src/shared/launch-contract.ts`. The same build removed its `modelCandidates` field when it moved to one resolved model per launch, so the exact single `model` it reports replaces that equality: a substituted or downgraded model still fails, the remaining equalities are unchanged, and an older or newer contract is still rejected. Another executor build still fails closed.

### Security

- Extend the privacy boundary to conversation extracts: the advisor request and its reply may persist in the executor's argv, temporary files, sessions, and lifecycle records, and at the model provider. No deletion or external TTL is promised.
- An older package that cannot read schema 7 treats the document as invalid and falls back to `off` with a diagnostic. That is a fail-closed stop, not a smooth downgrade; the new role and tool simply do not exist there.

### Documentation

- Document the ContextShunt reader in the README and the documentation site: its two tools, the settings that enable it, what one request sends, the bounded answer with citations, and its limits. The reader requires a compatible external executor; protocol version `0.69.0` is the verified one, and another build fails closed with `reader-unavailable`, with no answer and no fallback.

## 0.11.1 - 2026-09-16

### Changed

- Show one row per setting in the `/delegate` panel instead of two, and move the focused row's description and provenance into a single hint block under the list, so the list no longer spends half its height repeating the same sentences. Values are aligned in one column, and thinking values show `unset`, a level, or `min..max` with the provenance in the hint.
- Mark a truncated line in the effective policy preview with an ellipsis instead of cutting it silently.
- Update the maintained development toolchain: the Pi packages to `0.85.1`, TypeScript to `6.0.3`, and the wiki to Astro 7.3.2, Starlight 0.42.0 and the patched `js-yaml` 4.3.2. The Pi peer range stays `>=0.84.3`, so `0.84.3` remains the minimum supported version; the explicitly checked baseline is now Pi `0.85.1`. Nothing in the published behaviour changes.

## 0.11.0 - 2026-09-16

### Added

- Add an optional thinking policy per role in a top-level `thinking` object. `{ "level": "high" }` fixes one level for every launch of that role, and `{ "min": "low", "max": "high" }` lets the main agent choose inside an inclusive range; a role with no policy keeps the per-launch choice. The extension validates a configured level against the role's resolved model and reports a level the model does not support as a new `D:ERR` cause with no injection. The extension persists the configured policy, never the level chosen for an individual run. Configurations without `thinking` keep working unchanged.
- Add four thinking rows to the `/delegate` panel and one `thinking-<role>` token per role to `/delegate status`, both reporting the policy and its source.

### Changed

- Raise the written schema to version 6. Defaults and session entries from schemas 2 through 5 are still read and normalized in memory, keep no thinking policy, and are not rewritten; a package that cannot read schema 6 treats the document as invalid and falls back to `off` without injection.
- Present the injected policy with an explicit decision order and labeled sections, so each rule's obligation and exception are stated together. Thresholds, precedence, exceptions, and role semantics are otherwise unchanged; the previous limits sentence is restated more precisely as non-enforcement at runtime.

## 0.10.0 - 2026-09-08

### Changed

- When optional Visual Design is configured and a delegated visual portion meets all four existing eligibility conditions, select it before Small, Medium, or Large with its exact configured model and per-run thinking. Reevaluate eligibility for every task or phase; this priority does not make `normal` or `aggressive` delegate more work.

## 0.9.1 - 2026-09-08

### Fixed

- Make ContextShunt declared-read limits line-based, measure known textual results with real UTF-8 bytes and shared newline handling, and keep rejected requests out of the admitted-request window.
- Keep the one-time `allow TOKEN MAX_LINES MAX_BYTES` command while binding its authorization to one tool call and immutable input snapshot; enforce its byte maximum against the real result.
- Continue accepting the deprecated schema-4 `readerOutputBytes` field for compatibility while ignoring it, omitting it from new saves, and removing its inert panel control.

## 0.9.0 - 2026-09-07

### Added

- Add opt-in ContextShunt schema 4 settings, keyboard-first mode selection, recognized read and conservative PowerShell range enforcement, and bounded recovery of preserved known textual results.
- Include the guided `pi-delegation-policy.bulk-reader` read-only profile with `read`, `grep`, `find`, and `ls`; compatible executors can discover it from the package, but it is not copied or launched automatically.

### Security

- Keep ContextShunt off by default and preserve original results when a temporary artifact cannot be created. Temporary artifacts use opaque IDs, quotas, cancellation checks, an absolute 30-minute TTL from creation, scheduled cleanup while the process is active, and cleanup at session shutdown. Recovery does not renew the TTL; crashes and OS suspension can delay deletion.

## 0.8.0 - 2026-09-07

### Changed

- Tighten `orchestrator` guidance to require delegation before all transferable execution, including detailed review and integration mechanics; require waiting for and consuming pending results, concrete gap-only reinspection, and a brief exception before minimum direct work. Size, triviality, convenience, economics, transfer cost, and final-review or integration labels are not bypasses. The published `0.7.0` policy remains unchanged.

## 0.7.0 - 2026-09-06

### Added

- Add the `orchestrator` intensity with `/delegate orchestrator` and `D:ORCH`. It delegates transferable research, detailed planning, implementation, testing, writing, review, and integration mechanics while keeping objectives, critical decisions, coordination, evidence, and final acceptance with the main agent.
- Add orchestrator guidance for batching small work, concise briefs and results with file references, and avoiding duplicate inspection without a concrete gap or risk.

## 0.6.0 - 2026-08-29

### Added

- Allow Small, Medium, and Large to be explicitly disabled independently while requiring one enabled ordinary role for an active policy.
- Add schema 3 defaults and session state, with in-memory schema 2 migration and guarded session writes for safer downgrade behavior. Downgrading after saving schema 3 defaults or manually editing them requires `/delegate off` in each active branch and manual conversion of ordinary `null` values.

### Changed

- Select only enabled ordinary roles that can satisfy the task, leaving work with the main agent when none can; Small/Medium preferences are inactive when either role is disabled.

## 0.5.0 - 2026-08-28

### Added

- Expanded the optional visual specialist to create assets and complete bounded presentation-layer changes when behavior and data contracts are already defined.

### Changed

- Renamed the user-facing UI Design role to Visual Design while preserving the `uiDesign` configuration key and `ui-design` status token.
- Clarified routing boundaries for application behavior, accessibility, checks, integration, and final acceptance.

## 0.4.1 - 2026-08-28

### Fixed

- Restored per-launch thinking selection so delegation guidance transmits the chosen level with the exact configured model instead of falling through to an ambient subagent default.

## 0.4.0 - 2026-08-27

### Added

- Added a compact effective-policy preview, selector guidance, and available public model metadata to the `/delegate` panel.

### Changed

- Require exact `provider/model` references for delegation guidance instead of relying on a launcher default.
- Clarified task-fit role selection, preference tie-breaks, dynamic advisory thinking, and current panel and status diagnostics.
- Raised the Pi peer requirement and explicitly checked baseline to `0.84.3`.

## 0.3.2 - 2026-08-26

### Documentation

- Refreshed the README and wiki with the current package status, safe first-use path, panel behavior, configuration hierarchy, and privacy boundaries.

## 0.3.1 - 2026-08-26

### Fixed

- Matched model results to Pi's `/model` presentation: model ID first, `[provider]` last, with no more than ten visible model rows.

## 0.3.0 - 2026-08-26

### Added

- Added live fuzzy model search by provider, model ID, and display name.

### Changed

- Replaced the chain of unbounded selectors with one responsive, keyboard-first settings panel.
- Made session edits explicit drafts with visible sources, bounded scrolling, and safe discard confirmation.

## 0.2.1 - 2026-08-26

### Fixed

- Replaced `Ctrl+Alt+D` with the terminal-safe, conflict-free `Alt+G` shortcut.

## 0.2.0 - 2026-08-26

### Added

- Added optional global intensity with session-branch overrides and a built-in `off` fallback.
- Added **Use global default** to the intensity selector.

### Fixed

- Replaced the terminal-ambiguous `Ctrl+Shift+D` shortcut with `Ctrl+Alt+D`.

## 0.1.2 - 2026-08-26

### Fixed

- Restored the canonical role-selection guidance for bounded execution, planning and ambiguity, repetitive volume, and exceptional blockers.
- Made the `normal` and `aggressive` thresholds and the three Small/Medium preference biases operational at their boundaries.
- Corrected session-branch guidance: a session without policy state starts at `off`, while a fork inherits the latest valid entry in its active history.

## 0.1.1 - 2026-08-26

### Added

- Added a public task-oriented documentation site on GitHub Pages.

### Fixed

- Clarified that the selector reset action changes the draft until you apply it.

### Security

- Restricted documentation deployments to `main`, isolated pull request cancellation, and pinned privileged workflow actions.

## 0.1.0 - 2026-08-25

### Added

- A keyboard-first `/delegate` selector for delegation intensity, model preference, exact Small, Medium, Large, and optional UI Design roles.
- Global defaults and session-branch state that begin at `off` and survive reload, resume, and tree navigation.
- Fail-closed validation for missing, unavailable, out-of-scope, or unauthenticated model roles.

### Changed

- Replaced the unpublished preset-based prototype with schema 2 global defaults and session-branch delegation state.
- Removed project configuration, external skill loading, tool interception, enforcement, persisted per-run thinking, and model fallbacks.
