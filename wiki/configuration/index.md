---
title: Configuration
description: Set valid global defaults, session-branch overrides, and optional thinking policies per role.
---

# Configuration

> Independent Advisor mode and its companion file are available from version `0.17.0`.
> Existing configurations keep Advisor tied to delegation until `on` is selected explicitly.

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

Global defaults may contain intensity, preference, tri-state ordinary roles, the `uiDesign` and
`advisor` keys, an independent `advisorMode`, and one thinking policy per role. If global intensity is
absent, the built-in default is `off`; preference defaults to `standard`, and Advisor mode defaults to
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

## Roles and validation

Active execution-delegation guidance requires each ordinary role to be an exact authenticated
reference or `disabled`, with at least one enabled. An absent role is **not configured**. Any of the
following produces `D:ERR` and removes execution-delegation guidance:

- an ordinary role with no value;
- an enabled reference that is missing, unavailable, out of scope, or unauthenticated;
- no enabled ordinary role;
- a configured thinking level the role's resolved model does not support, reported with the role, the
  level, and the model.

Disabled roles are not validated, and a configured Visual Design reference is validated whenever it
is configured. The extension has no model fallback and never substitutes a role, model, or level. A
policy set for a disabled or not configured role is stored and inert until that role is enabled again,
and adds no error.

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
  explicitly enabled Advisor keeps consultation-only guidance; with both off nothing is injected.
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

## Visual Design

Visual Design is an optional specialist, not a fourth execution tier. Use it only when the primary
acceptance criterion is visual or user experience, behavior and data contracts remain unchanged, the
patch is bounded, and no logic, data flow, APIs, routes, architecture, tooling, or cross-system
coordination is involved. When it is configured, evaluate those four conditions before ordinary-role
selection for every task or phase. If they hold and the visual portion is being delegated by the
main agent's decision or required by the active intensity, Visual Design takes priority over Small,
Medium, and Large for that portion; reevaluate when the task or phase changes. The priority does not
require delegation in `normal` or `aggressive`. It may design, create, implement, and review scoped
presentation code and assets, including visual accessibility, and run its relevant checks. It does
not own interaction behavior, state, validation, semantic accessibility, persistence, test
infrastructure, or integration mechanics. When it is disabled, an enabled ordinary role handles
eligible visual work by task fit.

## Advisor

Advisor is an optional consultation role, not an execution role. It is off by default, does not count
toward the ordinary-role minimum, and stores an exact `{ "provider", "model" }` reference in global
defaults. A session `advisor: null` removes that model for the branch and, without an explicit session
mode, resolves to `off`. `thinking.advisor` accepts the same three states as any other role.

The extension never launches the Advisor. When the role is enabled, configured and valid, the injected
policy makes a brief consultation step 1 of the decision order and tells the main agent to launch
`pi-delegation-policy.advisor`, the profile that ships in this package, as a normal subagent through
Pi's subagent mechanism, with the exact configured model and `thinking.advisor` policy. It favors that
brief contrast while the agent shapes or reconsiders a substantive choice — an approach, a scope, the
acceptance criteria, a comparison between options, or a decision — without requiring a recognized
doubt, a proposal, or alternatives first, and without asking the agent to predict whether the answer
will change the decision. The advice is reused while the decision holds and reopened on new relevant
evidence. The one concrete limit is a local detail with no effect on an approach or a solution already
fixed. Those are signals and limits, not a threshold or a quota, and the policy promises no obedience.

The profile executes no work and has no tools or extensions, so it sees only the brief the main agent
writes and answers with plain text. That brief puts the objective, the constraints, the facts, and the
open choice first, and the agent's proposal and reasons after if there is one; the agent asks for an
approach, criteria, or critical assumptions rather than approval or a forced list of defects. The
advisor is a conversation, not a single answer: the main agent continues the same thread through the
host's resume mechanism when a material discrepancy or gap remains.

### Advisor modes

`advisorMode` inherits from global defaults unless the branch overrides it:

| Mode              | Effect                                                                                                                     |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `on`              | Enable consultation even with delegation off. Requires a valid Advisor model; no ordinary roles are required in that case. |
| `off`             | Inject no Advisor guidance and keep the saved model and thinking policy.                                                   |
| `with-delegation` | Consult only while delegation is active and an Advisor is configured. Default when the key is absent.                      |

Use **Advisor mode** in the panel, `/delegate advisor on|off|with-delegation`, or `/delegate reset`,
which turns both features off. `D:OFF A:ON` means consultation only; `D:OFF A:OFF` means nothing is
injected. ContextShunt stays suspended while delegation is off. Changing a mode does not cancel a
subagent the host already launched, and an explicit `on` without a model is an error rather than
implicit activation of another model.

### Errors by axis

Delegation and Advisor report separately, and neither replaces the other:

- An enabled Advisor whose model is missing, unavailable, out of scope, or unauthenticated, or whose
  configured thinking level its model does not support, produces `A:ERR` and removes only
  consultation. Valid delegation and an otherwise authorized ContextShunt reader remain available.
- An unusable Advisor state is an error only while Advisor is enabled. With Advisor off, the
  diagnostic stays informative and the footer keeps reporting `A:OFF`.
- Invalid delegation settings do not suppress a valid enabled Advisor.
- A malformed main delegation document still fails closed; a malformed or stale Advisor companion
  affects only Advisor, and it keeps its model and thinking policy only while it is readable and
  valid.

## Persistence and compatibility

The extension stores policy only: intensity, preference, Advisor mode, model references, the optional
ContextShunt configuration, and the thinking policies you configure. It never stores credentials,
prompts, or the thinking level of one run.

| File                                         | Content                                                                             |
| -------------------------------------------- | ----------------------------------------------------------------------------------- |
| `~/.pi/agent/delegation-policy.json`         | Delegation defaults, schema 7, readable by version `0.16.0`.                        |
| `~/.pi/agent/delegation-policy.advisor.json` | Advisor companion, `{ "schemaVersion": 1, "state": … }`, where `state` is schema 8. |
| Pi session entries                           | A schema 2 `off` guard, the Advisor entry, and the schema 7 delegation entry.       |

```json
{
  "schemaVersion": 1,
  "state": {
    "schemaVersion": 8,
    "intensity": "normal",
    "small": { "provider": "example-provider", "model": "example-small" },
    "medium": null,
    "large": null,
    "advisor": { "provider": "example-provider", "model": "example-advisor" },
    "advisorMode": "on"
  }
}
```

An earlier development build also wrote a `delegationDigest` in that envelope. It is still read but
never used: the companion is accepted on its parsed state, not on a hash of the delegation text.

Loading never writes. Schemas 2 through 8 are normalized in memory: a schema 2 through 5 document has
no thinking policy, a document below schema 7 carries no `advisor`, and schema 2 never accepts
`orchestrator`. Schema 1 remains inactive and is not migrated automatically. The extension restores
only the latest delegation session entry, so a future or malformed latest entry forces the branch off
with a sanitized diagnostic instead of reactivating older state, and a later entry written by an
older version cannot reuse an earlier companion. `/delegate reset` and the guard keep a downgrade
fail-closed: a reset, a schema 2 `off` guard, or an invalid restoration turns Advisor off even when
global defaults enable it.

### Compatible saves and interruption recovery

The companion is accepted only while its state parses and its delegation projection — intensity,
preference, roles, ordinary thinking, and ContextShunt — equals the delegation file's. Reformatting,
CRLF line endings, or a hand-edited key order therefore do not disable Advisor.

When the companion is absent, the delegation file is used on its own with no diagnostic. When it is
unreadable, malformed, or out of step, delegation from the main file wins and Advisor is silenced.
A readable, valid companion that is merely out of step keeps its listed model and thinking policy so a
later save can repair the pair instead of losing them; a corrupt or unreadable companion cannot
supply Advisor settings. Settings still present in a legacy delegation file are retained; otherwise,
configure the Advisor model and thinking policy again. The panel's
**Save effective configuration as defaults** re-saves the pair, and the diagnostic stays visible until
then.

Each of the two files is replaced atomically, but the pair is not a filesystem transaction:

- A save stops before its first write when either previous file exists but cannot be read, and
  reports that nothing changed, because it cannot establish the state it would have to restore.
- The companion is committed last, so an interrupted save cannot activate a new Advisor state.
- When the companion write fails, the previous delegation file is read before the save starts,
  restored, and checked. The save reports that nothing changed only when that check succeeds.
  A failure only ever reaches the caller before a replacement is committed, so a failed cleanup cannot
  undo a written file.
- When the previous state cannot be restored or verified, the save reports a partial result instead
  of claiming success: the panel reloads what the files actually hold, shows the diagnostic, and
  `/delegate status` explains it.
- A hard stop between the two replacements can still leave the files out of step. The pair then
  reports `A:OFF` with a diagnostic until the next successful save.

Before restoring, the extension checks that the delegation file still holds its own projection and that
the companion is unchanged. If either check fails, it does not restore and reports a partial save.
These checks are not a lock: another writer can change either file between a check and a replacement.

### Downgrade

New saves keep delegation in schema 7, and the Advisor state is omitted from that projection, so a
schema 7 reader such as `0.16.0` keeps reading delegation and simply ignores the companion. This
guarantee is for schema 7 readers; earlier versions keep their existing limitations. Additional steps
before installing an older package:

1. For a package that cannot read schema 4, set global and branch ContextShunt mode to `off`.
2. For `0.6.0`, set intensity to `off`, `normal`, or `aggressive`, and run `/delegate off` in every
   active branch.
3. For `<=0.5.0`, also convert global defaults to schema 2 and replace ordinary `null` values with
   exact model references.

## ContextShunt

`contextShunt.mode` is independent from delegation intensity: `off` is the default and does no
classification, metrics, archive I/O, or interception; `observe` records decisions without changing
calls or results; `enforce` covers only recognized native reads, conservative bounded PowerShell
reads, and known successful textual results. Delegation `off` suspends the effective mode without
deleting the saved preference.

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
configuration. It requires a compatible external executor: protocol version `0.69.0` is the verified
one, and another build fails closed with `reader-unavailable`. **Context advanced** in the panel edits
these values and each limit, and **Reset ContextShunt draft** clears all branch values. Schema 4 still
accepts a positive `limits.readerOutputBytes` from older files, but ignores it and never writes it
again.

Read [limits and privacy](/limits-and-privacy/#contextshunt-reader) for the
request, the answer contract, and retention.
