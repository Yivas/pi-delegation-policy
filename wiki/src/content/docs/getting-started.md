---
title: Installation and first use
description: Install pi-delegation-policy and reach a valid delegation status safely.
---

## Requirements

- Pi `>=0.84.3` satisfies the package peer requirement.
- Pi `0.84.3` is the explicitly checked baseline; newer Pi versions are not claimed as tested.
- Access to npm to install the latest published package, `0.9.1`.
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

Visual Design may own a bounded presentation patch when visual or user-experience quality is the primary acceptance criterion and behavior, data contracts, component scope, and platform remain unchanged. It can create and integrate scoped visual assets or presentation code, then run relevant existing checks. When configured, the main agent evaluates those four conditions before ordinary-role selection for every task or phase. If they all hold and that visual portion is already being delegated, or the active intensity requires delegation, it selects Visual Design instead of Small, Medium, or Large. It reevaluates when the task or phase changes. This priority does not make `normal` or `aggressive` delegate more work. In published `0.7.0` and `normal` or `aggressive`, use an enabled ordinary role for logic, data, APIs, routes, interaction behavior, application architecture, tooling, cross-system integration, and behavior tests; the main agent retains final integration and acceptance. In published `0.9.0` `orchestrator`, it retains integration responsibility, coordination, and final acceptance while a capable ordinary role performs transferable integration mechanics and detailed review unless a named direct-work exception applies.

### 3. Activate and inspect

Choose `normal` when expected delegation benefit clearly outweighs briefing, supervision, review, and integration overhead. Choose `aggressive` for suitable substantial, separable, independently checkable work with clear objective and acceptance criteria. Choose `orchestrator` to delegate all transferable execution before it begins whenever an enabled capable role and authorized launcher are available, regardless of size. That includes small lookups, code reading, detailed planning, implementation, tests, writing, detailed review, and integration mechanics. Bootstrap covers only mandatory instructions, tool discovery, and narrow assignment scope. After assignment, do not take the task over or launch an equivalent worker while pending; coordinate only disjoint work, wait through the host, and consume results before dependencies or finalizing. The main agent retains decisions, coordination, safety, evidence evaluation, final acceptance, and concise synthesis, not personal execution of transferable review or integration. Direct work needs a briefly stated concrete exception: genuinely non-transferable work, no enabled capable role, a confirmed unavailable authorized launcher, or an explicit user or higher-priority requirement. Reinspect only concrete gaps, risks, or contradictions; delegate transferable fixes or rechecks. A final-review label, size, triviality, convenience, economics, transfer cost, or familiarity is not an exception. Published `0.9.0` uses this stricter guidance; published `0.7.0` retains the previous policy.

Apply the draft, then run `/delegate status`. `D:NORM`, `D:AGG`, and `D:ORCH` mean every ordinary role is either enabled with a valid exact reference or explicitly disabled, and at least one is enabled. `D:ERR` means a role is not configured, an enabled reference is unavailable, out of scope, or unauthenticated, or no ordinary role is enabled. No policy is injected for `D:ERR`. `D:OFF` injects nothing.

### 4. Configure ContextShunt only when needed

Choose **Context protection** in `/delegate`: start with `observe`, then explicitly choose `enforce` only if the reported decisions help. `off` is the default and performs no classification, metrics, archive I/O, or interception. `observe` does not change calls or results. `enforce` covers recognized native reads, conservative bounded PowerShell reads, and known successful text results; it never launches a worker, re-runs a command, or bypasses tool permissions.

When enforcement preserves a large known text result, use `context_shunt_recover` with one bounded line or byte range. Errors, valid JSON of every root type, images, binaries, mixed content, and unknown contracts remain unchanged. The profile packaged at `agents/pi-delegation-policy.bulk-reader.md` is declared for discovery by a compatible executor as a guided read-only contract. It is not copied into user directories, launched automatically, or an isolation boundary; use it only with an executor that supports path-based profile discovery.

### 5. Know the persisted format

Global defaults and new session entries use schema version 4. Schema 2 and 3 values remain readable and are normalized in memory without rewriting the source. Schema 3 uses `null` to disable an ordinary role. Session changes write a schema 2 `off` guard before the schema 4 state so an older package restores off rather than older active state.

Saving effective defaults changes only the global file and does not apply the current session draft or create that guard. Before downgrading to a package that cannot read schema 4, set global and branch ContextShunt to `off`. Before downgrading to `0.6.0`, also change intensity to `off`, `normal`, or `aggressive` and run `/delegate off` in every active branch. For `<=0.5.0`, change global `schemaVersion` to 2 and replace ordinary `null` values with exact model references. Complete these steps before installing the older package; see [configuration](/pi-delegation-policy/configuration/#global-defaults-and-session-inheritance).

### 6. Start the next agent run

The applied configuration is read when Pi prepares the next agent run. It does not rewrite an agent that is already running. Turning the policy off removes it from subsequent runs; Pi rebuilds the system prompt for each run.

## Local checkout (secondary)

For development, from the checkout's parent directory:

```bash
pi install ./pi-delegation-policy
```

See [configuration](/pi-delegation-policy/configuration/) for inheritance and selection, or [commands and status](/pi-delegation-policy/commands-and-status/) for keyboard operation.
