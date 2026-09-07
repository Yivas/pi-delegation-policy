# pi-delegation-policy

A local Pi extension that helps the main agent decide **when delegation is worth it** and which exact models to use for Small, Medium, Large, and optional Visual Design. It provides guidance; it is not a subagent runner.

> **Status:** Version **0.9.0** is the latest published package and supports `off`, `normal`, `aggressive`, and `orchestrator`. The package requires Pi `>=0.84.3`; Pi `0.84.3` is the explicitly checked baseline.
>
> **Docs:** [Read the documentation site](https://yivas.github.io/pi-delegation-policy/).

## Value and boundary

- Choose `off`, `normal`, `aggressive`, or `orchestrator` globally or for the current session branch.
- Configure an exact provider/model reference or explicitly disable each ordinary role.
- Keep global defaults and session-branch overrides across reload, resume, and tree navigation.
- Validate active configurations before injecting one policy block through Pi's public `before_agent_start` event.
- Optionally use ContextShunt to observe or enforce bounded handling of recognized oversized text results without launching a worker.

The extension guides the main agent. It never creates, launches, routes, or supervises subagents; changes Pi's main model or thinking; stores credentials; or makes its own network requests. ContextShunt is opt-in: `off` performs no classification, metrics, archival, or interception; `observe` records only what enforcement would block; and `enforce` blocks only recognized declared excess and replaces only successfully preserved, known textual results. It never bypasses the tool permission/backend, runs a command again, or launches a worker from a hook. Enforcement checks Pi's public tool provenance and leaves same-named extension or SDK tools unchanged; observe may report those names only as non-binding heuristics. In `0.9.0` `orchestrator`, an enabled capable role and authorized launcher require delegation of all transferable execution before it begins, regardless of size: small lookups, code reading, detailed planning, edits, tests, writing, detailed review, and integration mechanics. Bootstrap is limited to mandatory instructions, tool discovery, and a narrow assignment scope; after assigning, the main agent coordinates only disjoint work, waits through the host, and consumes results before dependencies or finalizing. It retains strategy, critical user decisions, coordination, safety, evidence evaluation, final acceptance, and concise synthesis, not permission to perform transferable review or integration. Direct work requires a briefly stated concrete exception: genuinely non-transferable work, no enabled capable role, a confirmed unavailable authorized launcher, or an explicit user or higher-priority requirement. It reinspects only a concrete gap, risk, or contradiction and delegates transferable fixes or rechecks. A final-review or integration label, size, triviality, convenience, economics, transfer cost, or familiarity never justifies doing the whole task personally. Published `0.7.0` retains its original policy; `0.9.0` contains this stricter guidance. It has no model fallback, telemetry, project configuration, presets, or external skill loading.

A valid active policy requires an explicit decision for Small, Medium, and Large: an exact model reference or disabled. At least one ordinary role must remain enabled. A disabled role is not validated. An absent role, an invalid enabled reference, or no enabled ordinary role produces `D:ERR` and injects no policy. `off` always produces `D:OFF` without injection.

### Inspiration and attribution

ContextShunt is inspired by the large-read routing pattern described in [Spotify Engineering's article on Portal and `shunt`](https://engineering.atspotify.com/2026/9/portal-by-spotify-cut-my-claude-code-token-usage-by-90/) and its [`shunt` plugin](https://github.com/spotify/portal-ai-plugins/tree/main/plugins/shunt). It is an independent adaptation for Pi: it does not integrate Portal or AiKA, launch a worker automatically, or claim affiliation or endorsement.

The policy considers only enabled ordinary roles, chooses the least costly role that can satisfy the task's acceptance criteria and evidence, and keeps work with the main agent when none can. It never invents a model or role. `efficient` and `intensive` are tie-breaks only when both Small and Medium are enabled; otherwise their bias is inactive.

Visual Design is an independent optional specialist for direction, assets, bounded presentation-layer implementation, and visual review. Use it only when behavior and data contracts are already defined and unchanged, the affected surface is bounded, and visual quality or user experience is the primary acceptance criterion. It does not count as an ordinary role or replace one. In published `0.7.0` and `normal` or `aggressive`, route business logic, data, APIs, routes, application architecture, tooling, interaction behavior, and cross-system integration to an enabled ordinary role by task fit; the main agent retains final integration and acceptance. In `0.9.0` `orchestrator`, the main agent instead retains integration responsibility, coordination, and final acceptance while a capable ordinary role performs transferable integration mechanics and detailed review unless a named direct-work exception applies.

## Install and start

```bash
pi install npm:pi-delegation-policy
# restart Pi, or run /reload
```

1. Open `/delegate` (or press `Alt+G` in Pi's TUI).
2. For Small, Medium, and Large, select an exact authenticated provider/model or **Disable for this session**. Keep at least one enabled.
3. Select `normal`, `aggressive`, or `orchestrator`, then choose **Apply changes**.
4. Run `/delegate status`. `disabled`, `not configured`, and exact references remain distinct. `D:ERR` means no policy is injected.
5. The applied state affects the **next** agent run.

Global defaults are stored at `~/.pi/agent/delegation-policy.json` and new values use schema version 4. Schema 2 and 3 defaults and session entries are read and normalized in memory without rewriting them. Schema 3 stores `null` for an explicitly disabled ordinary role. Session changes write a schema 2 `off` guard before the schema 4 state; saving defaults changes only the global file.

Before downgrading to a package that does not read schema 4, set global and branch ContextShunt to `off`; the guarded branch write already presents schema 2 `off` to older versions. Before downgrading to `0.6.0`, also change the global intensity to `off`, `normal`, or `aggressive` and run `/delegate off` in every active branch. For `<=0.5.0`, convert global defaults to schema 2 and replace ordinary `null` values with exact model references. Schema 2 never accepts `orchestrator`. See the configuration reference for details.

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

The editor is a bounded, keyboard-first panel. Every model selector pins **Use global default** and **Disable for this session** before searchable models. It shows model ID first and `[provider]` last, fuzzy-searches provider, model ID, and display name, and shows at most 10 model rows. It also shows a compact effective-policy preview, field explanations, and public model metadata when Pi supplies it. Changes are drafts until **Apply changes**; saving effective configuration as defaults updates only the global file without applying the draft, and closing a modified draft requires explicit discard.

**Context advanced** in `/delegate` edits the requested reader role, limits, and comma-separated patterns, with per-field global inheritance and a ContextShunt draft reset. In `enforce`, an oversized recognized read receives a bounded-read or user-confirmed one-time exception path. Large known text results are compacted only after their original is stored in a private, session-only artifact with a quota and an absolute 30-minute TTL from creation; scheduled cleanup runs while the process is active, recovery does not renew it, and shutdown removes the temporary directory. Crashes or OS suspension can delay deletion. `context_shunt_recover` accepts either a bounded line range or byte range. Errors, valid JSON of every root type, images, mixed content, and unknown tool contracts remain unchanged. The package declares `agents/pi-delegation-policy.bulk-reader.md` for discovery by a compatible executor. It allows only `read`, `grep`, `find`, and `ls`; it remains a guided profile, not an automatic bridge or a claim of executor isolation. It is not copied into user agent directories or launched automatically. If an executor cannot discover a path-based profile, use the guided redirection only.

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
