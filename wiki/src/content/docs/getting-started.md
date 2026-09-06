---
title: Installation and first use
description: Install pi-delegation-policy and reach a valid delegation status safely.
---

## Requirements

- Pi `>=0.84.3` satisfies the package peer requirement.
- Pi `0.84.3` is the explicitly checked baseline; newer Pi versions are not claimed as tested.
- Access to npm to install the published package, currently `0.6.0`.
- An authenticated Pi model in the current scope for every ordinary role you enable. Visual Design is optional.

## Safe first-use path

### 1. Install and reload

```bash
pi install npm:pi-delegation-policy
```

Restart Pi or run `/reload`. A new session with no configured intensity starts at `off`.

### 2. Configure or disable ordinary roles

Open `/delegate` in Pi's TUI, or press `Alt+G`. For **Small**, **Medium**, and **Large**, choose an exact provider/model shown by Pi or choose **Disable for this session**. A disabled role is an explicit decision, not a missing model. Keep at least one ordinary role enabled. **Visual Design** is optional and does not count toward that minimum.

Each selector pins **Use global default** and **Disable for this session**, then searches provider, model ID, and display name. The model ID appears first and `[provider]` last. When Pi supplies public model metadata, the selected row can show its name, API, reasoning support, context window, and maximum output. That metadata is transient and is not stored. The panel uses text to distinguish `disabled`, `not configured`, and an exact `provider/model` reference. Changes remain a draft until **Apply changes**; closing a modified draft requires explicit discard.

Every delegated launch uses the selected exact model plus thinking chosen for that task. With `pi-subagents`, the launcher form is:

```text
model: "provider/model:LEVEL"
```

`LEVEL` is selected per run from task demand and the selected model's supported capabilities. The policy does not persist thinking, substitute a model, or rely on an ambient model or thinking default.

Visual Design may own a bounded presentation patch when visual or user-experience quality is the primary acceptance criterion and behavior, data contracts, component scope, and platform remain unchanged. It can create and integrate scoped visual assets or presentation code, then run relevant existing checks. Use an enabled ordinary role for logic, data, APIs, routes, interaction behavior, application architecture, tooling, cross-system integration, and behavior tests. The main agent retains final integration and acceptance.

### 3. Activate and inspect

Choose `normal` when expected delegation benefit clearly outweighs briefing, supervision, review, and integration overhead. Choose `aggressive` for suitable substantial, separable, independently checkable work with clear objective and acceptance criteria. `orchestrator` is available only in this unreleased development branch; it retains ownership while delegating transferable research, detailed planning, implementation, testing, writing, review, and integration mechanics. It batches small work when that reduces launches and duplicated context and does direct work of any size when transfer is not worthwhile. Tightly coupled, non-transferable, or uneconomical work remains with the main agent.

Apply the draft, then run `/delegate status`. `D:NORM` and `D:AGG` mean every ordinary role is either enabled with a valid exact reference or explicitly disabled, and at least one is enabled. This branch also exposes `D:ORCH` for the unreleased `orchestrator` intensity. `D:ERR` means a role is not configured, an enabled reference is unavailable, out of scope, or unauthenticated, or no ordinary role is enabled. No policy is injected for `D:ERR`. `D:OFF` injects nothing.

### 4. Know the persisted format

Global defaults and new session entries use schema version 3. Schema 2 values remain readable and are normalized in memory without rewriting the source. Schema 3 uses `null` to disable an ordinary role. Session changes write a schema 2 `off` guard before the schema 3 state so an older package restores off rather than older active state.

Saving effective defaults changes only the global file and does not apply the current session draft or create that guard. Before downgrading to `0.6.0`, change the global intensity to `off`, `normal`, or `aggressive` and run `/delegate off` in every active branch. Keep schema 3 for `0.6.0`; for `0.5.0` or earlier, also change global `schemaVersion` to 2 and replace ordinary `null` values with exact model references. Complete these steps before installing the older package; see [configuration](/pi-delegation-policy/configuration/#global-defaults-and-session-inheritance).

### 5. Start the next agent run

The applied configuration is read when Pi prepares the next agent run. It does not rewrite an agent that is already running. Turning the policy off removes it from subsequent runs; Pi rebuilds the system prompt for each run.

## Local checkout (secondary)

For development, from the checkout's parent directory:

```bash
pi install ./pi-delegation-policy
```

See [configuration](/pi-delegation-policy/configuration/) for inheritance and selection, or [commands and status](/pi-delegation-policy/commands-and-status/) for keyboard operation.
