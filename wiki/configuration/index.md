---
title: Configuration
description: Set valid global defaults, session-branch overrides, and optional thinking policies per role.
---

# Configuration

## Quick valid configuration

The safest route is to open `/delegate`, choose exact models from Pi's available catalog, and apply
the draft. In an active policy, every ordinary role needs an explicit decision: an exact,
authenticated reference or `disabled`; at least one ordinary role must be enabled. Visual Design and
Advisor are optional and do not satisfy that minimum.

Global defaults live at `~/.pi/agent/delegation-policy.json` and are written in schema version 7:

```json
{
  "schemaVersion": 7,
  "intensity": "normal",
  "preference": "standard",
  "small": { "provider": "example-provider", "model": "example-small" },
  "medium": { "provider": "example-provider", "model": "example-medium" },
  "large": null,
  "uiDesign": { "provider": "example-provider", "model": "example-ui-design" },
  "advisor": { "provider": "example-provider", "model": "example-advisor" },
  "thinking": {
    "small": { "level": "high" },
    "medium": { "min": "low", "max": "high" }
  },
  "contextShunt": { "mode": "off" }
}
```

The references are fictional. The example is the schema version 7 format that `0.16.0` writes and
that the extension still reads as inherited input; a current save keeps `advisor` and `advisorMode`
out of this file and stores them in the companion described under
[persistence](#persistence-and-compatibility). An absent setting inherits in a session or is **not
configured** without a global value; an exact `{ "provider", "model" }` reference enables an ordinary
role; `null` explicitly disables it. Global `uiDesign` and `advisor`, when present, are exact
references; only a session override may use `null` to disable that optional role.

`thinking` is optional and holds at most one policy per role. Omitting it, or omitting a role inside
it, changes nothing: the main agent chooses that role's level for each launch.

## Global defaults, session inheritance, and saving {#global-defaults-and-inheritance}

Global defaults are spread over their files. The schema-7 delegation file holds intensity,
preference, tri-state ordinary roles, the `uiDesign` key, the ContextShunt configuration and thinking
policies per execution role;
the Advisor companion and its extension hold Advisor 1, Advisors 2 and 3, `advisorMode` and
`advisorLaunch` ([persistence](#persistence-and-compatibility)). If global intensity is absent, the
built-in default is `off`; preference defaults to `standard`, and Advisor mode defaults to
`with-delegation`.

A branch inherits a global value until it records an override. **Use global default** removes the
branch override. A session `null` wins over a global model, and a session model wins over a global
`null`. A session thinking `null` keeps no policy for that role in the branch even when global
defaults set one. Sources are reported as `default`, `global`, or `session`.

**Save effective configuration as defaults** copies the effective configuration to the global files,
including ordinary `null` values, the effective thinking policies, and the configured ContextShunt
mode even while delegation suspends it. It does not apply the current session draft or change the
branch. A role with no effective policy is written without one, never as `null`. `/delegate reset`
writes `off` for both intensity and Advisor mode and returns the other fields to global inheritance;
**Reset draft to off** is only a draft until Apply.

## Configuration change notice

A change to effective delegation settings adds one extension-owned notice to the requests of the
next user turn. It names the previous and new intensity, preference, role models,
thinking policies, Advisor settings, or ContextShunt mode and reader settings. It explicitly directs
new work to the current valid assignments rather than older settings in the conversation. Changes
to global defaults count when they reach the branch; opening or cancelling the editor, identical
saves, and changes reverted before the turn do not produce a notice. Enforcement limits and path
patterns are not tracked by the notice.

The notice is request-only, not a saved conversation message or part of system policy. It stays the
same across the requests and retries of that turn. A change during a running turn updates the policy
immediately as before and waits until the next user turn for its notice. Completing the earlier
revision cannot consume a later change that has not been shown. Session starts, reloads and tree
navigation reset the reference silently; extension-generated prompts do not consume pending notices.

Turning both axes off produces one notice: `Delegation and Advisor disabled by this policy.` After
that, neither policy nor notice is injected while both remain off. An enabled but invalid Advisor is
not described as disabled. The notice changes no other authority, permission or model, and it cannot
guarantee obedience. [Limits and privacy](/limits-and-privacy/#configuration-change-notice) explains
consumption, the accepted cancellation window and the verified host boundary.

## Roles and validation

Active execution-delegation guidance requires each ordinary role to be an exact authenticated
reference or `disabled`, with at least one enabled. An absent role is **not configured**. Any of the
following produces `D:ERR` and removes execution-delegation guidance:

- an ordinary role with no value;
- an enabled reference that is missing, unavailable, out of scope, or unauthenticated;
- no enabled ordinary role;
- a configured thinking level an ordinary role's resolved model does not support, reported with the
  role, the level, and the model.

Disabled roles are not validated, and a configured Visual Design reference is validated whenever it
is configured. Every optional entry is validated too, but an unusable or non-image entry is a warning
that costs only that entry, never the delegation axis. A thinking level an optional entry's model does
not support is one of those warnings, and so is the mirrored document `thinking.uiDesign` of Visual
Design entry 1: neither produces `D:ERR`. The extension has no model fallback and never
substitutes a role, model, or level. A policy set for a disabled or not configured role is stored and
inert until that role is enabled again, and adds no error.

## Thinking

The main agent chooses thinking for every delegated task from demand, difficulty, quantity, risk,
error and review cost, and the selected model's capabilities. That per-launch choice is the default,
and the extension neither stores it nor reports it.

A policy per role is optional and has three states:

- **Unset** (key absent) — the main agent chooses the level for each launch.
- **Fixed** (`{ "level": "<name>" }`) — every launch of that role uses exactly that level.
- **Range** (`{ "min": "<name>", "max": "<name>" }`) — the main agent chooses a level inside the
  inclusive bounds.

Level names are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`, in lower case. A range
whose `min` and `max` are equal is normalized to a fixed level. A configured policy is binding for
that role and cannot come from an ambient launcher default or from another role. With `pi-subagents`
the launch carries `model: "provider/model:LEVEL"`, where a fixed policy appears as its literal
level; another launcher may expose a separate per-run field.

A `thinking` entry outside those three states is a malformed document rather than a policy error: an
unrecognized level name, an empty or malformed policy object, a `min` above its `max`, mixed or
unknown keys, a non-object, an unknown role key, or `null` in global defaults. Global defaults then
fall back to empty defaults with no injection, and a session branch falls back to `off` with a
sanitized notice; neither case produces `D:ERR`.

## Intensities

- `off` reports `D:OFF` and removes execution-delegation guidance before the next LLM request. An
  explicitly enabled Advisor keeps consultation-only guidance; with both off no policy block is injected.
  The change notice has the one-turn shutdown exception described above.
  A request already in progress and subagents already launched are unchanged.
- `normal` delegates substantial, separable work only when the expected benefit clearly outweighs
  briefing, supervision, review, and integration. Borderline work stays with the main agent.
- `aggressive` delegates suitable substantial, separable, independently checkable work by default when
  its objective and acceptance criteria are clear. Tightly coupled work or clearly prohibitive
  overhead stays with the main agent.
- `orchestrator` delegates all transferable execution before performing it whenever an enabled capable
  role and an authorized launcher are available, regardless of size. This includes small lookups,
  code reading, detailed planning, implementation, testing, writing, detailed review, and integration
  mechanics. Bootstrap is limited to mandatory instructions, tool discovery, and a narrow assignment
  scope; it must not pre-solve or broadly inspect the repository, and small tasks are grouped without
  recursive fanout. After assigning, it must not take the task over or run an equivalent worker while
  it is pending: it coordinates only disjoint work, waits through the host, and consumes the result
  before dependent work or finalizing. It retains strategy, objectives, critical user decisions,
  coordination, safety, evidence evaluation, final acceptance, and concise synthesis; that
  responsibility does not permit performing transferable review or integration. It reinspects only a
  concrete gap, risk, or contradiction, then delegates transferable fixes and rechecks. Direct
  execution is allowed only for genuinely non-transferable work, no enabled capable role, a confirmed
  unavailable authorized launcher, or an explicit user or higher-priority requirement, stated briefly
  before the minimum direct work. Size, triviality, convenience, economics, transfer cost, a
  final-review or integration label, and familiarity are not exceptions.

In `normal` and `aggressive` the main agent also retains global strategy, coordination, integration,
and work whose essential context is too costly or risky to transfer.

## Preference and role selection

The policy considers demand, difficulty, quantity, risk, acceptance criteria, evidence, and review
cost. It first removes disabled roles, then chooses the least costly enabled role that can satisfy the
work. A more capable enabled role may cover work normally suited to a disabled role only when it can
meet the same acceptance and evidence. If no enabled role is sufficient, the main agent keeps the
work.

- **Small** handles bounded, planned, and verifiable execution. Difficult but well-defined work can
  stay Small with higher thinking.
- **Medium** handles planning, ambiguity reduction, broad synthesis, several modules, comparison,
  context coordination, or difficult decisions. Small does not need to fail first.
- **Large** is exceptional while Small and Medium are enabled alternatives; in a partial
  configuration it may cover other delegable work only when it is the least costly enabled role that
  can satisfy the same acceptance and evidence.

Large quantities of repetitive independent work favor multiple Small delegations. Volume alone does
not justify Medium or Large, and agent type does not determine the role.

`efficient` breaks a credible Small/Medium tie toward Small, `intensive` breaks the same tie toward
Medium, and `standard` adds no bias. If Small or Medium is disabled, all three preferences are inert:
they never redirect work to Large or another role.

## Child briefs

While delegation is active, the block asks the main agent to write each child's brief before launching
it: the bounded outcome and its owner, the context and invariants already decided, the scope and
permissions with the exclusions, how the result is verified and accepted, what the child returns and
where it goes, and when it stops to ask. An unresolved decision stays a question the child may answer,
not a settled invariant, and a host agent name such as `worker` or `reviewer` does not stand in for the
model role or grant a permission. A missing heading alone never blocks a launch: the main agent asks
before launching only when a new material decision or authorization cannot be inferred from the
session. One emphasis line and one example follow, for each enabled role only, so `off` and
Advisor-only sessions carry no brief guidance.

## Visual Design and Vision

Two optional specialists, neither of them an execution tier, and each holds up to three exact models
called entries. Visual Design exists for work whose result is judged by eye: restyling, layout,
spacing, typography, colour, component styling, matching a mock or a screenshot. Vision exists for
work that must look at images: screenshots, rendered pages, UI captures, diagrams, charts, scanned
pages. Judging an image without changing it is Vision; changing how something looks is Visual Design.

Neither family takes part in the cheapest-role comparison, which covers Small, Medium, and Large only:
an entry is the model you chose, not a price to beat. With no entries a family leaves no trace in the
injected block. With entries, the block carries one rule per family, one line per entry with its exact
model and thinking policy, and one line stating what the host registry reports for each configured
model: `text+image`, `text only`, or `unverified`. When nothing configured can read an image the block
says so as a fact, so image work is not handed to a model that cannot see it.

### Entries

Entries fill in order and never leave a gap, and [commands and status](/commands-and-status/) lists the
exact forms.

Entries are stored in `delegation-policy.roles.json` next to the delegation defaults, one ordered list
per family, each entry an exact `provider`/`model` plus an optional thinking policy. The file is
versioned and separate because the policy document rejects unknown keys: a new key there would make
every installed older version read the whole configuration as invalid. A missing file is the clean
default, and a file this version cannot parse is reported and ignored rather than overwritten.

Visual Design entry 1 is mirrored into the delegation document as `uiDesign` (with `thinking.uiDesign`),
which is what the panel and older versions read. When the two disagree the document wins and the sidecar
keeps the remaining entries, because the other writer was a version that cannot see this file: the
document's model takes slot 1 and the sidecar's own slot 1 is not kept. Entry commands therefore write
the global state only. They are refused while the branch owns a family's first slot, because that value
belongs to the branch and must not become the shared default. `/delegate … remove` closes the gap, so
the entry behind the removed one moves up into its slot. Slot 1 of Visual Design is edited in the panel,
which also offers a row per entry —`Visual Design 2`, `Visual Design 3`, `Vision`, `Vision 2`, `Vision 3`—
each of them global. Each family's first row is always offered, so a family can be started from the
panel, and the rest follow the one before them. Those rows write the sidecar themselves; entry thinking
stays in the file. `vision 1 …` and `visual-design 1 …` are rejected because a slot number is only `2` or
`3`.

### Validation

Every configured entry is validated against the host registry. An entry whose model is missing,
outside the scope, unauthenticated, or whose thinking level is unsupported is reported as a warning
and simply cannot be launched; it never turns delegation into `D:ERR` and never affects the other
roles. A vision entry whose model does not accept image input is reported the same way: the role keeps
its place, and the block already says that model cannot see.

## Advisor reading

An Advisor never executes work, and by default it also reads nothing: it answers from the brief the
main agent writes. Reading is a separate capability, off until you turn it on for a specific Advisor.
It applies to role launches only: `consult_advisor` always launches the packaged, tool-free profile, so
the panel does not ask the question while Advisor launch is `tool`, and a flag left over from a role
launch changes nothing there.

In a role launch the panel asks right after you choose that Advisor's model — **Advisor N reading**,
`Off` or `On` — and the flags are stored in `delegation-policy.advisor-read.json`, one boolean per slot,
with trailing offs dropped so "none" has one representation. Turned on, that slot launches through
`pi-delegation-policy.advisor-read`, a profile whose only tool is `read`, and the injected block says
so in the role line (`reading: on, open only the paths the brief names`). The line states it only when
that resolved profile is the reading one, so a provider-dependent profile never claims a read it cannot
do.

What that buys and what it does not:

- The Advisor can open an image the main agent names, which is the point: a description of a screenshot
  is not the screenshot. A model that only accepts text cannot use it, and the profile tells the Advisor
  to say it could not see the image rather than describe it from the name.
- The tool is not a path boundary. This extension grants `read`; the host's permission rules decide what
  it may reach, and the profile's instruction to open only paths the brief names is guidance.
- Provider-dependent Advisor profiles (`advisor-anthropic-auth`, `advisor-provider-extension`) keep
  their own identity and stay tool-free; reading is not offered on them, and choosing one clears the
  flag for that slot.

## Advisor

Advisor is optional, outside the ordinary-role minimum, and has no model until you configure one. Its
mode defaults to `with-delegation`, so a configured Advisor is consulted while delegation is active.
Configure **Advisor 1** and optional **Advisor 2** and **Advisor 3**, each with an exact model. Advisor thinking is not a
setting: role launch lets the main agent choose it per run, and tool launch picks it automatically.
Every valid advisor gets the same question, so each extra advisor adds a consultation at every
checkpoint. Weigh disagreements; agreement is not proof. The packaged no-tools/no-extensions
`pi-delegation-policy.advisor` profile advises and executes nothing.

**Advisor launch** inherits globally or per branch, defaulting to `role`:

- `role`: the main agent launches every valid advisor in one background subagent call, with exact
  models and a thinking level it chooses per run. The extension observes matching attempts but does
  not launch them.
- `tool`: the always-registered `consult_advisor({ question, brief?, evidence? })` launches one
  child per valid advisor in parallel through the public `pi-subagents` delegation API. It requires
  stable SemVer `>=0.76.1`, with no upper bound; prereleases and invalid versions are rejected. Every
  launch must still pass the strict contract and terminal-binding checks. Otherwise it returns
  unavailable text. No model, provider or executor fallback is added.

In `tool` launch a consultation keeps each advisor's conversation for the rest of the operative
task. The first call launches the packaged profiles and is the only turn that carries the verified
launch contract. Later calls in the same task continue each thread with the public RPC `resume`,
carrying only the new question plus `evidence`: the extension supplies the run id and the output
path, and the host inherits the model and profile. The
answer is accepted only from the per-turn output file the extension owns, after the new run id
reports one completed step with the same agent, model and thinking; a resumed turn relies on the
contract the host inherits plus those observed values, not on a re-verified digest. A mismatch,
timeout or missing answer blocks the thread: it is never retried, replaced by a fresh launch, or
continued from an older run id, and recovery can only use the receipt of the turn that is actually
pending, never an earlier one. A task ends when it settles and cannot be resumed, even if persisting
its closure fails. Its answered records remain closing obligations in the same journal; a new task
cannot bypass them, and recovery must persist their closures before consultation can restart.
Uncertain turns still require terminal proof for their current operation. A fresh prompt, a branch
move or a configuration change starts a new thread, and a prompt an extension sends opens no task,
so a consultation from one starts nothing. The journal is private and content-free; the answer
files and child sessions keep the host's and provider's normal retention. Output paths are checked
from the trusted agent directory before creating descendants or reading answers; pre-existing
symlinks and junctions in the owned tree are refused. This is not protection against a malicious
host runtime replacing paths concurrently.

Every configured advisor keeps its position and gets an explicit result, so two answers out of
three report `partial`. `/delegate advisor threads status|recover|reset`, or `C` in the
`/delegate` panel, reports the continuity state, reconciles a possibly live turn with public
terminal proof, and abandons threads only when nothing may still be running.

Continuity uses three lock directories of its own beside the journal, all under the same agent
directory: `delegation-policy.advisor-threads.json.lock/<parent>` per session,
`delegation-policy.advisor-threads.json.commit.lock` for each write, and
`delegation-policy.advisor-threads.json.reclaim.lock` for the short reclamation section. A
reclamation gate left behind by a crashed process is never reclaimed automatically, so recovery can
stay blocked until it is cleared by hand; `/delegate advisor threads recover` reports that case and
changes nothing. Clear it only with every Pi process that uses this configuration stopped and
confirmed finished: remove `delegation-policy.advisor-threads.json.reclaim.lock`, and a
`delegation-policy.advisor-threads.json.lock/<parent>` whose recorded owner is gone. Never remove a
lock while a process that uses it may still be running. The locks assume one host and a local
filesystem, and owner liveness is the only OS signal they use.

Both modes ask for consultation after orientation before substantive work, when stuck, before changing
approach, and before declaring a multi-step task done (ask for remaining risks, not approval). Short
reactive steps and mechanics in a settled approach need no new call.

Every consultation runs in fresh context and carries the question plus a short self-contained `brief`
(objective and constraints, relevant facts, options and proposal, uncertainty), never the
conversation. A first consultation in a thread requires that brief. A later call sends only the new
question and the evidence of what changed. The Advisor therefore sees only what you write in the brief, so a thin brief
weakens the advice. The tool launches each advisor at the highest level its model supports among
`high`, `medium`, `low`, `minimal` and `off`, in that order. A level above `high` is used only by a
model that supports none of them.

Concurrency, cancellation, and what each turn sends are limits of the surface:
[limits and privacy](/limits-and-privacy/#advisor-role) states them.

**Advisor mode** is an independent axis you set in the panel or with `/delegate advisor …`:

| Mode              | Effect                                                                                                     |
| ----------------- | ---------------------------------------------------------------------------------------------------------- |
| `on`              | Consult with delegation off. Requires a valid Advisor model; ordinary roles are not required in that case. |
| `off`             | Inject no Advisor guidance and keep the saved models.                                                      |
| `with-delegation` | Consult only while delegation is active and an Advisor is configured. Default when the key is absent.      |

`D:OFF A:ON` shows consultation-only guidance; `D:OFF A:OFF` means neither axis injects a policy block. `/delegate reset`
turns both off for the branch; `/delegate off` leaves an independently enabled Advisor active.

### Errors by axis

Errors are reported per axis. Each entry validates independently: `A:ON` means all valid, `A:PART` means some valid
(consult those), and `A:ERR` means none usable and removes only consultation: valid delegation and an otherwise authorized ContextShunt reader keep working.
`D:ERR` removes delegation guidance and leaves a valid enabled Advisor alone. A malformed main
delegation file still fails closed, and a malformed or stale Advisor companion affects only Advisor:
delegation from the main file wins, and the companion keeps its saved model only while it is readable
and valid, so the next save repairs that pair. A corrupt or unreadable companion cannot supply Advisor
settings. Settings still present in a legacy delegation file are retained; otherwise, configure the
Advisor model again.

Consulting sends the question and brief to another model — the extension never adds the conversation,
and it refuses a call that asks to fork the session for an Advisor — and it can incur latency and
cost, including with delegation off. A fork default set in `pi-subagents` itself stays outside the
extension's reach. The host sends it only after an explicit launch or tool call, never from a hook. See the [limits and privacy reference](https://yivas.github.io/pi-delegation-policy/limits-and-privacy/)
for the signals and the retention of the executor and its provider.

### Provider extension

The default profile remains `pi-delegation-policy.advisor`, with no configured tools or extensions.
Choosing an `anthropic` model in an **Advisor** row asks for the profile: **Standard** or an
explicit **Anthropic auth 3.4.3/3.4.4/3.6.0** opt-in. Escape keeps the profile that entry already had. The opt-in
selects the separate package profile `pi-delegation-policy.advisor-anthropic-auth` in both role and
tool mode. The model stays unchanged; role launches remain background. In configuration this is
`providerExtension: "anthropic-auth"` on that Advisor entry, available in schema 10. Absence means
the standard profile. Only provider `anthropic` is supported; an incompatible selection is an
Advisor error, never a fallback to the standard profile or another model.

This option runs the installed `@gotgenes/pi-anthropic-auth` **3.4.3**, **3.4.4** or **3.6.0** extension as trusted host
code. Its normal global/project configuration, startup hook, provider aliases and
`/anthropic-auth:status` command are retained. That command may query account information when
explicitly invoked; initialization and availability checks never invoke it. The extension uses
normal provider authentication; this package does not copy credentials or perform login. Empty
model tools do not sandbox the provider code.

Only a managed user install resolved by Pi under its agent directory's `npm/node_modules` is
supported. The exact manifest, single entry and canonical path must match. Project candidates,
legacy installs, unexpected entries, missing packages and incompatible host APIs make this Advisor
unavailable. Nothing is installed automatically and other Advisors remain independent. The check
loads no provider code while Advisor is off. It does not inventory irrelevant legacy copies; version
labels are not signatures, and a resolution-to-load race remains. A persistent dispatch guard keeps
initialization errors from silently choosing builtin transport. No provider payload or headers are
reimplemented.
One bounded fresh/background real-provider consultation completed on Pi 1.4.0 with pi-subagents
0.83.1. Launch metadata showed the prompt runtime and provider bridge, no required extensions and no
observed tool calls. Fork, `consult_advisor` and other builds were not validated by that run.

With any provider opt-in saved, the extension companion uses envelope 2 containing the full schema-10
state and an exact normalized schema-8 base with Advisor off. The legacy companion also has Advisor
off. Readers through 0.22.2 therefore leave **all Advisors off**, preserving ordinary delegation,
rather than run a provider-dependent Advisor as a standard one. Missing, corrupt or stale envelope-2
state leaves them off until repaired. Without an opt-in, the envelope-1 format below is unchanged.

### Admitted provider extensions {#admitted-provider-extensions}

Some providers exist only because an extension registers them, for example a provider that keeps its
keys in its own vault instead of Pi's credentials. The standard Advisor profile loads no extension, so
such an Advisor fails with a missing credential. Choosing a model of such a provider in an
**Advisor** row asks for its provider extension: **Standard profile (no provider extension)** or one
of your installed packages, shown as `<package> <version> · trusted extension, identity only`. The
row then shows `· <package> <version>`. The step appears only when an extension registered that
provider in the current session, or when the provider already has an admission. Anthropic keeps its
own opt-in above and never appears here.

An admission is global and per provider: every Advisor with that provider, in every session, uses
the package profile `pi-delegation-policy.advisor-provider-extension`. **Apply** and **Save** both
store a changed admission; **Cancel** discards it and **Standard** removes it. The file is
`~/.pi/agent/delegation-policy.provider-extensions.json`:

```json
{
  "schemaVersion": 1,
  "providers": {
    "example-provider": { "package": "example-provider-extension", "version": "1.2.3" }
  }
}
```

Only a package you already load qualifies: your user settings must list exactly
`npm:<package>@<version>` unfiltered, Pi's managed user install must hold that version with no
project candidate or links, and its manifest must declare exactly one extension entry inside the
package. The panel offers only packages that pass this check, and `/delegate` validation repeats it.
The Advisor child does not, and cannot: it resolves its model and its provider before any extension
`session_start` runs, so a check inside the child would arrive too late to matter. After `pi update`
changes the version, the Advisor reports an error until you select the extension again; it never
follows the new version on its own. An invalid file is ignored with a diagnostic and leaves the other
Advisors running.

The packaged profile pins the admitted package in `subagentOnlyExtensions` and keeps `extensions:`
empty, so the host loads exactly that package for the child and no ambient extension. The pin is one
package and one version: `pi-antigravity-acp-provider` `0.1.21`. Its registration is the only one
reviewed, and it may register `antigravity_acp_permission`, the tool that asks Antigravity for a
permission decision the provider itself issued. The Advisor child launches with an empty tool
allowlist, so that tool never reaches the model. A second admitted package, or a new version of this
one, needs its own profile and its own review: a static profile can pin only one.

Because the pin is fixed, an admission that names another package is not served. Routing checks it
before any launch and leaves the Advisor out, rather than loading a package the current admission no
longer authorizes.

This is trusted code, not a sandbox. The package identity is checked in this session, and that is the
only check: the child loads the pinned package before it can inspect anything. It can read files,
use the network and reach its own accounts, and a provider it registers is the one used. Per-process
state stays per process: a quota-rotating extension checks quota again in each child and can pick an
account the main session already exhausted. An Advisor whose provider an extension replaced in the
main session, with no admission, gets a warning in `/delegate status` and stays consulted, because
the built-in provider may still answer with its own credentials. An admission whose package no longer
passes the check, or whose package is not the pinned one, is an Advisor error instead. The candidate
list holds every pinned user package, not only providers. Releases before this option ignore the
file and launch the standard profile, which may answer through the built-in provider or fail as
before.

## Launch correction mode {#launch-correction-mode}

While delegation is active, or while an Advisor is enabled, the launch check corrects three
unambiguous cases instead of refusing them, and tells the agent what it applied. The three cases, and
the refusals that remain, are listed under [launch check](/limits-and-privacy/#launch-check). Accepted
role names are `small`, `medium`, `large`, `visual-design`, `ui-design`, `uidesign`, `advisor`,
`advisor-1`, `advisor-2` and `advisor-3`, case-insensitive. The added level is the role's fixed level,
the lowest supported level inside its range, or `medium` clamped to what the model supports when the
role has no policy.

A test mode refuses those cases instead, which keeps the pre-correction behaviour for measurement.
Set it in `/delegate`, on the **Launch correction** row. `correct` is the default, and `block` is the
measurement mode. The row is global for every session, not a session setting, and the panel says so
before you change it. **Apply changes** and **Save effective configuration as defaults** both store a
changed value before their own step, so a failure there stops the step and reports it; **Cancel**
discards the change and leaves the file as it was.

The panel writes `~/.pi/agent/delegation-policy.launch-correction.json`, whose format is:

```json
{ "schemaVersion": 1, "mode": "block" }
```

`correct` is the value to restore. The file is separate from the schema-10 policy document, which
rejects unknown keys, so the mode needs no schema bump. A missing file means `correct`; an unreadable
or invalid one is ignored with a diagnostic and never makes the delegation axis invalid, and the panel
refuses to overwrite it until you fix or remove it. The replacement is a temporary-file write, so a
failure leaves the previous file in place.

## Advisor reminder {#advisor-reminder}

The global **Advisor reminder** row adds one short extension-owned line to the request context, at
most once per operative task of each instance, so a useful consultation does not depend on the user
remembering to ask for it. It is on by default; `off` adds nothing. The row is global for every
session, not a session setting, and **Apply changes** and **Save effective configuration as defaults**
both store a changed value before their own step, while **Cancel** leaves the file as it was.

Two observable events arm the reminder. One successful builtin orientation result (`read`, `find`,
`grep` or `ls`) presents it in the next request, and the same builtin tool failing in two different
rounds presents it as well. A batch of results is one round, and a retry of the same request keeps the
presentation it already carried; the next round never re-arms it. An attempted consultation ends the
reminder for that task even when it fails, and a control action that only names an Advisor is not a
consultation. Turning the reminder off, a branch move, a new task or the task settling discards it,
and re-enabling it never restores a presentation the same task already used.

The reminder is presented only while a valid Advisor is active, the task is live, and the configured
launch mode has its launcher among the active tools: `subagent` for `role`, `consult_advisor` for
`tool`. A session that cannot consult is never told to, and no preflight, status call or process is
started to find out. Only the documented `pi-subagents` process markers (`PI_SUBAGENT_CHILD=1`,
`PI_SUBAGENT_RUNNER_PID`) exclude a child; a `/fork` or `/clone` of a human session is still a main
session and keeps the reminder, and a missing marker proves nothing, so foreground children that
load this policy and can consult are covered too.

The line is appended to the request copy after the policy block and the configuration notice, and
never to the conversation. It starts no turn, no child and no consultation, adds no authority and
revokes no instruction, and it cannot promise to arrive before the first edit or to observe sources
other than those builtin tools. It is sent to the provider like the rest of the request, so it is not
a promise about cost or retention, and a reminder is not evidence that a consultation happened.

The panel writes `~/.pi/agent/delegation-policy.advisor-reminders.json`:

```json
{ "schemaVersion": 1, "mode": "remind" }
```

`off` is the value that adds nothing. The file is separate from the schema-10 policy document, which
rejects unknown keys, so the mode needs no schema bump. A missing file means `remind`; an unreadable
or invalid one suspends only the reminder with a diagnostic, never changes the delegation or Advisor
axis, and is reported instead of overwritten until you fix or remove it; the row then reads
`Unavailable/Suspended · global`, because a suspension is not a value you chose. The replacement is a
temporary-file write, so a failure leaves the previous file in place.

## Advisor child extensions {#advisor-child-extensions}

An Advisor child runs with its own system prompt and without the session's ambient extensions. To add
a personal one anyway, name it in `delegation-policy.advisor-extensions.json` beside the delegation
document:

```json
{ "schemaVersion": 1, "extensions": [{ "package": "example-prompt-layer", "version": "1.2.3" }] }
```

Admission is as strict as a provider admission: an exact `package@version`, listed unfiltered in your
own settings, installed by Pi, with one extension entry inside the package. Up to two entries. The
host loads them for every child of the session, Advisors included, while an Advisor is enabled. That is
the only granularity the host offers, so the ContextShunt reader loads them too and its contract
expects the same ids. An invalid file, or a package that no longer passes the check, is ignored with a
warning and the Advisors keep working without it.

These extensions run as trusted host code in the child, with your files and network, and they can
change the Advisor's prompt. The child does not revalidate them. A prompt layer that prepends text
means the advice comes from the Advisor role plus your own instructions, in that order.

## Persistence and compatibility

- Global defaults: `~/.pi/agent/delegation-policy.json`, schema 7: intensity, preference, the
  tri-state ordinary roles, `uiDesign`, the thinking policies, and the ContextShunt configuration.
- Launch correction mode: `delegation-policy.launch-correction.json`, schema 1 with `mode`. Missing
  or invalid state means `correct`. Older versions ignore it.
- Advisor reminder: `delegation-policy.advisor-reminders.json`, schema 1 with `mode` (`off` or
  `remind`). Missing state means `remind`; invalid state suspends only the reminder. Older versions
  ignore it.
- Legacy companion: `delegation-policy.advisor.json`, envelope 1 with schema 8 state for Advisor 1.
  Versions `0.17–0.20` see its mode and model in role mode; `0.16` sees delegation without Advisor.
  None of those versions sees Advisor 2, Advisor 3 or tool launch.
- Advisor extension: `delegation-policy.advisor-extension.json`, envelope 1 with normalized schema-8
  `base`, optional `advisor2`, optional `advisor3`, and `advisorLaunch`. Missing, invalid, unreadable
  or mismatched state falls back to Advisor 1 and role launch with a diagnostic, not `A:ERR` for a
  valid first advisor. Older versions ignore it, and `0.21`–`0.23` fall back to Advisor 1 when it
  holds `advisor3`. A save from one of those versions then drops Advisors 2 and 3.
- Provider admissions: `delegation-policy.provider-extensions.json`, schema 1 with `providers`, one
  package and version per admitted provider. An invalid file is ignored with a diagnostic and leaves
  the other Advisors running.
- Session Apply: schema 2 off guard, extension entry, schema-8 companion, then schema-7 delegation
  commit. The legacy companion remains adjacent to that commit. A failure leaves both axes off.

Schema 9 accepts ordered `advisors: [{provider, model}]` with 1–3 entries and inherited
`advisorLaunch: role|tool`. An omitted list inherits; a list replaces every entry; session
`advisors: null` disables. Legacy `advisor` and `thinking.advisor` are single-advisor shorthand,
not combinable with `advisors`. A per-entry `thinking`, or a `thinking.advisor` saved by an earlier
version, must still be well formed, but it is ignored and dropped on the next save. Schemas 2–9 resolve into the schema-10 effective state in memory without writing.

### Compatible saves and interruption recovery

Global saves replace delegation, companion, then extension, individually atomically, not as a
transaction. All three previous files must be readable or absent. On failure, restore and verify only
our committed prefix, never a detected foreign write; otherwise report partial save and reload disk.
Checks are not locks. A crash can leave Advisor off or Advisor 1 only in role mode until repaired.

Content-free events go to `delegation-policy.events.jsonl` in the same agent directory, never to the
network. [Limits and privacy](/limits-and-privacy/#local-content-free-log) lists every field, the
rotation, the shutdown drain, and the cases in which no event is written.

### Version floors {#version-floors}

These are the version requirements and admissions the extension enforces. Anything outside them
fails closed rather than falling back to another model, provider, or executor.

| Component                               | Requirement                                                                         | When it is unmet                                                                                   |
| --------------------------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Pi                                      | `>=0.87.1`                                                                          | The extension needs the per-request hook that this floor introduced, so earlier Pi is unsupported. |
| `pi-subagents` (Advisor `tool`, reader) | stable SemVer `>=0.76.1`, no upper bound                                            | `unavailable` text or `reader-unavailable`, before any request                                     |
| `@gotgenes/pi-permission-system`        | only `33.0.3` is admitted, and only when the host adds it                           | The reader rejects the extra runtime and returns `reader-unavailable`                              |
| `@gotgenes/pi-anthropic-auth`           | only `3.4.3`, `3.4.4`, or `3.6.0` is admitted, and only when the opt-in is selected | That Advisor is unavailable, with no fallback to the standard profile                              |

### Downgrade

Before downgrading to a package that cannot read schema 4, set global and branch ContextShunt to
`off`. Before downgrading to `0.6.0`, set intensity to `off`, `normal`, or `aggressive` and run
`/delegate off` in every active branch. For `<=0.5.0`, convert global defaults to schema 2 and
replace ordinary `null` values with exact references. The downgrade guarantee of this line is for
schema 7 readers such as `0.16.0`; earlier versions keep their existing limitations.

## ContextShunt

`contextShunt.mode` is independent from delegation intensity: `off` is the default and does no
classification, metrics, archive I/O, or interception. `observe` records decisions without changing
calls or results. `enforce` covers only recognized native reads, one conservative bounded
`Get-Content`/`gc` form on `bash` and `powershell`, and known successful textual results. Delegation
`off` suspends the effective mode without deleting the saved preference.

Limits, patterns, and the reader settings inherit per field between global defaults and the branch.
Preflight limits use declared lines and post-result limits use real UTF-8 bytes and returned lines.
`exceptionPatterns` exempt matching paths only from this optimization and never grant filesystem
access; `delegationHintPatterns` label an already blocked declared excess as a delegation hint. Three
further keys control the opt-in inline reader:

- `readerEnabled` (boolean, built-in `false`) — allow `context_shunt_delegate` to answer from a
  preserved artifact.
- `readerRole` (`small`, `medium`, or `large`, default `small`) — an existing ordinary role whose
  exact model answers. No separate reader model is stored, and the role must be enabled with an
  available model.
- `answerMaxBytes` (integer, 1024 to 16384, default `8192`) — cap on the serialized result, including
  its citations and envelope.

The reader also needs an effective mode of `enforce`, an active delegation intensity, and a valid
configuration. It requires stable `pi-subagents` SemVer `>=0.76.1`, with no upper bound, and the
unchanged strict launch contract. Older, prerelease, invalid or contract-incompatible builds fail
closed with `reader-unavailable`. The reader was verified with `0.76.1` on Pi `1.1.0`.
**Context advanced** in the panel edits
these values and each limit, and **Reset ContextShunt draft** clears all branch values. Schema 4 still
accepts a positive `limits.readerOutputBytes` from older files, but ignores it and never writes it
again.

Read [limits and privacy](/limits-and-privacy/#contextshunt-reader) for the
request, the answer contract, and retention.
