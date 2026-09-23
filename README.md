# pi-delegation-policy

A local Pi extension that helps the main agent decide **when delegation is worth it** and which exact models to use for Small, Medium, Large, and the optional Visual Design and Advisor roles. It provides guidance; it is not a subagent runner.

> **Status:** Version **0.14.1** is the latest published package and supports `off`, `normal`, `aggressive`, and `orchestrator`. That published version supports Pi `0.84.3` or later (`@earendil-works/pi-coding-agent >=0.84.3`). The unreleased source on `main` requires Pi `0.87.1` or later (`@earendil-works/pi-coding-agent >=0.87.1`); this new minimum does not apply to published version `0.14.1`. Pi `0.87.1` is the verified baseline for per-request policy updates.
>
> **Docs:** [Read the documentation site](https://yivas.github.io/pi-delegation-policy/).

## Value and boundary

- Choose `off`, `normal`, `aggressive`, or `orchestrator` globally or for the current session branch.
- Configure an exact provider/model reference or explicitly disable each ordinary role.
- Optionally bind a thinking level, or an inclusive level range, per role; leave a role unset and the main agent chooses its level per launch.
- Optionally add an Advisor role: the main agent consults it on genuine doubts and to prepare a user decision, launching the packaged profile as a subagent. It advises and executes no work.
- Keep global defaults and session-branch overrides across reload, resume, and tree navigation.
- Validate active configurations before injecting one policy block. The unreleased source on `main` refreshes it before each Pi `0.87.1+` LLM request, including subsequent requests in the same turn; published version `0.14.1` retains its existing per-agent-run behavior.
- Optionally use ContextShunt to observe or enforce bounded handling of recognized oversized text results without launching a worker, and to ask the `context_shunt_delegate` reader one question about a preserved result.

The extension guides the main agent. It never routes or supervises subagents, never changes Pi's main model or thinking, never stores credentials, and makes no network request of its own. One explicit tool asks the host-authorized external executor for one bounded answer: `context_shunt_delegate`, for one question about an already-preserved text artifact. It is never invoked from a hook, and it never replaces delegation, the launcher, tool permissions, or a remote backend. ContextShunt is opt-in: `off` performs no classification, metrics, archival, or interception; `observe` records only what enforcement would block; and `enforce` blocks only recognized declared excess and replaces only successfully preserved, known textual results. It never bypasses the tool permission/backend, runs a command again, or launches a worker from a hook. Enforcement checks Pi's public tool provenance and leaves same-named extension or SDK tools unchanged; observe may report those names only as non-binding heuristics. In `0.9.0` `orchestrator`, an enabled capable role and authorized launcher require delegation of all transferable execution before it begins, regardless of size: small lookups, code reading, detailed planning, edits, tests, writing, detailed review, and integration mechanics. Bootstrap is limited to mandatory instructions, tool discovery, and a narrow assignment scope; after assigning, the main agent coordinates only disjoint work, waits through the host, and consumes results before dependencies or finalizing. It retains strategy, critical user decisions, coordination, safety, evidence evaluation, final acceptance, and concise synthesis, not permission to perform transferable review or integration. Direct work requires a briefly stated concrete exception: genuinely non-transferable work, no enabled capable role, a confirmed unavailable authorized launcher, or an explicit user or higher-priority requirement. It reinspects only a concrete gap, risk, or contradiction and delegates transferable fixes or rechecks. A final-review or integration label, size, triviality, convenience, economics, transfer cost, or familiarity never justifies doing the whole task personally. Published `0.7.0` retains its original policy; `0.9.0` contains this stricter guidance. It has no model fallback, telemetry, project configuration, presets, or external skill loading.

A valid active policy requires an explicit decision for Small, Medium, and Large: an exact model reference or disabled. At least one ordinary role must remain enabled. A disabled role is not validated. An absent role, an invalid enabled reference, or no enabled ordinary role produces `D:ERR` and injects no policy. A configured thinking policy whose level the role's model does not support is another `D:ERR` cause and names the role, level, and model. `off` always produces `D:OFF` without injection.

### Inspiration and attribution

ContextShunt is inspired by the large-read routing pattern described in [Spotify Engineering's article on Portal and `shunt`](https://engineering.atspotify.com/2026/9/portal-by-spotify-cut-my-claude-code-token-usage-by-90/) and its [`shunt` plugin](https://github.com/spotify/portal-ai-plugins/tree/main/plugins/shunt). It is an independent adaptation for Pi: it does not integrate Portal or AiKA, launch a worker automatically, or claim affiliation or endorsement.

The policy considers only enabled ordinary roles, chooses the least costly role that can satisfy the task's acceptance criteria and evidence, and keeps work with the main agent when none can. It never invents a model or role. `efficient` and `intensive` are tie-breaks only when both Small and Medium are enabled; otherwise their bias is inactive.

Visual Design is an independent optional specialist for direction, assets, bounded presentation-layer implementation, and visual review. Use it only when behavior and data contracts are already defined and unchanged, the affected surface is bounded, and visual quality or user experience is the primary acceptance criterion. It does not count as an ordinary role or replace one. When configured, evaluate those four conditions before ordinary-role selection for every task or phase. If they hold and the main agent chooses to delegate that visual portion, or the active intensity requires delegation, it must select Visual Design instead of Small, Medium, or Large, using Visual Design's exact configured `provider/model` and that role's thinking policy. Reevaluate when the task or phase changes. This priority does not make `normal` or `aggressive` delegate more work. In published `0.7.0` and `normal` or `aggressive`, route business logic, data, APIs, routes, application architecture, tooling, interaction behavior, and cross-system integration to an enabled ordinary role by task fit; the main agent retains final integration and acceptance. In `0.9.0` `orchestrator`, the main agent instead retains integration responsibility, coordination, and final acceptance while a capable ordinary role performs transferable integration mechanics and detailed review unless a named direct-work exception applies.

**ContextShunt reader** is an optional capability of the same opt-in layer, off by default. ContextShunt registers two normal tools: `context_shunt_delegate`, which answers one question from an already-preserved text artifact, and `context_shunt_recover`, which returns one bounded line or byte range from a preserved artifact. Three ContextShunt keys control the reader: `readerEnabled` (built-in `false`), `readerRole` (an existing ordinary role, `small` by default, no separate reader model), and `answerMaxBytes` (8192 by default, 1024 to 16384). It also requires an effective mode of `enforce`, an active delegation intensity, and a valid configuration; in any other state a call produces a bounded error and no answer.

The reader's task contains only the preserved snapshot, its opaque source ID, its line count, and a question of at most 2048 UTF-8 bytes: no conversation, no other artifact, and no other tool call. An answer, its citations, and its envelope stay within `answerMaxBytes`; a validated answer over that cap is preserved and returned as a receipt for `context_shunt_recover` instead of being truncated. Citations name exact line ranges of that snapshot, at most 16 of them, and a result with no established answer reports `insufficient-evidence` instead. The reader needs a compatible external executor: protocol version `0.69.0` is the verified one, and another build fails closed with `reader-unavailable`, with no answer and no fallback. The [limits and privacy reference](https://yivas.github.io/pi-delegation-policy/limits-and-privacy/) states what one request sends and what the executor and its provider may retain.

## Advisor

Advisor is an optional consultation role, off by default and outside the ordinary-role minimum. It advises; it executes no work. Configure it in `/delegate` like any other role: one exact `provider/model` reference in global defaults, an optional `thinking.advisor` policy, and `null` in a session override to turn it off. The Advisor model and thinking rows close the panel after Visual Design, and `/delegate status` reports `advisor=` and `thinking-advisor=` with their provenance.

When the advisor is configured and valid, the injected policy makes consulting it step 1 of the main agent's decision order and tells it to launch `pi-delegation-policy.advisor`, the profile that ships in this package, as a normal subagent through Pi's own subagent mechanism, with the exact configured model and that role's thinking policy. The signals are features of the work rather than self-reported doubt: viable approaches trade off explicit requirements, evidence supports conflicting explanations that call for different actions, or a proposed change involves destructive data operations, difficult rollback, or compatibility changes for existing consumers. When a decision belongs to the user, the main agent considers the advisor before asking, so the question reaches the user with better options and trade-offs. These are signals, not a quota: routine decisions need no call, and nothing enforces one.

The advisor has no tools and no extensions, so it cannot read files, run commands, delegate, or reach the network. It knows only what the brief contains and answers with plain text. A brief that stands on its own carries the objective and the decision, the constraints, the current state and the relevant evidence, the options and their consequences, what was tried or is proposed and why, and the open uncertainty. It is a conversation rather than a single ruling: the main agent continues the same thread through the host's resume mechanism instead of restarting it for the same matter.

What the advisor receives is what the main agent writes into the task, and it travels through the same host-authorized external executor and provider with their normal retention, as the [limits and privacy reference](https://yivas.github.io/pi-delegation-policy/limits-and-privacy/) states. The extension sends no conversation on its own initiative. A configured advisor whose model is missing, out of scope, or unauthenticated produces `D:ERR` and injects no policy; because that check is shared, it also leaves the ContextShunt reader unauthorized.

## Install and start

```bash
pi install npm:pi-delegation-policy
# restart Pi, or run /reload
```

1. Open `/delegate` (or press `Alt+G` in Pi's TUI).
2. For Small, Medium, and Large, select an exact authenticated provider/model or **Disable for this session**. Keep at least one enabled. The thinking rows are optional: leave one unset to choose a level per launch, or fix one level or an inclusive range. Visual Design and Advisor are optional model rows and do not count toward that minimum.
3. Select `normal`, `aggressive`, or `orchestrator`, then choose **Apply changes**.
4. Run `/delegate status`. `disabled`, `not configured`, and exact references remain distinct, and each role reports its thinking policy and source. `D:ERR` means no policy is injected.
5. In the unreleased source on Pi `0.87.1+`, applied changes affect the **next LLM request**, including another request in the current turn. Published `0.14.1` applies changes on the next agent run. A request already in progress and subagents already launched keep their existing state.

Global defaults are stored at `~/.pi/agent/delegation-policy.json` and new values use schema version 7. A `thinking` object holds at most one policy per role; omitting it keeps the per-launch thinking choice. The legacy positive `contextShunt.limits.readerOutputBytes` field remains accepted when reading schema 4, but is ignored and omitted from new saves. Schemas 2 through 6 defaults and session entries are read and normalized in memory without rewriting them; they carry no `advisor` key, and only schemas 6 and later carry a thinking policy. Schema 3 stores `null` for an explicitly disabled ordinary role. Session changes write a schema 2 `off` guard before the schema 7 state; saving defaults changes only the global file.

The extension stores delegation policy only: intensity, preference, model references, the optional ContextShunt configuration, and the thinking policy you configure. It never stores the thinking level chosen for an individual run.

A package that cannot read schema 7 treats the document as invalid: global defaults fall back to empty defaults with `off` and no injection, and a branch falls back to `off` with a sanitized notice. Before downgrading to a package that does not read schema 4, set global and branch ContextShunt to `off`; the guarded branch write already presents schema 2 `off` to older versions. Before downgrading to `0.6.0`, also change the global intensity to `off`, `normal`, or `aggressive` and run `/delegate off` in every active branch. For `<=0.5.0`, convert global defaults to schema 2 and replace ordinary `null` values with exact model references. Schema 2 never accepts `orchestrator`. See the configuration reference for details.

See the [getting-started guide](https://yivas.github.io/pi-delegation-policy/getting-started/) and [configuration reference](https://yivas.github.io/pi-delegation-policy/configuration/).

## Essential commands

```text
/delegate                         Open the editor
/delegate off                     Disable policy for this session branch
/delegate normal                  Enable balanced delegation guidance
/delegate aggressive              Enable delegation-first guidance
/delegate orchestrator             Minimize main-agent execution and narration
/delegate status                  Show effective session state
/delegate reset                   Reset this branch to off and other fields to global defaults
/delegate context off             Stop ContextShunt work for this branch
/delegate context observe         Record would-block decisions without changing calls or results
/delegate context enforce         Enforce recognized budgets and bounded recovery
/delegate context status          Show effective ContextShunt state
```

The editor is a bounded, keyboard-first panel. Every model selector pins **Use global default** and **Disable for this session** before searchable models. It shows model ID first and `[provider]` last, fuzzy-searches provider, model ID, and display name, and shows at most 10 model rows. Four thinking rows offer global inheritance, no policy for the session, a fixed level, or an inclusive range, and list only the levels the role's model supports. It also shows a compact effective-policy preview, one row per setting with a hint block for the focused row's explanation and sources, and public model metadata when Pi supplies it. Changes are drafts until **Apply changes**; saving effective configuration as defaults updates only the global file without applying the draft, and closing a modified draft requires explicit discard.

**Context advanced** in `/delegate` edits reader enablement, the requested reader role, its answer byte cap, limits, and comma-separated patterns, with per-field global inheritance and a ContextShunt draft reset. In `enforce`, an oversized recognized read receives a bounded-read or user-confirmed one-time exception path. Preguards use declared lines, while postguards use real UTF-8 bytes and returned line counts; rejected reads do not consume the shared declared-request window. Large known text results are compacted only after their original is stored in a private, session-only artifact with a quota and an absolute 30-minute TTL from creation; scheduled cleanup runs while the process is active, recovery does not renew it, and shutdown removes the temporary directory. Crashes or OS suspension can delay deletion. `context_shunt_recover` accepts either a bounded line range or byte range. Errors, valid JSON of every root type, images, mixed content, and unknown tool contracts remain unchanged. The package declares `agents/pi-delegation-policy.bulk-reader.md` for discovery by a compatible executor. It allows only `read`, `grep`, `find`, and `ls`; it remains a guided profile, not an automatic bridge or a claim of executor isolation. It is not copied into user agent directories or launched automatically. If an executor cannot discover a path-based profile, use the guided redirection only.

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

Tests use local mocks and do not make paid model calls or network requests. See [CONTRIBUTING.md](https://github.com/Yivas/pi-delegation-policy/blob/main/CONTRIBUTING.md).

## License

MIT. See [LICENSE](LICENSE).
