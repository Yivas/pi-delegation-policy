---
title: Installation and first use
description: Install pi-delegation-policy and reach a valid delegation status safely.
---

## Requirements

- The unreleased source on `main` requires Pi `0.87.1` or later (`@earendil-works/pi-coding-agent >=0.87.1`); Pi `0.87.1` is the verified baseline for its per-request policy updates. The latest published package, `0.14.1`, supports Pi `0.84.3` or later (`@earendil-works/pi-coding-agent >=0.84.3`).
- The npm command below installs published package `0.14.1`, not the unreleased source on `main`.
- An authenticated Pi model in the current scope for every ordinary role you enable. Visual Design and Advisor are optional.

## Safe first-use path

### 1. Install and reload

```bash
pi install npm:pi-delegation-policy
```

Restart Pi or run `/reload`. A new session with no configured intensity starts at `off`.

### 2. Configure or disable ordinary roles

Open `/delegate` in Pi's TUI, or press `Alt+G`. For **Small**, **Medium**, and **Large**, choose an exact provider/model shown by Pi or choose **Disable for this session**. A disabled role is an explicit decision, not a missing model. Keep at least one ordinary role enabled. **Visual Design** and **Advisor** are optional and do not count toward that minimum.

Each selector pins **Use global default** and **Disable for this session**, then searches provider, model ID, and display name. The model ID appears first and `[provider]` last. When Pi supplies public model metadata, the selected row can show its name, API, reasoning support, context window, and maximum output. That metadata is transient and is not stored. The panel uses text to distinguish `disabled`, `not configured`, and an exact `provider/model` reference. Changes remain a draft until **Apply changes**; closing a modified draft requires explicit discard.

Thinking is optional per role. Leave the **Small thinking**, **Medium thinking**, **Large thinking**, **Visual Design thinking**, and **Advisor thinking** rows unset to choose a level for each launch, or set one fixed level or an inclusive range. A configured policy is binding for that role, and the panel lists only the levels that role's model supports.

Every delegated launch uses the selected exact model. With `pi-subagents`, the launcher form is:

```text
model: "provider/model:LEVEL"
```

`LEVEL` is the fixed level of that role's policy, a level inside its configured range, or the level you choose for the run when the role is unset. A fixed policy appears in the injected role line as its literal level instead of the `LEVEL` placeholder. The policy is validated locally against the role's resolved model; an unsupported level produces `D:ERR` and no injection. The extension persists the policy you configure, never the level chosen for an individual run, and it does not substitute a model or rely on an ambient model or thinking default.

Visual Design may own a bounded presentation patch when visual or user-experience quality is the primary acceptance criterion and behavior, data contracts, component scope, and platform remain unchanged. It can create and integrate scoped visual assets or presentation code, then run relevant existing checks. When configured, the main agent evaluates those four conditions before ordinary-role selection for every task or phase. If they all hold and that visual portion is already being delegated, or the active intensity requires delegation, it selects Visual Design instead of Small, Medium, or Large. It reevaluates when the task or phase changes. This priority does not make `normal` or `aggressive` delegate more work. In published `0.7.0` and `normal` or `aggressive`, use an enabled ordinary role for logic, data, APIs, routes, interaction behavior, application architecture, tooling, cross-system integration, and behavior tests; the main agent retains final integration and acceptance. In published `0.9.0` `orchestrator`, it retains integration responsibility, coordination, and final acceptance while a capable ordinary role performs transferable integration mechanics and detailed review unless a named direct-work exception applies.

**Advisor** is a second optional role, off by default and outside the ordinary-role minimum. It changes nothing about how work is delegated. When you configure it and the configuration is valid, the injected policy makes consulting it step 1 of the decision order and tells the main agent to launch `pi-delegation-policy.advisor`, the profile that ships in this package, as a normal subagent with the exact configured model and that role's thinking policy. The signals are observable in the work: viable approaches trade off explicit requirements, evidence supports conflicting explanations that call for different actions, or a proposed change involves destructive data operations, difficult rollback, or compatibility changes for existing consumers. For a decision that belongs to the user, the main agent considers the advisor before asking, so the question reaches the user with better options and trade-offs. The profile executes no work and reads nothing on its own, so the brief the main agent writes has to carry the decision, the constraints, the current state and evidence, the options and their consequences, what was tried, and the open question. The advisor is a conversation: a follow-up continues the same thread through the host's resume mechanism instead of starting over. With no advisor configured, no advisor section is injected and nothing changes. A configured advisor whose model is missing, out of scope, or unauthenticated produces `D:ERR`, which also leaves the ContextShunt reader unauthorized. See [limits and privacy](/pi-delegation-policy/limits-and-privacy/#advisor-role) for the role and retention.

### 3. Activate and inspect

Choose `normal` when expected delegation benefit clearly outweighs briefing, supervision, review, and integration overhead. Choose `aggressive` for suitable substantial, separable, independently checkable work with clear objective and acceptance criteria. Choose `orchestrator` to delegate all transferable execution before it begins whenever an enabled capable role and authorized launcher are available, regardless of size. That includes small lookups, code reading, detailed planning, implementation, tests, writing, detailed review, and integration mechanics. Bootstrap covers only mandatory instructions, tool discovery, and narrow assignment scope. After assignment, do not take the task over or launch an equivalent worker while pending; coordinate only disjoint work, wait through the host, and consume results before dependencies or finalizing. The main agent retains decisions, coordination, safety, evidence evaluation, final acceptance, and concise synthesis, not personal execution of transferable review or integration. Direct work needs a briefly stated concrete exception: genuinely non-transferable work, no enabled capable role, a confirmed unavailable authorized launcher, or an explicit user or higher-priority requirement. Reinspect only concrete gaps, risks, or contradictions; delegate transferable fixes or rechecks. A final-review label, size, triviality, convenience, economics, transfer cost, or familiarity is not an exception. Published `0.9.0` uses this stricter guidance; published `0.7.0` retains the previous policy.

Apply the draft, then run `/delegate status`. `D:NORM`, `D:AGG`, and `D:ORCH` mean every ordinary role is either enabled with a valid exact reference or explicitly disabled, and at least one is enabled. `D:ERR` means a role is not configured, an enabled reference is unavailable, out of scope, or unauthenticated, a configured Advisor reference is invalid, or no ordinary role is enabled. No policy is injected for `D:ERR`. `D:OFF` injects nothing.

### 4. Configure ContextShunt only when needed

Choose **Context protection** in `/delegate`: start with `observe`, then explicitly choose `enforce` only if the reported decisions help. `off` is the default and performs no classification, metrics, archive I/O, or interception. `observe` does not change calls or results. `enforce` covers recognized native reads, conservative bounded PowerShell reads, and known successful text results; it never launches a worker, re-runs a command, or bypasses tool permissions.

When enforcement preserves a large known text result, use `context_shunt_recover` with one bounded line or byte range. Errors, valid JSON of every root type, images, binaries, mixed content, and unknown contracts remain unchanged. The profile packaged at `agents/pi-delegation-policy.bulk-reader.md` is declared for discovery by a compatible executor as a guided read-only contract. It is not copied into user directories, launched automatically, or an isolation boundary; use it only with an executor that supports path-based profile discovery.

### 5. Know the persisted format

Global defaults and new session entries use schema version 7. Schemas 2 through 6 values remain readable and are normalized in memory without rewriting the source; they carry no `advisor` key, and a schema 2 through 5 value has no thinking policy, so its roles keep the per-launch choice. Schema 3 uses `null` to disable an ordinary role. Session changes write a schema 2 `off` guard before the schema 7 state so an older package restores off rather than older active state.

A package that cannot read schema 7 treats the document as invalid: global defaults fall back to empty defaults with `off` and no injection, and the branch falls back to `off` with a sanitized notice. Saving effective defaults changes only the global file and does not apply the current session draft or create that guard. Before downgrading to a package that cannot read schema 4, set global and branch ContextShunt to `off`. Before downgrading to `0.6.0`, also change intensity to `off`, `normal`, or `aggressive` and run `/delegate off` in every active branch. For `<=0.5.0`, change global `schemaVersion` to 2 and replace ordinary `null` values with exact model references. Complete these steps before installing the older package; see [configuration](/pi-delegation-policy/configuration/#global-defaults-and-session-inheritance).

### 6. When applied changes take effect

With the published package `0.14.1`, changes take effect on the next agent run. The unreleased source on `main` instead refreshes policy before each LLM request on Pi `0.87.1+`; a change during a turn therefore affects its next request, but not a request already in progress or a subagent already launched. In either version, turning the policy off removes the block when that version next applies its policy.

## Local checkout (secondary)

For development, from the checkout's parent directory:

```bash
pi install ./pi-delegation-policy
```

See [configuration](/pi-delegation-policy/configuration/) for inheritance and selection, or [commands and status](/pi-delegation-policy/commands-and-status/) for keyboard operation.
