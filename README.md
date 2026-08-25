# pi-delegation-policy

A local Pi extension that lets you choose delegation intensity and exact model references for Small, Medium, Large, and an optional UI Design role. It guides the main agent; it does not run, route, or enforce delegated work.

> **Status:** Version 0.1.0 is available from npm. Every new session starts at `off`.
>
> **Documentation:** Read the [documentation site](https://yivas.github.io/pi-delegation-policy/).

## What it does

- Sets delegation intensity to `off`, `normal`, or `aggressive` for the current session branch.
- Keeps global defaults for model references, preference, and the optional UI Design role.
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

`Ctrl+Shift+D` opens the selector when the shortcut is available. The footer shows `D:OFF`, `D:NORM`, `D:AGG`, or `D:ERR` without replacing Pi's own status.

## Configuration

Global defaults live at:

```text
~/.pi/agent/delegation-policy.json
```

They use schema version 2. The file stores model references, preference, and an optional UI Design model. It never stores intensity or thinking.

```json
{
  "schemaVersion": 2,
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

A new session or branch always starts at `off`. It inherits global model references and preference until `/delegate` changes a field in that branch. Session fields override only their matching global values. Selecting **Save effective configuration as defaults** copies the current roles, preference, and UI Design setting to the global file without copying intensity.

`/delegate reset` writes a session state with `off` and returns non-intensity fields to their global defaults.

### Intensity

- `off` injects nothing. Invalid or incomplete defaults still show `D:OFF`.
- `normal` delegates substantial, bounded, independent work when doing so saves effort without losing essential context.
- `aggressive` favors delegating that work when its objective and acceptance criteria are clear.

The main agent keeps global decisions, coordination, integration, and final review in every mode.

### Model roles and preference

Active modes require exact `provider` and `model` references for Small, Medium, and Large. Pi must expose each reference in the current scope or available model catalog, and its provider must be authenticated. A missing, out-of-scope, unavailable, or unauthenticated role produces `D:ERR` and injects no policy. The extension never substitutes another model or role.

The preference only changes the policy's selection bias:

- `efficient` favors Small.
- `standard` uses Small for routine work, Medium for planning, ambiguity, or broad synthesis, and Large for exceptional blockers.
- `intensive` favors Medium.

All three ordinary roles remain available in every preference. The main agent chooses thinking for each delegated task from the task, difficulty, volume, and model capabilities. Thinking is not configured or persisted by this extension.

UI Design is optional. When configured, it is limited to visual design direction, exploration, and review. It must not implement an interface, write code, or run tests. When it is off, ordinary roles handle design-related work.

## Security and privacy

The extension stores provider and model identifiers in local configuration and session entries. It does not store credentials, send telemetry, or make network requests. Review configuration before using it and remove credentials, prompts, personal paths, session files, and unredacted logs from reports.

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
