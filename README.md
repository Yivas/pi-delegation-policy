# pi-delegation-policy

A Pi extension that makes delegation policy and exact subagent model assignments configurable without becoming a subagent runner.

> **Status:** early development. This package is not published yet and defaults to `off`.

## What it does

- Controls delegation intensity with `off`, `normal`, and `aggressive`.
- Stores named, autonomous presets.
- Supports two assignment strategies:
  - **Tiered:** `general`, `strong`, `ui-design`.
  - **Task-based:** `planning`, `research`, `implementation`, `debugging`, `review`, `ui-design`.
- Stores exact `provider`, `model`, and `thinking` values for each assignment.
- Supports global, trusted-project, and session scopes.
- Injects one short policy block through Pi's public `before_agent_start` extension event.
- Can require a configured external skill before configured executor tools run.
- Validates models and authentication through Pi's current model registry.

`ui-design` is visual design work only. It must not implement the interface. Implementation belongs to `implementation`, `general`, or `strong` according to the selected strategy.

## What it does not do

This package does not create, launch, route, manage, or monitor subagents. It does not register a subagent tool, change the main session model, include an execution skill, choose hidden fallbacks, or make network requests.

A separate skill or extension must explain how your chosen subagent system executes work. The policy extension only tells the main agent when delegation is appropriate and which exact configured assignment to use.

## Install from source

The package is currently unpublished and private. There is no public registry or remote install URL yet.

For a local checkout:

```bash
pi install ./pi-delegation-policy
```

The package requires Pi `0.84.1` or newer. Restart Pi or run `/reload` after installation.

## Commands

```text
/delegate                         Open the policy editor
/delegate off                     Session override: no policy injection
/delegate normal                  Session override: balanced delegation
/delegate aggressive              Session override: delegation-first behavior
/delegate status                  Show effective policy and validation state
/delegate reset                   Remove session overrides
```

`Ctrl+Shift+D` opens the editor when the shortcut is available.

The footer shows `D:OFF`, `D:NORM`, `D:AGG`, or `D:ERR` without replacing Pi's footer.

## Configuration scopes

```text
Global:  ~/.pi/agent/delegation-policy.json
Project: <trusted-project>/.pi/delegation-policy.json
Session: custom entries in the active Pi session branch
```

Precedence is `Session > Project > Global > safe defaults`. Project configuration is ignored unless Pi reports the project as trusted. Presets merge by name; a same-name preset in a higher scope replaces the complete lower-scope preset. There are no implicit list concatenations.

A preset contains its own assignments and can contain one or both strategies:

```json
{
  "schemaVersion": 1,
  "activePreset": "balanced",
  "presets": {
    "balanced": {
      "defaultMode": "normal",
      "defaultStrategy": "task-based",
      "skill": "your-subagent-skill",
      "enforcement": true,
      "executorTools": ["subagent"],
      "tiered": {
        "general": {
          "provider": "your-provider",
          "model": "your-general-model",
          "thinking": "medium"
        }
      },
      "taskBased": {
        "implementation": {
          "provider": "your-provider",
          "model": "your-implementation-model",
          "thinking": "high"
        },
        "ui-design": {
          "provider": "your-provider",
          "model": "your-visual-designer",
          "thinking": "high"
        }
      }
    }
  }
}
```

Use `/delegate` to edit this data. The editor can create, duplicate, rename, and delete presets; choose scopes; select discovered skills; configure enforcement and executor tools; and select provider, model, and thinking values from Pi's registry.

The public defaults are safe:

```text
mode: off
active preset: none
skill: unset
presets: {}
```

See [`examples/global.json`](examples/global.json) and [`examples/project.json`](examples/project.json) for fictional values only.

## External skill and enforcement

Set `skill` to the exact discovered skill name. With enforcement enabled, only the listed `executorTools` are blocked, and only until the configured skill is loaded or its `SKILL.md` is successfully read. The extension never substitutes another skill or creates a replacement executor.

Enforcement is a coordination guard, not a sandbox. Another extension can start work through a path that is not listed in `executorTools`.

## Development

```bash
npm install
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
npm run pack:check
```

Tests use mocks and do not make paid model calls or network requests.

## Security and privacy

The extension stores provider and model identifiers, not credentials. It does not contact providers, send telemetry, or phone home. Review project configuration before trusting a repository: a project file can change delegation instructions and tool enforcement for that project.

Report vulnerabilities privately through GitHub's private vulnerability reporting for this repository. Do not include credentials, session files, prompts, or unredacted logs in public issues.

## Contributing

Issues and pull requests are welcome. Read [`CONTRIBUTING.md`](CONTRIBUTING.md), run the full local checks, and keep all examples fictional and provider-agnostic. This repository does not accept changes that add a subagent runner, hidden model fallback, telemetry, or credential handling.

## License

MIT. See [`LICENSE`](LICENSE).
