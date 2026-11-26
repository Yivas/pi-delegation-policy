# Changelog

## Unreleased

### Changed

- `guard` no longer behaves exactly like `strict`. Before the count it decides on a closed set of
  deterministic rules, with no model call: a force push, a hard reset, a forced clean, a recursive
  delete of an absolute path, the home directory, a parent, a path built from a variable or `.git`
  (`rm -rf`), a download piped to
  a shell, a publish or pull-request merge, a write to
  credentials or to this extension's own files, and skipping the hooks are refused for the rest of
  the task until the user allows it. Repeating the call or consulting an Advisor does not lift any of
  them. A quoted mention is not a call: a commit message that names a flag skips no hook.
- `guard` also holds these until an answered consultation: CI configuration, Git hooks, `.npmrc`, a
  lockfile edited by hand, a newly named package and a very long command, plus three
  failing runs in a row, the same file edited again after failures, and three distinct files edited
  with no consultation. An answered consultation opens a pass for that exact rule and target for a
  few calls, and for nothing else.
- `guard` keeps the count `0.35.0` set, at 3 and 6, and a refused call still moves no counter.
  Reading always passes, including `diff`, `grep -q` and `git diff --quiet`, whose non-zero exit is
  not a failing run; a refusal names its category and never a count or a pattern; and no rule acts in
  a subagent child session.
- The rules read a line only when it is one they can read with certainty: one or more simple
  commands, split on unquoted `;`, `|`, `&&`, `||`, `&` and newlines, with plain quotes and no
  backslash, substitution, backtick, here-doc, process substitution, wrapper (`bash -c`, `eval`,
  `cmd /c`, `powershell -Command`, `xargs`) or quoted or variable command word. The hard rules apply
  only there. Everything else that changes state is a soft `long-command` refusal — "a line this
  reader cannot judge with certainty" — with a single pass for that exact line once a consultation
  answers: a wrapper, a substitution or a variable is held, never allowed and never hard. A command
  over 1 KiB is not read at all and is held the same way. The prefixes that only set up the command
  behind them — `sudo`, `doas`, `env`, `nice`, `timeout`, `nohup`, `time`, `command`, `exec`,
  `builtin`, and the package runners — are transparent with their documented options only, and a
  runner is read only in its exact shape with `-y`/`--yes`/`--no`/`-q`/`--quiet` and `--` allowed in
  its prefix; the exact prefix and launcher lists are in the guard section of the wiki. Every refusal
  says which exit it leaves open.
- Once two consultations in a row reach an Advisor and fail, a refusal by any rule that names a
  consultation ends with "ask the user and stop", like the count gate's refusal, while the rules only
  the user can allow keep their own text.
- When the session cannot consult at all, the rules that a consultation would lift refuse nothing,
  because that hold would have no way out, while the rules only the user can allow still refuse.
- One `gate` record is written per watched task when it ends by a settle, a branch move or shutdown,
  and it adds `ruleHits`, the refusals of each `guard` rule by closed code, and `passes`, the calls a
  consultation pass let through.
- A package `publish` with `--dry-run` is not a publish, and a `gate` record counts a broken guard
  under its own `engine-failure` code instead of mixing it with a line the reader could not read.
- The guard report script in the repository (not in the package) summarises the `gate` records of a
  log file and its rotated predecessor
  without printing any of their content.

### Fixed

- A consultation that names the Advisors in `workflow: "parallel"` is a consultation, not a change.
  Its children are part of the same call, so no rule and no count refuses them and a held task gets
  all of them. The hold lifts on the host's result as before: one Advisor that answered, read from
  the per-child results, is enough. A parallel workflow that fails is unobservable by design — the
  host reports a failed call with no details — so it lifts nothing; the way out is a consultation
  that succeeds, such as a single-Advisor foreground launch.
- A `bash` line that starts with an assignment whose value is quoted reads as the read it is:
  `f="C:/x.md"; wc -l "$f"` no longer counts as a change. A value that expands or redirects inside
  its quotes still does: `f="$(touch x)"`, `f="${X}"` and a backtick there remain changes.

## 0.35.0 - 2026-11-25

### Changed

- **Breaking:** `strict` no longer refuses one call per task, a refusal that named repeating the call
  as a way through and was easy to satisfy. It counts the changes it lets a task make, warns once
  after 3 changes made since the last answer, and refuses every change from the 6th until an Advisor
  consultation answers. Reading always passes, a refused change is not counted, and repeating it does
  not unblock it. The way out is to consult an Advisor, or to change the level with `/delegate` and
  send a new prompt.
- `guard` behaves exactly like `strict` in this version.
- `standard` states one note after every 8 tool results, at most one per request, instead of one
  reminder per task, and refuses nothing.
- Apart from `consult_advisor` and the session control tools listed below, anything not provably a
  read is a change: `edit`, `write`, `multi_edit`, an unknown tool, a shell command that is not
  wholly a known read.
- Test runs and builds count as changes, so an edit-and-test loop reaches the hold quickly.
- Only a consultation whose result details prove that an Advisor answered opens the hold, since
  failure text proves nothing.
- Nothing releases the hold on its own: an answered consultation, a level change with `/delegate`
  and a new prompt, or a cancelled task ends it.
- Asking the user, the task list, the supervisor channel and the wait tool `bg_wait` are never
  changes, by these exact names only, so a renamed tool counts as a change and a held task can still
  reach a person.
- Two consultations in a row that reached an Advisor and got no answer warn the operator once per
  pair and tell the model to ask the user and stop, with every change still refused.
- While changes are held, an Advisor launch with `async` omitted or `true` is refused: `role` launch
  is told to relaunch with `async: false`, and `tool` launch is pointed at `consult_advisor()`.
- A `??` prompt holds the changes of its task at every level, which is stricter than the single
  refusal 0.34.0 gave it, and at `off` and `standard` the first answered consultation ends the hold
  and counting does not resume.
- The calls of one assistant message are decided one by one, so a message can run its first changes
  and have the rest refused.

### Removed

- The close interruption of `guard`: the extension no longer registers the host's settle boundary.
- The substantive-task tests and the 30 minutes between two refusals, which let the old checkpoint
  skip a task.
- The reminder no longer arms on a successful `read`, `find`, `grep` or `ls` result or on the same
  builtin tool failing in two rounds.
- The `checkpoint` and `guard` log records, replaced by one `gate` record per watched task, with
  counts only.

### Fixed

- A blocked Advisor continuity cause printed its prefix twice in `advisor threads recover` and
  `advisor threads reset`: the cause text already names its subject, so it now reads once.

## 0.34.0 - 2026-11-23

### Added

- A fourth Advisor nudge level, `guard`, for what `strict` could not do: it refuses no tool call, so it
  cannot be satisfied by repeating one. It counts every call that ran and changed state, reminds once
  per message that changes state, and interrupts the close of the task through the host's final settle
  boundary, asking for one more request. A consultation that reached an Advisor covers the changes made
  before it and five more; a call that never dispatched covers nothing. Each task is interrupted at
  most twice, and the second interruption is only earned by new changes since the first, so ignoring
  an interruption closes the task on the next finish. Availability is checked at that instant, so a
  bridge that is down never stops the work. In `role` mode the launch happens in the host tool, so
  there an attempt covers, and registering the boundary makes the host evaluate it on every session,
  including the levels that never add an entry there. `strict`, `standard` and `off` are unchanged.

### Fixed

- A consultation interrupted before the host returned its run id, or one whose run ended in a state
  other than `complete`, left the Advisor blocked for that session with no command able to clear it:
  `recover` needed a run id and `reset` refused while anything looked unresolved. Reconciliation now
  runs before a consultation reports continuity as blocked and reuses the same evidence as
  `recover`, closing what the host proves terminal, what it no longer holds once a whole list proves
  it absent, and — for a record with no run id — what that same list proves absent. A live run, a
  trimmed list, an unfamiliar run state or an unanswerable bridge still blocks.
  `reset` can now abandon a turn that never returned a run id and that no evidence resolves, and it
  still refuses while a run may be live or while a record holds a run id it cannot settle.

## 0.33.1 - 2026-11-23

### Fixed

- Serve `pi-antigravity-acp-provider` `0.1.22` in the packaged provider-extension profile, whose
  reviewed registration is one tool, `antigravity_acp_permission`, two commands, two events, the
  quota event subscription and one provider registration. An admission of the installed `0.1.22` no
  longer leaves the Advisor out. The diagnostic now splits by state: an unreviewed version of the
  pinned package names both versions and the two ways out, and another admitted package says it
  needs its own profile instead of pointing at a selection that cannot serve it. An admission saved
  for a version this pin does not name still stops being served, so it needs the pinned version
  installed and the extension selected again.

## 0.33.0 - 2026-11-22

### Added

- Let `consult_advisor` run with no arguments and send a context the host composes, with
  `/delegate advisor context manual` returning to a brief the agent writes.
- Add the Advisor nudge level, `off`, `standard` or `strict`, with an **Advisor nudge** panel row and
  a per-model map in `delegation-policy.advisor-level.json`.
- Add `/delegate advisor level` for the branch, the global file and the current main model, each with
  `default` to clear it.
- Refuse the first substantive change of a task once in `strict`, and only record what it would have
  refused in `standard`.
- Log one `checkpoint` event per task, plus `mainModel`, `advisorLevel`, `noArgs` and `contextBytes`
  in the records that already existed.

### Changed

- State Advisor flags in one status line under Purpose, including `none` when no Advisor is flagged.
- Put the cyber filter rule on its own line under the flagged Advisor, condition first, in one place.
- Report a cyber filter toggle in the configuration notice, with the rule and an override of earlier
  claims.
- Launch Advisors with `consult_advisor` by default: `advisorLaunch` defaults to `tool`, and an
  explicit `role` works as before.
- Read `delegation-policy.advisor-reminders.json` only as a fallback when the level file is absent.
- State the moments to consult as four rules, so mechanics in a settled approach are exempt.
- Send a later consultation only what changed since the previous one in the same task.
- Show `advisor-level`, `advisor-context` and `main-model` in `/delegate status`.

## 0.32.1 - 2026-11-21

### Fixed

- Deliver the policy as one message on every request, so a change reaches the model even when the
  final-payload rewrite does not recognize the payload shape.

## 0.32.0 - 2026-11-21

### Added

- Flag an Advisor whose provider applies a cyber content filter, from its model selector.
- Soften the wording of security briefs to that Advisor, keeping every fact, constraint and scope.
- Let the flagged Advisor keep every other brief exactly as it would be written for any model.
- Store the flags in `delegation-policy.advisor-filters.json`, one boolean per Advisor slot.
- Report each Advisor's `filter=cyber|off` flag in the status line.
- Ignore an unreadable flags file with a diagnostic, and lose the flag silently on a downgrade.

### Fixed

- Show an entry selector's single action above the divider instead of the first model.

## 0.31.1 - 2026-11-19

### Changed

- The policy now claims a public-text deliverable for Writing even when the task also touches code, and
  keeps text with an ordinary role only when it is a by-product of the work that role is already doing:
  commit messages, comments and short summaries. Without that sentence the cost comparison won the
  routing, because almost any task carries some text.

## 0.31.0 - 2026-11-19

### Added

- An optional **Writing** role, with up to three entries of its own, for text other people will
  read: public prose and interface microcopy. It changes only the words, never code, data or
  identifiers, and Visual Design keeps the presentation when the same work changes how something
  looks. It stays outside the cheapest-role comparison, does not count toward the ordinary-role
  minimum, and is configured from `/delegate writing [2|3]` or from its panel row. A reader older
  than this version rejects the whole `delegation-policy.roles.json`, so remove its Writing entries
  before downgrading.
- An Advisor child can load the operator's own extensions. `delegation-policy.advisor-extensions.json`
  names up to two exact `package@version` entries, admitted like a provider extension, and the host
  loads them for every child of the session while an Advisor is enabled, the ContextShunt reader
  included, because the host offers no finer granularity. The launch contract accepts exactly the ids
  that were registered, so an invalid file is ignored with a warning instead of starting a child that
  expects an extension it will not load.

## 0.30.0 - 2026-11-19

### Added

- The optional `Vision` role, for delegated work that must look at image files, with up to three
  exact models. Visual Design accepts up to three too. Entries live in
  `delegation-policy.roles.json`, a separate versioned file, and are configured with
  `/delegate vision [2|3] PROVIDER/MODEL` and `/delegate visual-design 2|3 PROVIDER/MODEL`.
- In a role launch, an Advisor can read, per slot and off by default. The panel asks **Advisor N
  reading** after you choose that Advisor's model, and the flags live in
  `delegation-policy.advisor-read.json`. On, that slot launches
  `pi-delegation-policy.advisor-read`, a profile whose only tool is `read`, so it can open a file or an
  image the brief names; the injected block says so in its role line. The tool is not a path boundary —
  the host's permission rules decide what `read` may reach — and provider-dependent Advisor profiles
  stay tool-free. Reading applies to role launches only: `consult_advisor` always launches the packaged
  profile, so the panel does not offer the step while Advisor launch is `tool`.

### Changed

- A provider-extension Advisor loads its provider package the only way the host allows. The packaged
  profile pins `pi-antigravity-acp-provider` `0.1.21` in `subagentOnlyExtensions` and keeps
  `extensions:` empty, so the child starts with that one package and no ambient extension. The child
  resolves its model and provider before any extension `session_start` runs, so it cannot revalidate
  the package: the checks live in the main session, which reports an admission naming another package
  as an Advisor error instead of serving it. The empty tool allowlist keeps
  `antigravity_acp_permission` away from the model, and a new package or version needs its own profile
  and its own review.

### Removed

- The in-child provider loader. It read the admission and revalidated the package from
  `session_start`, which arrives after the child has resolved its model and provider, so it could
  never serve an extension-supplied model. Its identity, surface and guard checks went with it. The
  main session, the pinned profile and the empty tool allowlist now carry that responsibility, and
  the wiki says so where it used to promise a check in the child.

### Panel

- `/delegate` gains one row per optional entry: `Visual Design 2`, `Visual Design 3`, `Vision`,
  `Vision 2` and `Vision 3`. Each family's first row is always offered and the rest follow the one before
  them; each row resolves its model with the existing searchable selector and offers **Remove entry
  (global)** as its first choice.
  These rows are global settings stored in `delegation-policy.roles.json`, while entry thinking stays in
  that file. A model the host reports as unable to read images still saves, and the panel warns at the
  moment of choosing.
- The `/delegate status` line reports each Advisor entry's reading flag as `reading=on|off` inside its
  `advisor-N=` token.

- The per-role `launches=` report in `/delegate status` gains the new role codes: Vision and every
  extra Visual Design entry keep their own row, so a configured entry that was never chosen stays
  visible at zero like the roles that already did.
- Role selection no longer forwards to Visual Design: the forward reference that produced no launches
  is gone, and the cheapest-role rule now names Small, Medium and Large only. Optional roles are
  outside that comparison, because the reason to configure one is the model, not its price.
- The selection section carries one capability line reporting what the host registry says each
  configured model accepts: `text+image`, `text only`, or `unverified`. A child brief must name the
  files and images it needs, because nothing else travels with the launch.
- An unusable optional entry is a warning that costs only that entry, instead of turning delegation
  into `D:ERR`. The same holds for an unsupported thinking level on an optional entry, including the
  mirrored document `thinking.uiDesign` of Visual Design entry 1: that contract now differs from the
  ordinary roles, where an unsupported level is still a `D:ERR` cause.

### Documentation

- Remove the duplicated documentation and leave each paragraph with one home. `README.md` covers the
  product, install, intensities, roles, commands, and state files. `SECURITY.md` covers the security
  posture, what reaches another model, local records, and reporting. The wiki covers the mechanics.
  The event log now lives once, and the provider opt-ins keep their mechanics in the configuration
  reference with a security summary in `SECURITY.md`. The Advisor contract and the launch check keep
  a short summary in the README with a link. The duplicated event-log field list, the repeated
  Advisor thread paragraphs, and the per-feature version-introduction notes are gone. This file
  already recorded those introductions. The notes that condition a user decision stay where they are:
  the Pi floor, the admitted dependency versions, the schema compatibility, and the downgrade steps.
- `SECURITY.md` no longer says the Advisor is off by default. The Advisor has no model until one is
  configured, and its mode defaults to `with-delegation`, so a configured Advisor is consulted while
  delegation is active. The previous wording could be read as promising that no consultation happens
  without an explicit `on`.
- The wiki described the ContextShunt reader as the guided `pi-delegation-policy.bulk-reader` profile
  with `read`, `grep`, `find`, and `ls`. The launch uses
  `agents/pi-delegation-policy.context-shunt-inline-reader.md`, with empty `tools:` and `extensions:`,
  fresh context, and only the internal `structured_output` result. The bulk-reader profile ships for
  discovery and is never launched by this extension.
- The launch check is documented as running while delegation is active **or** while an Advisor is
  enabled, which is what it does in an Advisor-only session.
- A resumed Advisor thread: the model sends only the new question and `evidence`, while the extension
  supplies the run id and the output path in its own `resume` payload. The host inherits the model and
  the profile.
- The state inventory now names `delegation-policy.provider-extensions.json`, and the schema-7 file is
  described as also holding the ContextShunt configuration.
- The status example follows the real field order and spells out its `advisor-N=` token, including the
  `reading=` field, and the `Get-Content`/`gc` declared-range form is documented for the `bash` tool as
  well as `powershell`.
- `CONTRIBUTING.md` and the pull request template list `npm run pack:check`, the pull request template
  names `consult_advisor` among the explicit launchers, the bug template asks for the operating
  system, and `CODE_OF_CONDUCT.md` is an explicit adaptation of Contributor Covenant 2.1 with a
  reachable private reporting channel.

## 0.29.0 - 2026-11-18

### Changed

- Advisor consultations always run in fresh context. The extension no longer chooses between forking
  the session and sending a brief, no longer tracks context usage to decide, and never adds your
  conversation to the request: each consultation sends the question and the brief you write, and a
  first consultation in a task requires that brief. The thresholds, the automatic return to fork and
  the retry after a rejected fork are gone. A call that asks the host to fork the session for an
  Advisor is refused, so the same value cannot be moved to the child, to `options` or to the top level
  of the call to bypass it. A fork default configured in `pi-subagents` itself stays outside the
  extension's reach: it is not read, and the host would still honour it, so review that setting if
  the Advisor must never see a session.
- Threads keep working as before: the first call in a task launches the packaged profiles with the
  verified contract, and later calls continue each thread with `resume`. Threads recorded by an
  earlier build keep working, and their stored context value is only descriptive.

### Limits

- The Advisor sees only what the brief says. A thin brief now weakens the advice more than before,
  because nothing else reaches it.
- Behaviour was not measured in a controlled before-and-after evaluation.

## 0.28.1 - 2026-11-18

### Fixed

- A stored state file whose path cannot exist, because one of its parent components is a regular
  file, is now read as absent instead of unreadable. Linux reports that case as `ENOTDIR` and Windows
  as `ENOENT`, so on Linux the Advisor reminder's stored mode and its save step, the launch check's
  mode and save step, and the provider admissions read could report an unknown or invalid state
  where the file simply was not there. The same check now covers the stored global configuration,
  its Advisor companion and the copy compared before a save: eight reads in all. The Advisor thread
  bookkeeping keeps its current, fail-closed handling. No other result code, message or panel
  behaviour changed.

## 0.28.0 - 2026-11-18

### Added

- An automatic Advisor reminder, on by default, adds one short extension-owned line to the request
  context at most once per operative task of each instance, so a useful consultation does not depend
  on the user asking for it. It is armed by one successful builtin orientation result (`read`,
  `find`, `grep`, `ls`), presented in the next request, or by the same builtin tool failing in two
  different rounds; a batch is one round, and a retry of the same request keeps the presentation it
  already carried. It is presented only while a valid Advisor is active, the task is live and the
  configured launch mode has its launcher among the active tools, and an attempted consultation ends
  it for that task even when it fails. Only the documented `pi-subagents` process markers
  (`PI_SUBAGENT_CHILD=1`, `PI_SUBAGENT_RUNNER_PID`) exclude a child, so a `/fork` or `/clone` of a
  human session keeps the reminder. It is appended to the request copy only, after the policy
  block and the configuration notice: it starts no turn, child or consultation, writes no session
  entry, and adds no authority. The global **Advisor reminder** row in `/delegate` stores
  `delegation-policy.advisor-reminders.json`, a schema-1 companion with `mode` (`off` or `remind`),
  through the same temporary-file replacement as the other global files; a missing file means
  `remind`, an unreadable or invalid one suspends only the reminder with a diagnostic, and the row
  then reads `Unavailable/Suspended · global` instead of presenting the suspension as a choice.
- `consult_advisor` keeps each Advisor's conversation for the rest of the operative task. The first
  call in a task launches the packaged profiles exactly as before and only that call carries the
  verified launch contract; later calls in the same task continue each thread through the public
  `pi-subagents` RPC `resume`, sending the new question and an optional `evidence` field and
  accepting the answer only from the per-turn output file this extension owns, after the exact new
  run id reports a completed single step with the same agent, model and thinking. A resumed turn
  relies on the contract the host inherits plus those observed values, not on a re-verified digest,
  and any mismatch, timeout or missing answer blocks the thread instead of retrying it or starting a
  silent fresh replacement. Continuity is bounded by the operative task: a fresh user prompt, a
  branch move, a configuration change or the task settling ends it, and a prompt an extension sends
  opens no task at all, so a consultation from one starts nothing.
- A private schema-1 journal (`delegation-policy.advisor-threads.json`) records one turn per parent
  session, task token and original Advisor slot: opaque run ids, the model/profile/admission
  fingerprint, the turn ordinal and a closed reason. It never holds a question, brief, answer, path
  or host error. Each turn is written as pending before anything is sent, accepted before its
  receipt is awaited, and answered before the answer is returned; a per-parent directory lock and a
  short commit lock keep concurrent slots, parents and Pi processes from overwriting each other.
- Every configured Advisor keeps its position and gets an explicit result, so two answers out of
  three report `partial` and never a complete consultation. An unavailable slot keeps its index and
  its own cause instead of disappearing from the group.
- `/delegate advisor threads status|recover|reset` and a `C` row in the `/delegate` panel report the
  continuity state, reconcile a possibly live turn with public terminal proof from the host, and
  abandon threads only when nothing may still be running. Reset never proves that a turn stopped.
- The launch check corrects an unambiguous `subagent` call instead of refusing it. A role name in
  place of a model (`small`, `medium`, `large`, `visual-design`, `ui-design`, `uidesign`, `advisor`,
  `advisor-1` to `advisor-3`, case-insensitive) becomes that role's exact provider/model with a
  level; a role's exact model with no `:LEVEL` gains the role's fixed level, the lowest supported
  level inside its range, or `medium` clamped to what the model supports when it has no policy; and a
  child whose model is exactly one configured Advisor's runs with that Advisor's profile. The
  correction is written into the call the host already validated, so it changes what executes, and
  the extension appends a note to that call's result saying what it applied. Corrections apply per
  child and once to a shared top-level `model`; a call that would resolve differently, or whose model
  fits more than one role or Advisor, is refused instead of guessed.
- `launch` records in the local log carry the closed kinds of correction applied
  (`level-added`, `advisor-profile`, `role-alias`), never a model or a task.
- A global **Launch correction** row in `/delegate` with `correct` (default) and `block`, the test
  mode that refuses every case the check would correct, keeping the pre-correction behaviour for
  measurement. It is global for every session and says so; Apply and Save both store a changed value
  before their own step, Cancel discards it, and a failed write stops the step instead of reporting
  success. The row writes `delegation-policy.launch-correction.json`, a schema-1 companion with
  `mode`, through the same temporary-file replacement as the global defaults: an unreadable or
  malformed file is reported and left alone, and an invalid one is ignored with a diagnostic without
  invalidating the delegation axis.

### Changed

- The injected policy is generated by decision flow instead of by obligation type: purpose, the
  direct-work rule, Advisor checkpoints, role selection, Visual Design, child briefs, launch, role
  lines, results and limits. The numbered `Decision order` is replaced by that flow, and each rule's
  obligation and exception stay together. Intensities, thresholds, role rules, Visual Design
  conditions, brief fields, launch constraints and limits are unchanged and stated in fewer words;
  only the active axes and enabled roles are rendered, so an Advisor-only session still carries
  consultation guidance alone and both axes off still inject nothing. Each enabled role line keeps
  the exact model base, the `pi-subagents` form and its thinking policy.
- The policy's Limits paragraph says the extension corrects an unambiguous call and reports what it
  applied, and refuses only what it cannot settle. It also names the measurement mode, where a call
  the normal check would correct is refused instead.
- The policy block adds a **Child briefs** section while delegation is active: the bounded outcome and
  its owner, the context already decided, scope and permissions with exclusions, how the result is
  verified, what the child returns and where, and when it stops to ask. An unresolved decision stays a
  question the child may answer instead of a settled invariant, and a host agent name such as `worker`
  or `reviewer` does not replace the model role. One emphasis line and one example follow per enabled
  role only, so the section adds no threshold, permission, ownership rule, or new Advisor consultation
  guidance.

### Verification

- The full suite passes: 335 tests, 332 passing and three skipped when their external fixtures are
  absent. That covers the mechanism: rendering, stored files, refusals, thread continuation and
  reminder timing.
- Behaviour was not measured in a controlled before-and-after evaluation, so this release does not
  claim that the model delegates or consults better than 0.27.0. What it claims is narrower and
  checked: the policy renders as described, the launch correction applies only the three
  unambiguous cases and refuses the rest, the brief guidance and the Advisor thread work, and the
  reminder appears once per task under the conditions listed above. Version 0.27.0 stays available
  if the new behaviour does not suit you.

## 0.27.0 - 2026-11-16

### Added

- Two content-free events in the local log. A `task` record summarises one main-agent task, from the
  user prompt to the next settle: duration, tool calls, edits, the position of the first edit and of
  the first consult, whether the consult came before the first edit, and subagent launches and
  refusals. A `launch` record covers one `subagent` call that launches children: allowed or refused,
  a closed refusal code, child count and one role code per child. Control actions such as
  `{action:"status"}` record nothing, a call that launches only Advisors counts as a consult and not
  as a launch, and both records repeat the policy hash they ran under. `advisorConsults` counts
  attempts: a `consult_advisor` call counts whether or not it reached a model.

### Fixed

- The Anthropic auth profile admits the exact managed-user `@gotgenes/pi-anthropic-auth` 3.6.0
  alongside 3.4.3 and 3.4.4. Its surface, single entry and provider registration are the ones the
  adapter already checks, and it registers after an awaited import, which the host waits for. Other
  versions stay rejected, and an unavailable install still leaves the dispatch guard closed.
- A launch refusal names a configured Advisor that failed validation instead of describing it as
  unconfigured. A `Configured but unavailable:` section lists each such slot with the reason the
  runtime already computed. The refusal decision is unchanged.

## 0.26.0 - 2026-11-10

### Added

- Launch check. While delegation is active, a `subagent` call is refused before it launches when a
  child has no model, a model that is not its role's, a missing or disallowed thinking level, or an
  Advisor profile with another model. Parallel tasks and chain steps are checked one by one, with a
  top-level model applying to children without one. Workflow scripts, inline or through
  `options.script`, are refused because their models are not visible. Management actions pass. The
  refusal lists the accepted launches. The check covers every `subagent` tool call in the session,
  including ones other skills request, such as council mode's workflow script.
- The Anthropic auth profile also admits `@gotgenes/pi-anthropic-auth` 3.4.4, which changed only
  documentation.

### Changed

- The policy's Limits paragraph now describes the launch check instead of saying the extension
  cannot enforce anything.

## 0.25.0 - 2026-11-04

### Added

- Admitted provider extensions for Advisors. Choosing a model whose provider only an extension
  supplies offers your installed packages in `/delegate`; the admission is global and per provider,
  stored in `delegation-policy.provider-extensions.json`, and the new profile
  `pi-delegation-policy.advisor-provider-extension` loads that one package in the child. Only the
  package identity is checked before it runs; it is trusted code, not a sandbox.
- `/delegate status` warns about an Advisor whose provider an extension replaced in this session
  and that has no admission. The Advisor stays consulted.

### Compatibility

- No state schema change. 0.24 and earlier ignore the admissions file and launch the standard
  profile for those Advisors.

### Limits

- No real-provider consultation was run through the new profile. Startup was checked with a real
  provider extension, without network or requests; authentication, requests, compaction and
  retries in a real child are not validated.

## 0.24.0 - 2026-11-03

### Added

- A third Advisor. `/delegate` shows **Advisor 2** once Advisor 1 exists and **Advisor 3** once
  Advisor 2 exists, and `/delegate advisor 3 model PROVIDER/MODEL` configures it. Every valid
  Advisor gets the same question, so each extra one adds a consultation at every checkpoint.

### Changed

- Advisor thinking is no longer a setting. Role launch lets the main agent choose the level per
  run; tool launch uses the highest level the model supports among `high`, `medium`, `low`,
  `minimal` and `off`, where it used to fall back to the first supported level.
- The Advisor profile is chosen together with the model: picking an `anthropic` model asks for
  **Standard** or **Anthropic auth**. With two Advisors the panel shows five Advisor rows instead
  of eight.
- `/delegate advisor N thinking …` is removed and now reports that Advisor thinking is automatic.
- At most four children can run at once: three Advisors and the ContextShunt reader.

### Compatibility

- A saved Advisor thinking policy, per entry or legacy `thinking.advisor`, still has to be well
  formed but is ignored and dropped on the next save. No diagnostic is shown for it. In tool launch,
  an Advisor that was fixed at a lower level now runs at `high` when its model supports it, which
  can raise cost and latency.
- Saves with one or two Advisors stay readable by 0.21–0.23 as before.
- No schema change. Versions 0.21–0.23 fall back to Advisor 1 when a save holds three Advisors,
  or turn every Advisor off when one uses Anthropic auth, as before. Saving from one of them drops
  Advisors 2 and 3.

## 0.23.3 - 2026-10-31

### Fixed

- The role-mode reply from `consult_advisor` starts with `Not an error:` and limits its instruction
  not to call the tool again to the time when Advisor launch remains `role`.
- The reply names the exact active host tool `subagent`, discovered at invocation time through Pi's
  public tool API. If it is absent or inactive, the reply tells the model to inform the user that it
  cannot launch the Advisor and not to improvise foreground execution, a CLI or another agent.

### Compatibility and verification

- Only the role-mode tool result changes. Tool definitions, the policy block and all other replies
  remain unchanged from 0.23.2. No configuration migration, dependency, profile, model, permission or
  Pi minimum change; upgrade and reload as usual.
- Registered-tool tests cover the exact launcher name, its absence and changing availability within
  one runtime. The existing definition-identity test remains unchanged and passes. These checks do
  not measure provider cache hits or establish real-model behavior with the new wording.

## 0.23.2 - 2026-10-31

### Fixed

- `consult_advisor` now tells the model what to do for the effective Advisor state instead of
  suggesting a switch to tool mode. Off means no consultation; role mode redirects to one background
  host subagent call with every valid Advisor's exact profile, model and thinking policy, and says
  not to call this tool again. Unavailable entries report their existing diagnostics. Invalid saved
  Advisor settings explicitly require informing the user to save them again in `/delegate`, without
  retrying the tool; ordinary availability errors do not ask for configuration changes.
- Busy, blank-question and missing-session replies now state the next action. ContextShunt recovery
  errors also explain whether to use another range, obtain live evidence or continue without recovery.
  The reader's JSON error contract is unchanged.

### Compatibility and verification

- No configuration, schema, dependency, profile, permission or Pi minimum change. Upgrade and reload;
  no migration is needed. Tool definitions stay fixed across modes and requests. The tool description
  changes once on upgrade, but no additional policy-block or tool-definition variation is introduced.
- Registered-tool tests cover off, role, invalid and valid tool calls, exact thinking rules and stable
  definitions. Saved-state guidance is tested at the message constructor without corrupt files; its
  connection to the registered tool was reviewed. Policy output was independently checked byte for
  byte against the previous release. These checks do not measure provider cache hits or establish
  real-model behavior after an accidental role-mode tool call.

## 0.23.1 - 2026-10-29

### Fixed

- Advisor and ContextShunt reader launches no longer reject later `pi-subagents` releases solely
  because their package version is not on an exact list. Both require a valid stable SemVer version
  `>=0.76.1`, with no upper bound. Prereleases, invalid versions and non-string values are rejected;
  build metadata does not affect precedence.
- All other launch checks remain unchanged: contract and lifecycle version 3, definition projection
  version 2, packaged profile and shadowing, exact model and thinking, tool and extension lists,
  permission runtime, session identity and terminal digest binding. An incompatible preflight
  still fails closed before a request is sent; a terminal mismatch still discards the reply.

### Compatibility and verification

- Pi `0.87.1` remains the package minimum. No dependency, configuration, schema, provider option or
  permission change. Upgrade and reload; no configuration migration is needed.
- The final loader was exercised against real `pi-subagents` `0.84.0` exports with a synthetic event
  host on Pi `1.4.0`: Advisor fresh/fork and reader fresh completed with terminal binding. This
  checks admission, not real child execution, provider transport or personal permission rules.
  Version labels are not signatures or a guarantee of future compatibility.

## 0.23.0 - 2026-10-29

### Added

- An optional Anthropic provider extension for each Advisor. The native provider selector chooses the
  separate `pi-delegation-policy.advisor-anthropic-auth` profile without changing the configured model,
  thinking, background role behavior, standard Advisor profile or ContextShunt reader. Only an exact
  managed-user installation of `@gotgenes/pi-anthropic-auth` 3.4.3 is admitted. Its normal configuration,
  startup hook, aliases and account diagnostic command remain trusted host code; the diagnostic is
  never invoked automatically. No provider package is bundled or installed by this extension.
- Schema 10 stores the per-Advisor `providerExtension: "anthropic-auth"` opt-in. Schemas 2–9 migrate in
  memory without surprise writes. When any opt-in is saved, companion envelope 2 binds the full state
  to an Advisor-off schema-8 base: downgrading through 0.22.2 leaves all Advisors off instead of
  silently choosing the standard profile. Ordinary delegation and the reader are preserved; saves
  without an opt-in retain envelope 1.

### Fixed

- Changing an Advisor model through the command or panel preserves its provider option. An
  incompatible provider reports an Advisor error rather than silently removing the opt-in.
- Provider choices stay visible in short, narrow terminals; Enter and Escape retain their normal
  apply/cancel behavior. An invalid companion now reports that Advisor remains off when that is the
  actual restored state.

### Compatibility and verification

- Pi 0.87.1 or later remains the package minimum. Missing public APIs disable only the optional
  provider path. Advisor launch contracts still admit exact pi-subagents 0.76.1/0.83.1; the reader
  remains limited to 0.76.1. No ambient extensions, model fallback or permission bypass is added.
- One bounded fresh/background real-provider consultation with the new profile completed on
  Pi 1.4.0 and pi-subagents 0.83.1. Metadata showed only the prompt runtime and provider bridge, no
  required child extensions and no observed tool calls. This does not validate fork, consult_advisor,
  other builds or permission runtimes, or establish a sole cause of the earlier failure. Provider
  code is not sandboxed, version labels are not signatures, and resolution-to-load races remain.

## 0.22.2 - 2026-10-28

### Fixed

- The Advisor no longer rejects a verified `pi-subagents` build. Each launch definition now declares
  the exact list of package versions whose launch contract it was checked against: the Advisor admits
  `0.76.1` and `0.83.1`, while the ContextShunt reader keeps its single verified `0.76.1`, so the
  reader limit does not widen. Everything else in the launch check is unchanged: exact profile
  projection and digest shape, exact model and thinking, host session binding, empty tools and
  extensions, the pinned `@gotgenes/pi-permission-system` `33.0.3` runtime, and the terminal digest
  binding. A build outside the list still fails closed before any request is sent.

  The two contracts were compared from their real preflight payloads: they differ only in the package
  version, the install path of the runtime extension and the digests derived from that path, and the
  public fork wrapper is byte-identical. Admission and terminal binding were exercised in an isolated
  host that answered with each contract's own digest. That does not cover provider transport, real
  child execution or a real consultation, which remain unverified, and it does not explain the
  Advisor failure reported on a forked session or the menu/status discrepancy; both stay open.

## 0.22.1 - 2026-10-22

### Fixed

- The footer no longer keeps a stale `D:ERR` from session start when an ordinary model becomes
  available only after this extension's `session_start` handler. Another extension may fill the model
  catalog in its own start handler, and the host then emits `resources_discover`; a read-only runtime
  refresh there repaints the footer with the existing validation. This adds one configuration/branch
  read and footer refresh per session bind or reload, returns no resource paths, makes no network
  call, and leaves the configuration-change notice reference alone, so a pending change is not lost.
  A model that is genuinely missing or unusable still reports `D:ERR`. The fix relies on the public
  post-start discovery order, verified in Pi `0.87.1` and `1.1.0`; availability changes after that
  event still refresh on the next request or menu action.

## 0.22.0 - 2026-10-21

### Added

- One ephemeral configuration-change notice on the next user turn after an effective configuration
  change, whether a `/delegate` save or an edit of the global defaults that reaches the session. It
  lists the values that changed since the configuration the model was last shown: intensity,
  preference, ordinary roles, Visual Design, thinking policies, Advisor entries, mode and launch, the
  ContextShunt mode, and the reader role, toggle and answer limit. The ContextShunt enforcement
  tuning (`limits`, `exceptionPatterns`, `delegationHintPatterns`) is left out on purpose: it changes
  how much the shunt preserves or compacts, not the assignments the model follows. The notice exists
  only in the requests of that turn, never in the conversation, and stays identical across their
  retries. With both axes off by configuration it reports one line,
  `Delegation and Advisor disabled by this policy.`, and then injects nothing; an Advisor left on but
  unusable is not reported as disabled.
- The reference is the configuration the model was actually shown. Changes made before a turn are
  grouped, a reversion reports nothing, an edit that leaves effective values unchanged reports
  nothing, and a change made while a turn is running waits for the next turn. The notice is consumed
  when the run ends with its last recorded outcome completed, read from the final `agent_end`, so a
  retried error that then succeeds consumes it while an error or abort reported before that point
  leaves the change pending. Residual: an abort or a thrown error after the last successful response,
  which the host reports through no later public event, can still consume it. Session starts,
  reloads, forks and tree moves set the reference silently, and a prompt another extension sends with
  `sendUserMessage` neither receives nor consumes the notice.

### Compatibility and verification

- No configuration, schema or dependency change. The notice uses public Pi `0.87.1` events,
  is converted to user text by the host like any custom message and identifies itself as an extension
  notice; it is not system policy and changes no model, permission or authority. The extension writes
  no notice text to session history or its local log. This does not limit request retention by the
  provider or other authorized host components. The existing local JSONL log keeps its fields.
- Covered against the registered hooks with a synthetic host: grouping and reversion, no-op saves,
  retries, a mid-turn change, a completed turn followed by a failed continuation, error and abort, an
  unknown run outcome, the accepted abort/throw window after a completed response, the both-off
  notice, an extension-sent prompt, session and tree resets, global changes, the Advisor context mode,
  and the real host conversion and payload repair. No real-provider run was performed. The synthetic
  host encodes Pi `0.87.1`'s event order instead of exercising a host process, so a future host that
  reordered `input` and `before_agent_start` would not be detected.

## 0.21.1 - 2026-10-19

### Fixed

- Accept valid Advisor replies in fork context. Preflight now uses the public executor wrapper to bind the same task that the host executes, while the emitted question and strict result identity checks remain unchanged. Version 0.21.0 discarded successful fork replies because the task digests differed.
- Explain Advisor launch failures instead of returning only `Advisor failed`. Messages distinguish missing launch prerequisites, preflight failures, timeouts, mismatched result identity, and unusable answers. If the host supplies no safely displayable cause, the message says so; raw errors, prompts, paths, and secrets are never copied into replies or the local log.

### Compatibility and verification

- No configuration or schema migration. Pi `0.87.1+` and the exact `pi-subagents` `0.76.1` executor requirement are unchanged. Reload after upgrading.
- The regression is covered against a synthetic host matching the installed executor, including rejection of a genuinely mismatched digest. A real-provider fork check remains pending after installation.

## 0.21.0 - 2026-10-19

### Added

- Schema 9: one or two ordered Advisors with independent exact models and thinking policies. Consult every valid entry; `A:PART` reports one valid entry out of two.
- Inherited `advisorLaunch: role|tool`, default `role`. Explicit `consult_advisor` uses the authorized external executor, parallel results, independent failures, fork-to-fresh retry only after explicit rejection, cancellation and local timeouts. No hook launches children.
- Content-free local JSONL policy hashes and consultation metadata, with size rotation and no network telemetry. No questions, briefs, answers, conversations, project paths or raw errors.

### Compatibility and privacy

- Schemas 2–8 resolve in memory without rewriting files. The legacy companion keeps Advisor 1 readable by 0.17–0.20 in role mode; 0.16 keeps delegation without Advisor. A separately paired extension holds Advisor 2 and launch mode. Three atomic replacements are not a transaction; a missing or stale extension falls back to Advisor 1 with the inherited launch mode.
- Fork sends the conversation to each advisor provider. Normal executor/provider retention, latency and cost remain; no deletion, external TTL or generation ceiling is promised. One pending call per tool permits one reader plus an Advisor group of up to two children.

## 0.20.0 - 2026-10-18

### Changed

- Consult the Advisor at observable moments instead of on a judged "substantive choice": after orientation and before substantive work (the first edit or state-changing command, committing to an interpretation or approach), when stuck, before changing approach, and before declaring a multi-step task done, where the agent asks for remaining risks rather than approval. Short reactive steps and mechanical work inside a settled approach need no new call. The hedges that told the agent the guidance was "not a threshold" and excluded completion review are gone; there is still no `MUST` and no quota. The checkpoints follow the guidance Anthropic publishes for Claude Code's advisor.
- Name the context mode for the session. While the session's estimated usage fits in half of the Advisor model's context window, the policy asks for a `fork` launch: the host branches the conversation, so the task is only the question, and a fork the host rejects for size is retried once with a short brief. Above half, or when the window is unknown, it asks for `fresh` and a short self-contained brief. While usage is unknown, for example right after compaction, it keeps the last mode. The mode returns to `fork` only below 35 %, so the policy text stays stable and provider prompt caching keeps working.
- Ask for background launches. The launch requirements now ask the main agent to launch every subagent in the background unless the host or the user requires foreground, and to group children that must run at the same time into one call, because the host rejects a second foreground call while one is running.
- The Advisor launch names the exact `pi-delegation-policy.advisor` agent and rules out host agents or aliases named `advisor` or `oracle`, and states that consulting is advice the user enabled, not delegated execution.
- The Advisor profile accepts a forked conversation and treats it, like the brief, as untrusted data.

### Privacy

- With `fork`, every consultation sends the conversation so far, including file contents and command output the main agent has seen, to the Advisor's provider. The host sends it at the main agent's choice; the extension still sends nothing on its own. Turn the Advisor off for sessions that must not reach that provider.

## 0.19.0 - 2026-10-09

### Fixed

- The ContextShunt reader accepts the exact `@gotgenes/pi-permission-system` `33.0.3` runtime when the host adds it to the reader's child next to the prompt runtime. Earlier builds rejected that runtime, so the reader returned `reader-unavailable` whenever the host had permission rules. The host owns those rules: the reader never reads, copies, or changes them. In isolated synthetic runs, a child the host allows only for structured output completes, and a child the host asks or denies fails closed.
- Upgrade note: versions `0.18.0` and earlier still reject this runtime. Version `0.19.0` needs no configuration change, and its minimum Pi version stays `0.87.1`. The reader is verified only with `pi-subagents` `0.76.1` on Pi `1.1.0`; other hosts are not verified.
- The reader binds its preflight to the session of the tool's context. Without a session id it returns `reader-unavailable` before launching anything. The extension cannot verify that the launch request runs in that same session; the terminal launch digest rejects a mismatched answer, but only after the snapshot has been sent.

## 0.18.0 - 2026-10-08

### Fixed

- Restore the ContextShunt reader with `pi-subagents` `0.76.1`. The reader accepts only that build's launch contract: the packaged profile, the prompt runtime as its only extension, no inherited global context, no required child extensions, and the child's Intercom bridge off. Any other build fails closed with `reader-unavailable` before a request is sent.

### Changed

- Ask the main agent not to paste workflow scripts, child briefs, or other internal orchestration material into the chat. Scripts stay in private files and are launched by path. The instruction applies to normal, aggressive, and orchestrator intensities; delegation off still injects nothing.

### Compatibility and limits

- Breaking for the reader: `pi-subagents` `0.69.0` no longer works with it and returns `reader-unavailable`. Upgrade the external executor to `0.76.1`. The extension's Pi minimum, `0.87.1`, is unchanged.
- Verified only on Pi `1.1.0` with `pi-subagents` `0.76.1`, in an offline loopback harness with a synthetic provider. Pi `0.87.1` is not verified for the reader, and no real provider was used.
- A child that loads a permission extension is rejected, so the reader returns `reader-unavailable`. This path was not exercised with pi-subagents permission rules.

## 0.17.0 - 2026-10-07

### Added

- Configure Advisor independently with `advisorMode: off|on|with-delegation`, the panel, or `/delegate advisor`. Explicit `on` permits consultation with delegation off (`D:OFF A:ON`) without ordinary roles. An omitted mode preserves the previous coupling; `off` keeps the saved model and thinking policy without validating or injecting consultation guidance.

### Fixed

- Isolate errors by axis: an invalid enabled Advisor removes only consultation, and invalid delegation does not suppress a valid enabled Advisor. Status and the panel show `D:* A:OFF|ON|ERR`; unreported configuration diagnostics remain visible without becoming Advisor errors.
- Stop global saves before writing when either previous settings file cannot be read. If the companion write fails, attempt restoration and verify both files before reporting no changes; otherwise report a partial save and reload the observable state.
- Preserve Advisor model and thinking from readable, valid but mismatched companions while silencing consultation. Compare normalized delegation projections rather than raw-text digests, so reformatting does not invalidate the pair.
- Keep an older session's explicit removal of Advisor from inheriting a newly enabled global Advisor. Reset, invalid restoration, and interrupted session saves disable both axes.

### Changed

- Rewrite the README and wiki around setup, modes, role thinking, commands, persistence, downgrade, and privacy.

### Compatibility and limits

- Requires Pi `0.87.1` or later. Current state uses schema 8, but saved delegation remains schema 7, with Advisor in a companion. The actual `0.16.0` reader retains delegation after downgrade; earlier readers keep their existing limitations. Loading migrates only in memory.
- Global settings use two individually atomic replacements, not a transaction. A hard stop can leave a mismatched pair with Advisor off; concurrency checks are not locks, and another writer can change a file between a check and a replacement.
- ContextShunt remains suspended with delegation off. The extension does not launch Advisor from hooks, change the host executor, or alter the main model or thinking. Consultation still carries normal executor/provider retention, latency, and cost.

## 0.16.0 - 2026-10-06

### Changed

- Favor a brief consultation whenever the work presents a substantive choice, not only when the main agent notices doubt. With an advisor configured, step 1 of the `Decision order` and the `Advisor consultation:` section now cover an approach, a scope, the acceptance criteria, a comparison between options, or a decision. The policy no longer asks the main agent to recognize a doubt, a proposal or alternatives first, and no longer asks it to predict whether the second opinion would change the decision; its own confidence is not a reason to skip the call.
- Remove the generic escape hatch "routine decisions need none" and replace it with one concrete limit: a local detail with no effect on an approach or a solution already fixed needs no call. The existing examples — viable approaches trading off explicit requirements, evidence supporting conflicting explanations that call for different actions, and changes with destructive data operations, difficult rollback or compatibility breaks — stay as examples, not a closed list.
- Say how to brief and reuse the advisor. The brief puts the objective, the constraints, the facts and the open choice first and the proposal and reasons after, without hiding decisive data; a decisive local fact is verified instead of guessed; the agent asks for an approach, criteria or critical assumptions rather than approval or a forced list of defects, and a short reply can be enough. A follow-up continues the same thread through the host's resume mechanism on a material discrepancy or gap, the advice is reused while the decision and its assumptions hold, and it is reopened only on new relevant evidence rather than on every turn, phase or tool call.
- Distinguish choosing a solution, executing a decision already fixed, checking a verifiable fact, and the preferences or authorizations reserved to the user. The advisor helps compare, recommend and decide; the decision and its responsibility stay with the main agent, and the user keeps their own preferences and authorizations.

### Compatibility

No configuration, schema, model, thinking or permission change. The packaged profile, the exact references and the retention statements are unchanged.

## 0.15.1 - 2026-09-27

### Fixed

- Re-apply the marked policy block in the final provider payload. Pi `0.87.1` projects a forced system prompt after `context_with_system`, so an extension that returns `systemPrompt` from `before_agent_start` could drop the block before the request left. The `before_provider_request` hook now rebuilds the current effective policy on every final invocation and rewrites only the owned block inside the instruction fields of the provider shapes the adapters use. A payload whose shape is not recognized is left untouched.
- Read the effective policy on the final request instead of reusing the state loaded by the previous context hook, so a change to global defaults or to the session branch between requests applies without a new context hook.
- Remove only the instruction containers this extension's own removal emptied. `off` no longer leaves an empty system block behind, a foreign empty container stays, and no instruction role is synthesized.
- Restore the paragraph break the owned-block pattern consumes when the block sat after other text, so foreign instructions keep their layout.

### Changed

- Refresh the effective state once per provider request. If that reload fails, the last loaded state is used so the repair is not lost.

## 0.15.0

### Changed

- **Breaking:** Require Pi `0.87.1` or later. The extension refreshes its marked policy block through `context_with_system` before each LLM request, so changes made during a turn affect the next request. The former `before_agent_start` path is removed. Pi `0.84.3` and `0.85.1` are no longer supported, and there is no fallback for older hosts.

## 0.14.1 - 2026-09-21

### Changed

- Say that the advisor consultation comes before investing effort, not after finding results. The step 1 added in `0.14.0` asked the main agent to evaluate a second opinion before committing to an approach, but the first real session after that release read it as permission to save the consultation for later: it decided to "keep the question for when I have findings" and used the advisor as a validator of finished work. By the time it consulted, the advisor corrected its main conclusion. The step now names that deferral as the mistake to avoid. No new obligation: a routine decision still needs no call.

## 0.14.0 - 2026-09-21

### Changed

- Put the advisor consultation rule where the main agent reads procedure. It is now step 1 of the numbered `Decision order` and has its own `Advisor consultation:` section, instead of a paragraph inside the intensity rule that the decision steps never mentioned. Consulting is still a signal, not a quota.
- Replace the advisor's self-assessed triggers with observable ones. "An ambiguous decision", "one that is hard to undo", "a risk the main agent cannot resolve alone" and "a substantial doubt about architecture, plan, tooling or approach" all asked the main agent to notice its own doubt, and the same paragraph offered "routine decisions need none" as the way out. The signals are now features of the work: viable approaches trade off explicit requirements; evidence supports conflicting explanations that call for different actions; or a proposed change involves destructive data operations, difficult rollback, or compatibility changes for existing consumers. Public delivery surface is deliberately not one of them, because ordinary public changes are routine.
- Soften the rule for decisions that belong to the user. The main agent now considers the advisor before asking when its advice could improve the options, trade-offs or recommendation it presents, rather than consulting the advisor first.

## 0.13.0 - 2026-09-20

### Added

- Add the Advisor as a full policy role, configured in `/delegate` like the others: one exact `provider/model` reference in global defaults, or `null` in a session override to turn it off, plus its own optional `thinking.advisor` policy. When `advisor` is configured and valid, the injected policy states when consulting it is worth it — an ambiguous decision, one that is hard to undo, a risk the main agent cannot resolve alone, or a substantial doubt about architecture, plan, tooling or approach — and, when a decision belongs to the user, to consult the advisor first for options, trade-offs and a recommendation to bring together with the question. Those are triggers with clear conditions, not a quota: routine decisions need no call, and nothing forces one.
- Require a self-sufficient brief. The advisor cannot see the conversation, read files, or use tools, so every brief carries the objective and the decision, the constraints, the current state and the relevant evidence, the options and their consequences, what was tried or is proposed and why, and the open uncertainty. It is a conversation rather than a single ruling: the main agent continues the same thread through the host's resume mechanism to clarify, challenge or go deeper, and does not restart it for the same matter.
- Ship that advisor as the packaged profile `pi-delegation-policy.advisor`, with no tools and no extensions. It cannot read files, run commands, delegate, or reach the network, and it returns plain text for the task the main agent writes. Pi's subagent mechanism discovers it and launches it as a normal subagent with the exact configured model and that role's thinking policy, so the advisor appears in the roster and fleet like any other subagent.

### Changed

- **Breaking:** the Advisor is no longer a tool. `advisor_ask` and its automatic conversation window are removed, hours after `0.12.0` published them. `src/advisor-executor.ts`, `src/advisor-context.ts`, its six error codes, its 12288-byte aggregate cap, its exclusion rules, and its busy guard are gone with it. The reason: the advisor becomes a normal, visible and resumable subagent instead of a second private launch path with its own hermetic contract, and the extension goes back to launching exactly one thing, the ContextShunt reader.
- The extension no longer sends conversation on its own initiative. What reaches the advisor's provider is what the main agent writes into the task, through the same host-authorized external executor, with the same retention statement and no promise of deletion. The bounded window, its 12288-byte cap, its exclusions, and `advisor-busy` no longer exist, and public documentation no longer describes them.

### Removed

- Remove the `advisor_ask` tool registration, its authorization, counters, and lifecycle cleanup from `src/index.ts`, together with its tests and its package-content and boundary-scan entries. A configured advisor whose model is invalid still produces `D:ERR` and injects no policy, and that shared check still leaves the ContextShunt reader unauthorized.

## 0.12.0 - 2026-09-20

### Added

- Add an optional `Advisor` role with its own model reference and thinking policy. It is off by default, does not count as an ordinary role, and configures like Visual Design: an exact reference in global defaults and `null` only as a session override. Configuring no advisor changes nothing: no extra policy text and no new requirement.
- Add the explicit `advisor_ask` tool: a required `question`, optional `context`, and the `thinking` level for that call, answered with at most 8 KiB of plain-text advice plus the model and the level that produced it. Advice over the cap becomes a bounded error with no artifact or recovery surface. Failures use six bounded codes — `advisor-unavailable`, `advisor-invalid-request`, `advisor-busy`, `advisor-failed`, `advisor-timed-out`, and `advisor-cancelled` — that carry no paths, content, or secrets. One request per explicit tool may be in flight, so a busy advisor neither cancels nor disturbs an in-flight ContextShunt reader request.
- Add the Advisor model and thinking rows at the end of the `/delegate` panel and the `advisor=` and `thinking-advisor=` tokens to `/delegate status`, without renaming or renumbering existing tokens.

### Changed

- Raise the written schema to version 7 for the top-level `advisor` key. Defaults and session entries from schemas 2 through 6 are still read and normalized in memory without rewriting them, and a document that declares an older version is rejected if it carries `advisor` or `thinking.advisor`.
- State what `advisor_ask` sends. The request is a bounded window of message text — your messages and the agent's own text, with images replaced by `[image omitted]` — one line per tool call, and the advisor thread rebuilt from the history, capped at 12288 UTF-8 bytes together with the question and extra context. A tool line names the declared path or pattern for `read`, `grep`, `find`, and `ls` only, capped at 256 bytes; every other tool contributes its name alone, never its arguments. Tool results, shell executions, extension-injected messages, compaction and branch summaries, non-message entries, and the agent's thinking are excluded.
- Document that a configured advisor whose model is missing, out of scope, or unauthenticated produces `D:ERR` and injects no policy, and that the shared validation also leaves the ContextShunt reader unauthorized until the configuration is corrected. The coupling is a deliberate, documented consequence.
- State the advisor's current evidence accurately: its plain-text path has been exercised end to end in a real session against a configured provider, including the conversation thread and the busy guard, but no packed matrix covers it, so its launch contract is otherwise checked against a simulated preflight.
- Pin the external executor protocol version to `0.69.0`, the build actually exercised, and align the launch validator with that build's contract shape: contract version `3` and definition projection version `2`, taken from `src/api/preflight.ts` and `src/shared/launch-contract.ts`. The same build removed its `modelCandidates` field when it moved to one resolved model per launch, so the exact single `model` it reports replaces that equality: a substituted or downgraded model still fails, the remaining equalities are unchanged, and an older or newer contract is still rejected. Another executor build still fails closed.

### Security

- Extend the privacy boundary to conversation extracts: the advisor request and its reply may persist in the executor's argv, temporary files, sessions, and lifecycle records, and at the model provider. No deletion or external TTL is promised.
- An older package that cannot read schema 7 treats the document as invalid and falls back to `off` with a diagnostic. That is a fail-closed stop, not a smooth downgrade; the new role and tool simply do not exist there.

### Documentation

- Document the ContextShunt reader in the README and the documentation site: its two tools, the settings that enable it, what one request sends, the bounded answer with citations, and its limits. The reader requires a compatible external executor; protocol version `0.69.0` is the verified one, and another build fails closed with `reader-unavailable`, with no answer and no fallback.

## 0.11.1 - 2026-09-16

### Changed

- Show one row per setting in the `/delegate` panel instead of two, and move the focused row's description and provenance into a single hint block under the list, so the list no longer spends half its height repeating the same sentences. Values are aligned in one column, and thinking values show `unset`, a level, or `min..max` with the provenance in the hint.
- Mark a truncated line in the effective policy preview with an ellipsis instead of cutting it silently.
- Update the maintained development toolchain: the Pi packages to `0.85.1`, TypeScript to `6.0.3`, and the wiki to Astro 7.3.2, Starlight 0.42.0 and the patched `js-yaml` 4.3.2. The Pi peer range stays `>=0.84.3`, so `0.84.3` remains the minimum supported version; the explicitly checked baseline is now Pi `0.85.1`. Nothing in the published behaviour changes.

## 0.11.0 - 2026-09-16

### Added

- Add an optional thinking policy per role in a top-level `thinking` object. `{ "level": "high" }` fixes one level for every launch of that role, and `{ "min": "low", "max": "high" }` lets the main agent choose inside an inclusive range; a role with no policy keeps the per-launch choice. The extension validates a configured level against the role's resolved model and reports a level the model does not support as a new `D:ERR` cause with no injection. The extension persists the configured policy, never the level chosen for an individual run. Configurations without `thinking` keep working unchanged.
- Add four thinking rows to the `/delegate` panel and one `thinking-<role>` token per role to `/delegate status`, both reporting the policy and its source.

### Changed

- Raise the written schema to version 6. Defaults and session entries from schemas 2 through 5 are still read and normalized in memory, keep no thinking policy, and are not rewritten; a package that cannot read schema 6 treats the document as invalid and falls back to `off` without injection.
- Present the injected policy with an explicit decision order and labeled sections, so each rule's obligation and exception are stated together. Thresholds, precedence, exceptions, and role semantics are otherwise unchanged; the previous limits sentence is restated more precisely as non-enforcement at runtime.

## 0.10.0 - 2026-09-08

### Changed

- When optional Visual Design is configured and a delegated visual portion meets all four existing eligibility conditions, select it before Small, Medium, or Large with its exact configured model and per-run thinking. Reevaluate eligibility for every task or phase; this priority does not make `normal` or `aggressive` delegate more work.

## 0.9.1 - 2026-09-08

### Fixed

- Make ContextShunt declared-read limits line-based, measure known textual results with real UTF-8 bytes and shared newline handling, and keep rejected requests out of the admitted-request window.
- Keep the one-time `allow TOKEN MAX_LINES MAX_BYTES` command while binding its authorization to one tool call and immutable input snapshot; enforce its byte maximum against the real result.
- Continue accepting the deprecated schema-4 `readerOutputBytes` field for compatibility while ignoring it, omitting it from new saves, and removing its inert panel control.

## 0.9.0 - 2026-09-07

### Added

- Add opt-in ContextShunt schema 4 settings, keyboard-first mode selection, recognized read and conservative PowerShell range enforcement, and bounded recovery of preserved known textual results.
- Include the guided `pi-delegation-policy.bulk-reader` read-only profile with `read`, `grep`, `find`, and `ls`; compatible executors can discover it from the package, but it is not copied or launched automatically.

### Security

- Keep ContextShunt off by default and preserve original results when a temporary artifact cannot be created. Temporary artifacts use opaque IDs, quotas, cancellation checks, an absolute 30-minute TTL from creation, scheduled cleanup while the process is active, and cleanup at session shutdown. Recovery does not renew the TTL; crashes and OS suspension can delay deletion.

## 0.8.0 - 2026-09-07

### Changed

- Tighten `orchestrator` guidance to require delegation before all transferable execution, including detailed review and integration mechanics; require waiting for and consuming pending results, concrete gap-only reinspection, and a brief exception before minimum direct work. Size, triviality, convenience, economics, transfer cost, and final-review or integration labels are not bypasses. The published `0.7.0` policy remains unchanged.

## 0.7.0 - 2026-09-06

### Added

- Add the `orchestrator` intensity with `/delegate orchestrator` and `D:ORCH`. It delegates transferable research, detailed planning, implementation, testing, writing, review, and integration mechanics while keeping objectives, critical decisions, coordination, evidence, and final acceptance with the main agent.
- Add orchestrator guidance for batching small work, concise briefs and results with file references, and avoiding duplicate inspection without a concrete gap or risk.

## 0.6.0 - 2026-08-29

### Added

- Allow Small, Medium, and Large to be explicitly disabled independently while requiring one enabled ordinary role for an active policy.
- Add schema 3 defaults and session state, with in-memory schema 2 migration and guarded session writes for safer downgrade behavior. Downgrading after saving schema 3 defaults or manually editing them requires `/delegate off` in each active branch and manual conversion of ordinary `null` values.

### Changed

- Select only enabled ordinary roles that can satisfy the task, leaving work with the main agent when none can; Small/Medium preferences are inactive when either role is disabled.

## 0.5.0 - 2026-08-28

### Added

- Expanded the optional visual specialist to create assets and complete bounded presentation-layer changes when behavior and data contracts are already defined.

### Changed

- Renamed the user-facing UI Design role to Visual Design while preserving the `uiDesign` configuration key and `ui-design` status token.
- Clarified routing boundaries for application behavior, accessibility, checks, integration, and final acceptance.

## 0.4.1 - 2026-08-28

### Fixed

- Restored per-launch thinking selection so delegation guidance transmits the chosen level with the exact configured model instead of falling through to an ambient subagent default.

## 0.4.0 - 2026-08-27

### Added

- Added a compact effective-policy preview, selector guidance, and available public model metadata to the `/delegate` panel.

### Changed

- Require exact `provider/model` references for delegation guidance instead of relying on a launcher default.
- Clarified task-fit role selection, preference tie-breaks, dynamic advisory thinking, and current panel and status diagnostics.
- Raised the Pi peer requirement and explicitly checked baseline to `0.84.3`.

## 0.3.2 - 2026-08-26

### Documentation

- Refreshed the README and wiki with the current package status, safe first-use path, panel behavior, configuration hierarchy, and privacy boundaries.

## 0.3.1 - 2026-08-26

### Fixed

- Matched model results to Pi's `/model` presentation: model ID first, `[provider]` last, with no more than ten visible model rows.

## 0.3.0 - 2026-08-26

### Added

- Added live fuzzy model search by provider, model ID, and display name.

### Changed

- Replaced the chain of unbounded selectors with one responsive, keyboard-first settings panel.
- Made session edits explicit drafts with visible sources, bounded scrolling, and safe discard confirmation.

## 0.2.1 - 2026-08-26

### Fixed

- Replaced `Ctrl+Alt+D` with the terminal-safe, conflict-free `Alt+G` shortcut.

## 0.2.0 - 2026-08-26

### Added

- Added optional global intensity with session-branch overrides and a built-in `off` fallback.
- Added **Use global default** to the intensity selector.

### Fixed

- Replaced the terminal-ambiguous `Ctrl+Shift+D` shortcut with `Ctrl+Alt+D`.

## 0.1.2 - 2026-08-26

### Fixed

- Restored the canonical role-selection guidance for bounded execution, planning and ambiguity, repetitive volume, and exceptional blockers.
- Made the `normal` and `aggressive` thresholds and the three Small/Medium preference biases operational at their boundaries.
- Corrected session-branch guidance: a session without policy state starts at `off`, while a fork inherits the latest valid entry in its active history.

## 0.1.1 - 2026-08-26

### Added

- Added a public task-oriented documentation site on GitHub Pages.

### Fixed

- Clarified that the selector reset action changes the draft until you apply it.

### Security

- Restricted documentation deployments to `main`, isolated pull request cancellation, and pinned privileged workflow actions.

## 0.1.0 - 2026-08-25

### Added

- A keyboard-first `/delegate` selector for delegation intensity, model preference, exact Small, Medium, Large, and optional UI Design roles.
- Global defaults and session-branch state that begin at `off` and survive reload, resume, and tree navigation.
- Fail-closed validation for missing, unavailable, out-of-scope, or unauthenticated model roles.

### Changed

- Replaced the unpublished preset-based prototype with schema 2 global defaults and session-branch delegation state.
- Removed project configuration, external skill loading, tool interception, enforcement, persisted per-run thinking, and model fallbacks.
