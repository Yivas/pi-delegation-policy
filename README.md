# pi-delegation-policy

A local Pi extension that helps the main agent decide **when delegation is worth it** and which exact models to use for the Small, Medium, Large, and optional UI Design roles. It provides guidance; it is not a subagent runner.

> **Status:** Version **0.3.2** is the latest published package. The package requires Pi `>=0.84.3`; Pi `0.84.3` is the explicitly checked baseline (newer versions are not claimed as tested). Documentation changes here do not update npm's existing README; that requires a separately approved release.
>
> **Docs:** [Read the documentation site](https://yivas.github.io/pi-delegation-policy/).

## Value and boundary

- Choose `off`, `normal`, or `aggressive` delegation intensity globally or for the current session branch.
- Configure exact provider/model references for Small, Medium, Large, and optionally UI Design.
- Keep global defaults and session-branch overrides across reload, resume, and tree navigation.
- Validate active configurations before injecting one policy block through Pi's public `before_agent_start` event.

The extension guides the main agent. It never creates, launches, routes, supervises, or blocks subagents; changes Pi's main model or thinking; stores credentials; intercepts tools; or makes its own network requests. It has no model fallback, telemetry, project configuration, presets, or external skill loading.

## Install and start

Install the published package in Pi's user settings, then reload Pi:

```bash
pi install npm:pi-delegation-policy
# restart Pi, or run /reload
```

1. Open `/delegate` (or press `Alt+G` in Pi's TUI).
2. Configure exact, authenticated Small, Medium, and Large provider/model references. UI Design is optional.
3. Select `normal` or `aggressive`, then choose **Apply changes**.
4. Run `/delegate status` and inspect the exact role references and their sources. `D:ERR` means an active required role is invalid; no policy is injected.
5. The applied state affects the **next** agent run. An agent already running is not rewritten.

See the [end-to-end getting-started guide](https://yivas.github.io/pi-delegation-policy/getting-started/) and [configuration reference](https://yivas.github.io/pi-delegation-policy/configuration/) for details.

## Essential commands

```text
/delegate                         Open the editor
/delegate off                     Disable policy for this session branch
/delegate normal                  Enable balanced delegation guidance
/delegate aggressive              Enable delegation-first guidance
/delegate status                  Show effective session state
/delegate reset                   Reset this branch to off and other fields to global defaults
```

The editor is a bounded, keyboard-first panel. It shows model ID first and `[provider]` last, fuzzy-searches provider, model ID, and display name, and shows at most 10 model rows. It also shows a compact effective-policy preview, field explanations, and public model metadata when Pi supplies it. Changes are drafts until **Apply changes**; saving effective configuration as defaults updates the global file without applying the draft, and closing a modified draft requires explicit discard.

## Configuration and safety

Global defaults are stored at `~/.pi/agent/delegation-policy.json` (schema version 2). The file stores optional intensity, preference, exact role references, and an optional UI Design reference; it never stores thinking. A valid active mode requires exact, available, in-scope, authenticated Small, Medium, and Large references. Before every delegated launch, the policy requires the selected role's exact combined reference as `model: "provider/model"`; it does not rely on an ambient launcher default. Invalid active configuration fails closed as `D:ERR` with no policy injection; `off` is always `D:OFF`.

The extension stores only policy settings and provider/model identifiers in local defaults and session entries. Review local configuration before sharing diagnostics, and remove credentials, prompts, personal paths, session files, and unredacted logs from reports. See the [limits and privacy reference](https://yivas.github.io/pi-delegation-policy/limits-and-privacy/) and [security policy](https://github.com/Yivas/pi-delegation-policy/blob/main/SECURITY.md).

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

Tests use local mocks and do not make paid model calls or network requests. See [CONTRIBUTING.md](https://github.com/Yivas/pi-delegation-policy/blob/main/CONTRIBUTING.md) for contribution guidance.

## License

MIT. See [LICENSE](https://github.com/Yivas/pi-delegation-policy/blob/main/LICENSE).
