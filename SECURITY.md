# Security Policy

## Scope

This project is a local Pi extension. It stores delegation policy data and model identifiers in global defaults and session entries. It does not store credentials, execute subagents, intercept tools, or make network requests.

The policy guides the main agent. It cannot guarantee that another system will follow a configured role or thinking choice. Review local configuration before using it.

## Reporting

Please use GitHub's private vulnerability reporting for this repository. Do not open a public issue for an undisclosed vulnerability. Remove credentials, session files, prompts, personal paths, and unredacted logs from reports.

Include the affected version or commit, operating system, Pi version, reproduction steps, expected behavior, observed behavior, and a minimal sanitized configuration.

## Supported versions

Only the latest published version is supported. Version 0.1.1 is the current supported release.
