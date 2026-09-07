# pi-delegation-policy

A local Pi extension that helps the main agent decide **when delegation is worth it** and which exact models to use for Small, Medium, Large, and optional Visual Design. It provides guidance; it is not a subagent runner.

> **Status:** Version **0.7.0** is the latest published package and supports `off`, `normal`, `aggressive`, and `orchestrator`. The package requires Pi `>=0.84.3`; Pi `0.84.3` is the explicitly checked baseline.
>
> **Docs:** [Read the documentation site](https://yivas.github.io/pi-delegation-policy/).

## Value and boundary

- Choose `off`, `normal`, `aggressive`, or `orchestrator` globally or for the current session branch.
- Configure an exact provider/model reference or explicitly disable each ordinary role.
- Keep global defaults and session-branch overrides across reload, resume, and tree navigation.
- Validate active configurations before injecting one policy block through Pi's public `before_agent_start` event.

The extension guides the main agent. It never creates, launches, routes, supervises, or blocks subagents; changes Pi's main model or thinking; stores credentials; intercepts tools; or makes its own network requests. In Unreleased `orchestrator`, an enabled capable role and authorized launcher require delegation of all transferable execution before it begins, regardless of size: small lookups, code reading, detailed planning, edits, tests, writing, detailed review, and integration mechanics. Bootstrap is limited to mandatory instructions, tool discovery, and a narrow assignment scope; after assigning, the main agent coordinates only disjoint work, waits through the host, and consumes results before dependencies or finalizing. It retains strategy, critical user decisions, coordination, safety, evidence evaluation, final acceptance, and concise synthesis, not permission to perform transferable review or integration. Direct work requires a briefly stated concrete exception: genuinely non-transferable work, no enabled capable role, a confirmed unavailable authorized launcher, or an explicit user or higher-priority requirement. It reinspects only a concrete gap, risk, or contradiction and delegates transferable fixes or rechecks. A final-review or integration label, size, triviality, convenience, economics, transfer cost, or familiarity never justifies doing the whole task personally. Published `0.7.0` retains its original policy. It has no model fallback, telemetry, project configuration, presets, or external skill loading.

A valid active policy requires an explicit decision for Small, Medium, and Large: an exact model reference or disabled. At least one ordinary role must remain enabled. A disabled role is not validated. An absent role, an invalid enabled reference, or no enabled ordinary role produces `D:ERR` and injects no policy. `off` always produces `D:OFF` without injection.

The policy considers only enabled ordinary roles, chooses the least costly role that can satisfy the task's acceptance criteria and evidence, and keeps work with the main agent when none can. It never invents a model or role. `efficient` and `intensive` are tie-breaks only when both Small and Medium are enabled; otherwise their bias is inactive.

Visual Design is an independent optional specialist for direction, assets, bounded presentation-layer implementation, and visual review. Use it only when behavior and data contracts are already defined and unchanged, the affected surface is bounded, and visual quality or user experience is the primary acceptance criterion. It does not count as an ordinary role or replace one. In published `0.7.0` and `normal` or `aggressive`, route business logic, data, APIs, routes, application architecture, tooling, interaction behavior, and cross-system integration to an enabled ordinary role by task fit; the main agent retains final integration and acceptance. In Unreleased `orchestrator`, the main agent instead retains integration responsibility, coordination, and final acceptance while a capable ordinary role performs transferable integration mechanics and detailed review unless a named direct-work exception applies.

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

Global defaults are stored at `~/.pi/agent/delegation-policy.json` and use schema version 3. Schema 2 defaults and session entries are read and normalized in memory without rewriting them. Schema 3 stores `null` for an explicitly disabled ordinary role. Session changes write a schema 2 `off` guard before the schema 3 state; saving defaults changes only the global file.

Before downgrading to `0.6.0`, change the global intensity to `off`, `normal`, or `aggressive` and run `/delegate off` in every active branch. For `<=0.5.0`, also convert global defaults to schema 2 and replace ordinary `null` values with exact model references. Schema 2 never accepts `orchestrator`. See the configuration reference for details.

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
```

The editor is a bounded, keyboard-first panel. Every model selector pins **Use global default** and **Disable for this session** before searchable models. It shows model ID first and `[provider]` last, fuzzy-searches provider, model ID, and display name, and shows at most 10 model rows. It also shows a compact effective-policy preview, field explanations, and public model metadata when Pi supplies it. Changes are drafts until **Apply changes**; saving effective configuration as defaults updates only the global file without applying the draft, and closing a modified draft requires explicit discard.

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
