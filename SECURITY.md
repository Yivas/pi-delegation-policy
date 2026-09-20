# Security Policy

## Scope

This project is a local Pi extension. It stores delegation policy data, model identifiers, and any configured per-role thinking policy in global defaults and session entries; it does not store the thinking level chosen for an individual run. ContextShunt is off by default. When explicitly enforced, it may keep a known successful text result in a private, session-only temporary file to serve bounded recovery; the file has an opaque ID, quota, cancellation check, and an absolute 30-minute TTL from creation. Cleanup is scheduled while the process is active and runs at shutdown, but crashes or OS suspension can delay deletion. It does not store credentials and makes no network request of its own; when one of its explicit tools asks an external executor to answer a bounded question, that executor performs the call.

ContextShunt is not a sandbox or a worker bridge. It preserves permissions and backends, does not inspect files before tool authorization, and leaves errors, structured/mixed results, images, binaries, invalid inputs, and unknown contracts unchanged. One-time exceptions are user-authorized, short-lived, bound to one call and immutable input snapshot, and capped by declared lines plus real returned UTF-8 bytes. The policy guides the main agent. It cannot guarantee that another system will follow a configured role or thinking choice. Review local configuration before using it.

## Advisor requests

The optional Advisor role is off by default, and `advisor_ask` is the only way to consult it. When you configure an advisor and the main agent calls that tool, the request leaves the process through the host-authorized external executor. It carries a bounded window of the conversation, the advisor thread rebuilt from the session history, the question, and any extra context the agent wrote, capped at 12288 UTF-8 bytes in total. The window holds text from your messages and from the agent, and one line per tool call: for `read`, `grep`, `find`, and `ls` the tool name plus the declared path or pattern, capped at 256 bytes, and for every other tool the tool name alone, never its arguments. An image in one of your messages becomes the marker `[image omitted]`; its content is never sent. Tool results, shell executions, messages injected by extensions, compaction and branch summaries, non-message session entries, and the agent's thinking are excluded.

The request and its reply may persist in the executor's argv, temporary files, sessions, and lifecycle records, and at the model provider. The project promises no deletion, no external TTL, and no absence of cost. The advisor cannot read files, run commands, or delegate, and its answer is bounded plain text.

## Reporting

Please use GitHub's private vulnerability reporting for this repository. Do not open a public issue for an undisclosed vulnerability. Remove credentials, session files, prompts, personal paths, and unredacted logs from reports.

Include the affected version or commit, operating system, Pi version, reproduction steps, expected behavior, observed behavior, and a minimal sanitized configuration.

## Supported versions

Only the latest published version is supported. Version 0.11.1 is the current supported release.
