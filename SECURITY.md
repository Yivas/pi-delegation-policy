# Security Policy

## Scope

This project is a local Pi extension. It stores policy in global defaults, session entries, and the
companion files listed in the [configuration reference][persistence]: intensity, preference, Advisor
mode and models, the Advisor nudge level, explicit disabled markers, per-role thinking policies, the
optional ContextShunt configuration, and provider admissions. It does not store credentials or prompts, and it
never stores the thinking level chosen for an individual run. It makes no network request of its own,
sends no telemetry, and starts no turn, child, or consultation from a hook: the policy block travels
with the requests Pi already sends.

ContextShunt is off by default. When explicitly enforced, it may keep one known successful text result
in a private, session-only temporary file to serve bounded recovery. That file has an opaque random
ID, a quota of eight artifacts and 512 KiB per session, a cancellation check, and an absolute
30-minute TTL from creation. Cleanup is scheduled while the process is active and runs at shutdown, but
a crash or OS suspension can delay deletion.

The policy guides the main agent. It cannot guarantee that another system follows a configured role or
thinking choice. ContextShunt is not a sandbox or a worker bridge: it preserves permissions and
backends, does not inspect files before tool authorization, and leaves errors, structured or mixed
results, images, binaries, invalid inputs, and unknown contracts unchanged. One-time exceptions are
user-authorized, short-lived, bound to one call and its immutable input snapshot, and capped by
declared lines plus real returned UTF-8 bytes. Review local configuration before using it.

## What reaches another model

Two surfaces can send content to another model, and both need an explicit tool call or launch.

- **ContextShunt reader.** `context_shunt_delegate` sends the preserved snapshot, its opaque source
  ID, its line count, and one question to the executor the host authorizes, together with the working
  directory, the reader profile, the model, the thinking level, and opaque request, run, and node
  identifiers. It sends no conversation, no other tool call or result, and no other artifact. It
  requires a stable `pi-subagents` SemVer version `>=0.76.1`, with no upper bound. Older, prerelease,
  invalid, and contract-incompatible builds fail closed with `reader-unavailable` before any request
  is sent. The reader also admits the exact `@gotgenes/pi-permission-system` `33.0.3` runtime when the
  host adds it to the child, and builds up to `0.18.0` reject that extra runtime. The host owns those
  permission rules. The reader never reads or changes them, and an unverified entry fails closed. This
  is an exact compatibility check, not a support guarantee for future builds.
- **Advisor.** `consult_advisor`, in the default `tool` launch, or the main agent's own launch in
  `role` mode, sends one context to each Advisor's provider. In the default `context: composed` the
  extension assembles it from what it observed: the user's literal request, the main agent's last two
  messages, the paths it read and edited, the commands it ran as program and subcommand with `ok` or
  `error`, and the change a checkpoint held back. It never contains command output, command arguments,
  file contents, model reasoning, the system prompt or anything from before the task, and its agent
  messages are only the ones written in this task. The one exception to file contents is that held
  change: its path, its line count and up to 3 KiB of the new text travel with the context, which for
  a `write` can be file content. An edit to a sensitive path is withheld and only the path is named,
  and obvious secrets become `[redacted]`. The whole context is capped at 12 KiB. Every valid entry receives the same context, and that provider
  can differ from the main model's provider. `/delegate advisor context manual` writes the question
  and the brief from the main agent instead. Every consultation runs in fresh context, so the
  extension never adds the conversation, and it refuses a launch that asks the host to fork the
  session for an Advisor.

- **Guard reviewer.** The optional reviewer of `guard` is a second model of a provider you choose,
  and it is off unless you set a model and a mode in `/delegate`. In `observe` it is asked about
  every change the rules and the count already let through, without holding the call. One request
  carries a single JSON object: your own user messages in the branch, cut to 800 characters each and
  4 KiB in total, newest first; the pending call, which is its tool name plus the path and the head
  of the new text for an edit or a write, or the head of the line for a shell call, up to 1 KiB; and
  the heads of the last 12 calls, a tool and a path or a command head. It carries no tool output, no
  message the agent wrote, no project instruction file, and no tool declaration, and the fixed system
  prompt states that the object is data and never an instruction. The head of the new text of an
  edit or a write can therefore contain file content, and it is the one place a secret in a file can
  travel to a reviewer's provider; the extension redacts nothing here because the reviewer has to
  read what would be written. Two stages: a single-token `BLOCK` or `ALLOW`, and, only after a block,
  one careful answer ending in a category from a closed set. Observing never refuses or delays a
  call, a review of one tool and one target runs once per task while the task remembers the pair (64
  pairs, oldest forgotten first), three absent verdicts in a row or five in a task turn the reviewer
  off for the session, and its local record keeps closed values, the durations, the byte count, the
  model, the mode and a salted digest of the target, never the text. Each stated limit is exact: a
  cut is a silent prefix, so no text travels past the cap it names.

One residual stays outside the extension's reach: a fork default configured in `pi-subagents` itself is
not read here, and the host would honour it. Review that setting for sessions that must not reach an
Advisor's provider, or turn the Advisor off.

Questions, briefs, composed contexts, replies, and preserved snapshots can persist in the executor's
argv, temporary files, sessions, and lifecycle records, and at each model provider. The project promises no deletion,
no external TTL, and no absence of cost. Model identifiers and provider names can reveal your
environment, so remove credentials, prompts, personal paths, session files, and unredacted logs from
anything you publish.

## Advisor consultation

Advisor has no model by default. Its mode defaults to `with-delegation`, so once an Advisor is
configured it is consulted while delegation is active. `on` enables consultation with delegation off,
and `off` silences it while keeping the saved models. One to three entries validate independently, and
an unusable entry disables only its own consultation.

`consult_advisor` launches one child per configured valid advisor through the public `pi-subagents`
delegation API, requires the same stable `>=0.76.1` floor, and is never launched from a hook. Model
input cannot choose a provider, profile, path, tools, or extensions. Launches keep strict public
preflight and terminal binding, exact models and thinking, the packaged no-tools profile, a replace
prompt, and no project resources. Host rules remain host-owned, and any context the host branches on
its own is untrusted data, not authority. Preflight binds the tool session identity, while the public
REQUEST API cannot prove that the live executor session is the same, so a terminal mismatch is
rejected only after the context has been sent. The executor and runtime are trusted host code, and
digests are not signatures or a sandbox.

One pending call per tool: three Advisors plus the reader, at most four children. Abort, branch
changes, shutdown, and detected settings changes cancel the extension-owned group, never host-owned
role subagents. No retry is issued automatically: a failed consultation reports a closed reason and
waits for the main agent. Local timeouts do not cap external generation or cost. Partial results keep
the other advisors' answers, and every reply is untrusted advice.

The `strict` and `guard` Advisor levels hold every state-changing call of a task once several were
made with no consultation, until an Advisor answers. `guard` decides on its own deterministic rules
before that count, with no model call: a force push, a hard reset, a forced clean, a recursive delete
of an absolute path, the home directory, a parent or `.git`, a download piped to a shell, a publish or
pull-request merge, a write to credentials or to this
extension's own files, and skipping the hooks are refused until the user allows them, while CI
configuration, Git hooks, `.npmrc`, a lockfile edited by hand, a newly named package and a very long
command wait for an answered consultation, which opens a pass for that rule and target
only. Reading always passes, a refusal states its category and no pattern, and no rule acts in a
subagent child session. The reader is certainty-based, and it cuts both ways: it holds a line
only when that line is one or more simple commands with plain quotes, no backslash, substitution,
backtick, here-doc, process substitution, wrapper (`bash -c`, `eval`, `cmd /c`,
`powershell -Command`, `xargs`, `busybox`, `chroot`, `stdbuf`, `setsid`, `ionice`, `watch`,
`strace`) or quoted or variable command word. `sudo`, `doas`, `env`, `nice`, `timeout`, `nohup`,
`time`, `command`, `exec`, `builtin` and the package runners (`npx`, `pnpx`, `bunx`, `npm exec|x`,
`pnpm exec|dlx`, `yarn exec|dlx`, `bun x`) are transparent with their documented options only: a
runner is read only in its exact shape, with `-y`/`--yes`/`--no`/`-q`/`--quiet` and `--` allowed in
its prefix, so an option with a value, an unknown flag or an assignment there makes the line
uncertain rather than a plain package-manager command. A program run behind a runner is judged by the
closed hard list only. The hard rules — a force push, a
hard reset, a forced clean, a recursive delete of an absolute path, the home directory, a parent or
`.git`, a download piped to a shell, a publish or a pull-request merge, a skipped hook, and a write
to credentials or to this extension's own files — apply only to those lines. Every line the reader
cannot read is refused, soft and covered once by an answered consultation for that exact line: a wrapper, an escape or a variable is held, never allowed and
never a hard refusal, and a command over 1 KiB is held the same way. The write positions are the target of an unquoted `>` or `>>`, every operand of `tee` and `sponge`, the
last operand of `cp` and `mv`, and the path an `edit` or `write` call names; a shell editor such as
`vi` or `nano`, or `sed -i`, is not one of them, so rewriting a credential in place is not a hard
refusal here. A package `publish --dry-run` is not a publish; `gh` and `hub` ignore the flag. Indirection it does not follow — a script the line names, an alias, a variable
holding the words — evades it: this is an accident
tripwire in front of the count, not a sandbox, and a hidden line is still a change for the count. `standard` only adds a note and `off` does
nothing, except that a prompt starting with `??` holds the changes of its task at any level. The
hold never covers asking the user, the task list or the supervisor channel, nor the wait tool
recognised by its default name `bg_wait`, so a held task keeps its way to a person; a wait tool the
host renamed is an unknown tool and counts as a change. Nothing releases it automatically. An earlier
release was removed because the model it was meant for forged it: any release the model can compute,
it can compute cheaply, so a release it cannot forge is a person. Two consultations in a row that
did reach an Advisor and failed now only tell the operator once per such pair, in closed terms, and
tell the model to ask the user and stop; every change stays refused, and the hold ends with an
answered consultation or with the operator, who can fix the Advisor, change the level with
`/delegate` and send a new prompt, because a task keeps the level it started with, or cancel the
task. These levels are a nudge for a person at the keyboard, not a boundary for an unattended run.
Only a result whose details prove an Advisor started counts as such a failure, so repeating a call
that consulted nobody, or one refused for want of a brief before any launch, buys nothing. This is a
nudge, not a security boundary: the extension decides what changes state by reading the tool name
and the text of a shell command, which it never runs, and that reading can be wrong in both
directions. It grants, widens and inspects no permission, and with no Advisor to
consult it holds nothing.

Thread continuity, the private content-free journal, and their locks are described in the
[configuration reference][threads]. The concurrent-writer and session-binding limits are in
[limits and privacy][log].

### Optional provider code

A per-Advisor `providerExtension: "anthropic-auth"` opt-in selects the separate
`pi-delegation-policy.advisor-anthropic-auth` profile. It admits only a managed-user installation of
`@gotgenes/pi-anthropic-auth` 3.4.3, 3.4.4, or 3.6.0 with the exact manifest, a single internal entry,
and the canonical path, and it inherits no ambient extensions. The provider's normal configuration,
startup hook, aliases, and account diagnostic command are trusted code with normal authentication and
filesystem access. Zero model tools is not a sandbox.

**Advisor reading.** Reading is off by default and turned on per Advisor slot, stored in
`delegation-policy.advisor-read.json`. It applies to role launches: `consult_advisor`, the tool launch,
always runs the packaged no-tools profile, so a flag set there changes nothing. In a role launch, when it
is on, that Advisor launches through
`pi-delegation-policy.advisor-read`, a separate profile whose only tool is `read`; there is no shell,
write, network, MCP, extension, or nested agent. The profile is not a path boundary: this extension
grants the tool and the host's permission rules decide what `read` may reach, so a brief that names a
sensitive path can expose it to the Advisor's provider. The profile instructs the Advisor to open only
the paths the brief names, to refuse credentials, keys, and personal files, and to say when it cannot
see an image instead of describing it, but that is guidance, not enforcement. File content reaches the
Advisor's provider with the same retention as the brief. Provider-dependent Advisor profiles keep their
own identity and stay tool-free, so reading is never available on them. The diagnostic is never invoked during
initialization, and failed initialization keeps a closed dispatch guard rather than falling back to
builtin transport. Version labels are not signatures, and the resolution-to-load race remains. A saved
opt-in silences every Advisor on downgrade to `0.22.2`, while ordinary delegation and the ContextShunt
reader are unchanged.

Other providers that only an extension supplies can be admitted per provider from the same panel. Only
the package identity and its listed source are checked before it runs, so it is trusted code, not a
sandbox: once loaded it has your files, your network, and its own accounts, and withdrawing its
provider after a failed check does not undo what it already did.

## Local records

Content-free records are written only while a policy block is active. With delegation and Advisor both
off, no new event is written except in the short window before the next request notices that the policy
is off. `delegation-policy.events.jsonl` holds policy and consultation metadata plus one `task` counter
record per main-agent task, one `launch` record per checked subagent call, and one `gate` record per
task whose gate opened (a `strict` or `guard` task, or any task a `??` prompt opened), written when
it ends by a settle, a branch move or shutdown, with counts only and that reason. Its `ruleHits`
also count `engine-failure` when the guard could not judge a call at all. `passes` counts the calls a
consultation pass let through; neither field carries the call, its command, its path or the text of a
refusal. `task` and `consultation` records carry `mainModel` and
`advisorLevel`, and `consultation` also carries `noArgs` and `contextBytes`, which is `0` in manual
mode. It never holds questions, briefs, contexts, replies, conversations, project paths, or raw
errors. It rotates at 256 KiB with one backup,
write failures are ignored, and no telemetry is sent. Shutdown drains queued writes for at most five
seconds, then drops the rest. An in-flight filesystem operation may finish later but starts no further
operation. The writer serializes within one process, not across processes.

The [limits and privacy reference][log] lists every field and the retention of each one.

## Reporting

Please use GitHub's private vulnerability reporting for this repository: open a draft advisory at
<https://github.com/Yivas/pi-delegation-policy/security/advisories/new>. Do not open a public issue for
an undisclosed vulnerability. Remove credentials, session files, prompts, personal paths, and
unredacted logs from reports.

Include the affected version or commit, the operating system, the Pi version, reproduction steps, the
expected behavior, the observed behavior, and a minimal sanitized configuration.

## Supported versions

Only the latest published version is supported. Version `0.35.0` supports Pi `0.87.1` or later
(`>=0.87.1`). Version `0.14.1` supports Pi `0.84.3` or later.

[persistence]: https://yivas.github.io/pi-delegation-policy/configuration/#persistence-and-compatibility
[threads]: https://yivas.github.io/pi-delegation-policy/configuration/#advisor
[log]: https://yivas.github.io/pi-delegation-policy/limits-and-privacy/#local-content-free-log
