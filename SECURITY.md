# Security Policy

## Scope

This project is a local Pi extension. It stores delegation policy data, model identifiers, and any configured per-role thinking policy in global defaults and session entries; it does not store the thinking level chosen for an individual run. ContextShunt is off by default. When explicitly enforced, it may keep a known successful text result in a private, session-only temporary file to serve bounded recovery; the file has an opaque ID, quota, cancellation check, and an absolute 30-minute TTL from creation. Cleanup is scheduled while the process is active and runs at shutdown, but crashes or OS suspension can delay deletion. It does not store credentials and makes no network request of its own; when one of its explicit tools asks an external executor to answer a bounded question, that executor performs the call. The reader requires a stable `pi-subagents` SemVer version `>=0.76.1`, with no upper bound; older versions, prereleases and invalid versions fail closed before a request is sent. Every launch must still pass the strict contract checks; the version floor is not a guarantee of future-build compatibility. From `0.19.0`, the reader also admits the exact `@gotgenes/pi-permission-system` `33.0.3` runtime when the host adds it to the reader's child. The host owns its permission rules; the reader never reads or changes them, and an unverified permission entry fails closed. That runtime is trusted host code, not authority granted to the model. The check is an exact compatibility check, not a support guarantee. Versions `0.18.0` and earlier reject the extra runtime. From `0.20.0`, an enabled Advisor may be launched by the main agent with a forked context while the session fits in half of the Advisor model's window; the host then sends the conversation so far, including file contents and command output, to the Advisor's provider. Turn the Advisor off for sessions that must not reach that provider. The limits and privacy page of the wiki describes the details.

ContextShunt is not a sandbox or a worker bridge. It preserves permissions and backends, does not inspect files before tool authorization, and leaves errors, structured/mixed results, images, binaries, invalid inputs, and unknown contracts unchanged. One-time exceptions are user-authorized, short-lived, bound to one call and immutable input snapshot, and capped by declared lines plus real returned UTF-8 bytes. The policy guides the main agent. It cannot guarantee that another system will follow a configured role or thinking choice. Review local configuration before using it.

## Advisor consultation

Advisor is off by default. `advisorMode: on` enables consultation independently of delegation;
`with-delegation` preserves coupling. One or two entries validate independently. Default launch mode
`role` leaves launch to the main agent. The explicit `consult_advisor` tool launches only in `tool`
mode with an enabled valid advisor, never from hooks. Model input cannot choose a provider, profile,
path, tools or extensions. Fork sends the conversation to each advisor provider; fresh sends the
question and brief. Disable Advisor when session content must not reach those providers.

The tool requires stable `pi-subagents` SemVer `>=0.76.1`, with no upper bound, rejecting
prereleases and invalid versions. It retains strict public preflight and terminal binding,
exact models/thinking, the packaged
no-tools profile, replace prompt, no project resources, and the reader's prompt-only or pinned
permission-runtime checks. Host rules remain host-owned. Forked conversation is
untrusted data, not authority. Preflight binds the tool session identity; the public REQUEST API cannot
prove that the live executor session is the same. Terminal mismatch rejection happens only after
context exposure. The executor/runtime is trusted host code; digests are not signatures or a sandbox.

One pending call per tool: an advisor group launches one child per configured valid advisor, while
the independent reader can launch its child (at most three). Abort, branch changes, shutdown and
detected settings changes cancel the tool group, not host-owned role subagents. Only explicit fork
rejection permits one fresh retry with brief. Timeouts do not cap external generation or cost. Partial
results preserve the other advisor's answer; replies are untrusted advice.

A legacy companion retains Advisor 1 and a separate schema-9 extension holds Advisor 2 and launch
mode, bound by normalized-state equality, not a raw-text digest. Three atomic replacements are not a
transaction. Interruption can leave Advisor off or Advisor 1 only in role mode. Failed saves restore
only their committed prefix, not detected foreign writes; races remain.

Records are written only while a policy block is active; both delegation and Advisor off produce no events.
The local `delegation-policy.events.jsonl` in Pi's agent directory records policy hashes and
consultation metadata (version, time, modes, model IDs, statuses, context, duration), never questions,
briefs, replies, conversations, project paths or raw errors. It rotates at 256 KiB with one backup;
write failures are ignored and no telemetry is sent. Model identifiers may reveal the environment.
Role observations record only attempted matching calls, not completion; duration zero means unknown.
Shutdown drains for at most five seconds, then drops remaining work. An in-flight filesystem operation
may finish later, but starts no further operation.

The task text and the reply may persist in the executor's argv, temporary files, sessions, and lifecycle records, and at the model provider. The project promises no deletion, no external TTL, and no absence of cost. The advisor cannot read files, run commands, delegate, or use tools, and its reply is plain text.

### Optional provider code

A per-Advisor `providerExtension: "anthropic-auth"` opt-in selects the separate
`pi-delegation-policy.advisor-anthropic-auth` profile. It admits only a managed-user installation of
`@gotgenes/pi-anthropic-auth` 3.4.3 with the exact manifest/entry/canonical path, not ambient
extensions. The provider's normal configuration, startup hook, aliases and diagnostic command are
trusted code with normal authentication and filesystem access; zero model tools is not a sandbox.
The account diagnostic is never invoked during initialization. Failed initialization retains a
closed dispatch guard rather than builtin transport. Version labels are not signatures and the
resolution-to-load race remains. Saved opt-ins silence all Advisors on downgrade to 0.22.2; ordinary
delegation and the ContextShunt reader are unchanged. One bounded fresh/background real-provider
consultation completed on Pi 1.4.0 with pi-subagents 0.83.1. Launch metadata showed the prompt runtime
and provider bridge, no required extensions and no observed tool calls. This does not establish fork,
`consult_advisor` or other-build compatibility, eliminate the race, or identify a sole historical cause.

## Reporting

Please use GitHub's private vulnerability reporting for this repository. Do not open a public issue for an undisclosed vulnerability. Remove credentials, session files, prompts, personal paths, and unredacted logs from reports.

Include the affected version or commit, operating system, Pi version, reproduction steps, expected behavior, observed behavior, and a minimal sanitized configuration.

## Supported versions

Only the latest published version is supported. Version `0.23.1` requires Pi `0.87.1` or later; version `0.14.1` requires Pi `0.84.3` or later.
