# Security Policy

## Scope

This project is a local Pi extension. It stores delegation policy data, model identifiers, and any configured per-role thinking policy in global defaults and session entries; it does not store the thinking level chosen for an individual run. ContextShunt is off by default. When explicitly enforced, it may keep a known successful text result in a private, session-only temporary file to serve bounded recovery; the file has an opaque ID, quota, cancellation check, and an absolute 30-minute TTL from creation. Cleanup is scheduled while the process is active and runs at shutdown, but crashes or OS suspension can delay deletion. It does not store credentials and makes no network request of its own; when one of its explicit tools asks an external executor to answer a bounded question, that executor performs the call.

ContextShunt is not a sandbox or a worker bridge. It preserves permissions and backends, does not inspect files before tool authorization, and leaves errors, structured/mixed results, images, binaries, invalid inputs, and unknown contracts unchanged. One-time exceptions are user-authorized, short-lived, bound to one call and immutable input snapshot, and capped by declared lines plus real returned UTF-8 bytes. The policy guides the main agent. It cannot guarantee that another system will follow a configured role or thinking choice. Review local configuration before using it.

## Advisor consultation

The optional Advisor role is off by default. The extension registers no tool, executor, or lifecycle work for it: it only injects policy guidance. When you configure an advisor and the main agent decides to consult it, the main agent launches the packaged `pi-delegation-policy.advisor` profile as a normal subagent through Pi's subagent mechanism and the host-authorized external executor. The extension no longer sends conversation on its own initiative: what leaves the process is what the main agent writes into that task, and the main agent decides what that text contains.

The task text and the reply may persist in the executor's argv, temporary files, sessions, and lifecycle records, and at the model provider. The project promises no deletion, no external TTL, and no absence of cost. The advisor cannot read files, run commands, delegate, or use tools, and its reply is plain text.

## Reporting

Please use GitHub's private vulnerability reporting for this repository. Do not open a public issue for an undisclosed vulnerability. Remove credentials, session files, prompts, personal paths, and unredacted logs from reports.

Include the affected version or commit, operating system, Pi version, reproduction steps, expected behavior, observed behavior, and a minimal sanitized configuration.

## Supported versions

Only the latest published version is supported. Version 0.14.1 is the current supported release.
