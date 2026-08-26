---
title: Installation and first use
description: Install pi-delegation-policy and reach a valid delegation status safely.
---

## Requirements

- Pi `>=0.84.1` satisfies the package peer dependency.
- Pi `0.84.1` is the explicitly validated baseline; newer Pi versions are not claimed as tested.
- Access to npm to install the latest published package, currently `0.3.2`.
- Authenticated providers exposing the exact Small, Medium, and Large model references you intend to use in Pi's current scope. UI Design is optional.

## Safe first-use path

### 1. Install and reload

Install the published package in Pi's user settings:

```bash
pi install npm:pi-delegation-policy
```

Restart Pi or run `/reload`. The extension is inactive by default: a new session with no configured
intensity starts at `off`.

### 2. Configure exact role references

Open `/delegate` in Pi's TUI (or press `Alt+G` when that shortcut is available). In the editor:

1. Set **Small** to an exact provider and model ID exposed by Pi and authenticated for that provider.
2. Set **Medium** to its own exact provider and model ID.
3. Set **Large** to its own exact provider and model ID.
4. Optionally set **UI Design** to an exact reference, or leave it disabled.
5. Keep the values as a draft while editing. Choose **Apply changes** only after all required roles are ready.

The panel displays model ID first and `[provider]` last, and searches provider, model ID, and display
name. It does not substitute a different model when a reference is unavailable.

### 3. Select an active intensity and apply

Choose `normal` for a benefit threshold that clearly outweighs briefing, supervision, review, and
integration overhead. Choose `aggressive` for suitable substantial, separable, independently
checkable work when the objective and acceptance criteria are clear. Tightly coupled work or clearly
prohibitive overhead remains with the main agent in either mode.

Select **Apply changes** (or press `A`). Saving effective configuration as defaults is a separate
action: it updates the global file without applying the current session draft.

### 4. Inspect status before relying on it

Run:

```text
/delegate status
```

Confirm the footer shows `D:NORM` or `D:AGG`. These labels mean the selected active intensity has a
valid required configuration. `D:ERR` means an active required role is missing, unavailable,
out-of-scope, or unauthenticated; no policy is injected. Correct the role and apply again. `D:OFF`
means injection is disabled.

### 5. Start the next agent run

The applied configuration is read when Pi prepares the next agent run. It does not rewrite an agent
that is already running. Turning the policy off removes it from subsequent runs; Pi rebuilds the
system prompt for each run.

## Local checkout (secondary)

For development, from the checkout's parent directory, install the package folder instead:

```bash
pi install ./pi-delegation-policy
```

See [configuration](/pi-delegation-policy/configuration/) for defaults and session inheritance, or
[commands and status](/pi-delegation-policy/commands-and-status/) for the complete operating guide.
