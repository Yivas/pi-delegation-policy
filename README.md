# pi-delegation-policy

A local Pi extension that lets you choose delegation intensity and exact model references for Small, Medium, Large, and an optional UI Design role. It guides the main agent; it does not run, route, or enforce delegated work.

> **Status:** Version 0.2.0 is available from npm.
>
> **Documentation:** Read the [documentation site](https://yivas.github.io/pi-delegation-policy/).

## What it does

- Sets delegation intensity to `off`, `normal`, or `aggressive` globally or for the current session branch.
- Keeps global defaults for intensity, model references, preference, and the optional UI Design role.
- Stores session changes in Pi's session branch, so they survive reload, resume, and tree navigation.
- Uses Pi's scoped models when configured, otherwise its available authenticated models.
- Injects one policy block through Pi's public `before_agent_start` event when the active configuration is valid.

## What it does not do

This package does not create, launch, route, supervise, or block subagents. It does not change Pi's main model or thinking level. It has no presets, project configuration, external skill loading, tool interception, model fallback, telemetry, credential storage, or network requests.

## Install

Install the package in your Pi user settings:

```bash
pi install npm:pi-delegation-policy
```

It supports Pi `0.84.1`. Restart Pi or run `/reload` after installation. To install a local checkout instead, use `pi install ./pi-delegation-policy`.

## Commands

```text
/delegate                         Open the keyboard-first selector
/delegate off                     Disable policy injection for this session branch
/delegate normal                  Enable balanced delegation guidance
/delegate aggressive              Enable delegation-first guidance
/delegate status                  Show the effective session state
/delegate reset                   Reset this session branch to off
```

`Ctrl+Alt+D` opens the selector when the shortcut is available. There is no separate off shortcut; use `/delegate off` or choose `off` in the selector. Changes apply to the next agent run. An agent already running keeps the system prompt it started with.

The footer shows `D:OFF`, `D:NORM`, `D:AGG`, or `D:ERR` without replacing Pi's own status.

## Configuration

Global defaults live at:

```text
~/.pi/agent/delegation-policy.json
```

They use schema version 2. The file stores optional intensity, model references, preference, and an optional UI Design model. It never stores thinking.

```json
{
  "schemaVersion": 2,
  "intensity": "normal",
  "preference": "standard",
  "small": {
    "provider": "example-provider",
    "model": "example-small"
  },
  "medium": {
    "provider": "example-provider",
    "model": "example-medium"
  },
  "large": {
    "provider": "example-provider",
    "model": "example-large"
  },
  "uiDesign": {
    "provider": "example-provider",
    "model": "example-ui-design"
  }
}
```

See [`examples/global.json`](examples/global.json) and the bundled [JSON Schema](schema/delegation-policy.schema.json). The values are fictional.

Schema version 1 is inactive and is not migrated automatically. Open `/delegate`, configure schema version 2, and save the effective configuration as defaults before using an active intensity.

### Global defaults and session branches

A session branch inherits global intensity, model references, preference, and UI Design until it records matching overrides. If global intensity is absent, the built-in default is `off`. A fork restores the latest valid delegation entry in its active history. The intensity selector can return a branch to **Use global default**.

Selecting **Save effective configuration as defaults** copies the complete effective configuration, including intensity, to the global file. `/delegate reset` remains an explicit safety action: it writes a branch state with `off` and returns every other field to its global default.

### Intensity

- `off` injects nothing into the next agent run. Pi rebuilds the system prompt for each run, so a policy injected into an earlier run is absent; an agent already running is not rewritten. Invalid or incomplete defaults still show `D:OFF`.
- `normal` delegates substantial, separable work only when the expected benefit clearly outweighs briefing, supervision, review, and integration. It keeps borderline work with the main agent.
- `aggressive` delegates substantial, separable, independently checkable work by default when it has a clear objective and acceptance criteria. A plausible benefit can be enough, but tightly coupled work or clearly prohibitive overhead stays with the main agent.

The main agent keeps global strategy, coordination, integration, final review, and work whose essential context is too costly or risky to transfer in every mode.

### Model roles and preference

Active modes require exact `provider` and `model` references for Small, Medium, and Large. Pi must expose each reference in the current scope or available model catalog, and its provider must be authenticated. A missing, out-of-scope, unavailable, or unauthenticated role produces `D:ERR` and injects no policy. The extension never substitutes another model or role.

The policy chooses a role and thinking together from task demand, difficulty, and quantity. No single factor decides the role:

- Small is habitual for bounded, planned, and verifiable execution. Difficult but well-defined work can remain Small with higher thinking.
- Medium can be selected directly when the combined demands materially require planning, ambiguity reduction, broad synthesis, several-module tracing, comparison, context coordination, or difficult decisions. Small does not need to fail first.
- Large is exceptional and only unblocks genuinely stuck work, such as persistent failures, severe framework conflicts, or contradictory hypotheses. Reliable prior evidence can justify it without ceremonial failed attempts.
- Large quantities of repetitive, independent work favor multiple Small delegations. Agent type does not determine the model role.

Preference shifts credible Small/Medium choices; a clearly better task fit overrides it:

- `efficient` favors Small more strongly and uses Medium when it provides a material advantage.
- `standard` reproduces the canonical policy and chooses Small on a genuine Small/Medium tie.
- `intensive` normally favors Medium for non-trivial bounded work when both roles are credible, while retaining Small for clearly narrow, routine, mechanical, or especially clear Small work.

All three ordinary roles remain available in every preference. The main agent chooses thinking for each delegated task from task demand, difficulty, quantity, and model capabilities. Thinking is not configured or persisted by this extension.

UI Design is optional. When configured, it is limited to visual design direction, exploration, and review. It must not implement an interface, write code, or run tests. When it is off, ordinary roles handle design-related work.

## Security and privacy

The extension stores intensity, preference, and provider/model identifiers in local configuration and session entries. It does not store credentials, send telemetry, or make network requests. Review configuration before using it and remove credentials, prompts, personal paths, session files, and unredacted logs from reports.

Read [`SECURITY.md`](SECURITY.md) for reporting guidance.

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

The tests use local mocks and make no paid model calls or network requests.

## Contributing

Read [`CONTRIBUTING.md`](CONTRIBUTING.md). Contributions must preserve the boundary: this extension guides the main agent and does not become a subagent runner, tool interceptor, credential store, or telemetry client.

## License

MIT. See [`LICENSE`](LICENSE).
