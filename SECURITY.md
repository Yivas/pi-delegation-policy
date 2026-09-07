# Security Policy

## Scope

This project is a local Pi extension. It stores delegation policy data and model identifiers in global defaults and session entries. ContextShunt is off by default. When explicitly enforced, it may keep a known successful text result in a private, session-only temporary file to serve bounded recovery; the file has an opaque ID, quota, cancellation check, and an absolute 30-minute TTL from creation. Cleanup is scheduled while the process is active and runs at shutdown, but crashes or OS suspension can delay deletion. It does not store credentials, execute subagents, or make network requests.

ContextShunt is not a sandbox or a worker bridge. It preserves permissions and backends, does not inspect files before tool authorization, and leaves errors, structured/mixed results, images, binaries, and unknown contracts unchanged. The policy guides the main agent. It cannot guarantee that another system will follow a configured role or thinking choice. Review local configuration before using it.

## Reporting

Please use GitHub's private vulnerability reporting for this repository. Do not open a public issue for an undisclosed vulnerability. Remove credentials, session files, prompts, personal paths, and unredacted logs from reports.

Include the affected version or commit, operating system, Pi version, reproduction steps, expected behavior, observed behavior, and a minimal sanitized configuration.

## Supported versions

Only the latest published version is supported. Version 0.9.0 is the current supported release.
