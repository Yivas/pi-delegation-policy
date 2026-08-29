# pi-delegation-policy

A local Pi extension that helps the main agent decide **when delegation is worth it** and which exact models to use for Small, Medium, Large, and optional Visual Design. It provides guidance; it is not a subagent runner.

> **Status:** Version **0.6.0** is the latest published package. The package requires Pi `>=0.84.3`; Pi `0.84.3` is the explicitly checked baseline.
>
> **Docs:** [Read the documentation site](https://yivas.github.io/pi-delegation-policy/).

## Value and boundary

- Choose `off`, `normal`, or `aggressive` globally or for the current session branch.
- Configure an exact provider/model reference or explicitly disable each ordinary role.
- Keep global defaults and session-branch overrides across reload, resume, and tree navigation.
- Validate active configurations before injecting one policy block through Pi's public `before_agent_start` event.

The extension guides the main agent. It never creates, launches, routes, supervises, or blocks subagents; changes Pi's main model or thinking; stores credentials; intercepts tools; or makes its own network requests. It has no model fallback, telemetry, project configuration, presets, or external skill loading.

A valid active policy requires an explicit decision for Small, Medium, and Large: an exact model reference or disabled. At least one ordinary role must remain enabled. A disabled role is not validated. An absent role, an invalid enabled reference, or no enabled ordinary role produces `D:ERR` and injects no policy. `off` always produces `D:OFF` without injection.

The policy considers only enabled ordinary roles, chooses the least costly role that can satisfy the task's acceptance criteria and evidence, and keeps work with the main agent when none can. It never invents a model or role. `efficient` and `intensive` are tie-breaks only when both Small and Medium are enabled; otherwise their bias is inactive.

Visual Design is an independent optional specialist for direction, assets, bounded presentation-layer implementation, and visual review. Use it only when behavior and data contracts are already defined and unchanged, the affected surface is bounded, and visual quality or user experience is the primary acceptance criterion. It does not count as an ordinary role or replace one. Route business logic, data, APIs, routes, application architecture, tooling, interaction behavior, and cross-system integration to an enabled ordinary role by task fit. The main agent retains final integration and acceptance.

## Install and start

```bash
pi install npm:pi-delegation-policy
# restart Pi, or run /reload
```

1. Open `/delegate` (or press `Alt+G` in Pi's TUI).
2. For Small, Medium, and Large, select an exact authenticated provider/model or **Disable for this session**. Keep at least one enabled.
3. Select `normal` or `aggressive`, then choose **Apply changes**.
4. Run `/delegate status`. `disabled`, `not configured`, and exact references remain distinct. `D:ERR` means no policy is injected.
5. The applied state affects the **next** agent run.

Global defaults are stored at `~/.pi/agent/delegation-policy.json` and use schema version 3. Schema 2 defaults and session entries are read and normalized in memory; they are not rewritten on read. Schema 3 stores `null` for an explicitly disabled ordinary role. Session changes write a schema 2 `off` guard before the schema 3 state so older versions restore off. Saving global defaults is global-only: before downgrading after that action or manually writing schema 3, run `/delegate off` in every active branch, restore schema 2 references manually, then install the older package.

See the [getting-started guide](https://yivas.github.io/pi-delegation-policy/getting-started/) and [configuration reference](https://yivas.github.io/pi-delegation-policy/configuration/).

## Essential commands

```text
/delegate                         Open the editor
/delegate off                     Disable policy for this session branch
/delegate normal                  Enable balanced delegation guidance
/delegate aggressive              Enable delegation-first guidance
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
