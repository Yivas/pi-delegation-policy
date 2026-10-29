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

Global defaults may contain intensity, preference, tri-state ordinary roles, the `uiDesign` key, ordered `advisors` with per-entry thinking, independent
`advisorMode` and `advisorLaunch`, and thinking policies per execution role. If global intensity is
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

## Configuration change notice

From `0.22.0`, a change to effective delegation settings adds one extension-owned notice to the
requests of the next user turn. It names the previous and new intensity, preference, role models,
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

Advisor is optional, off by default, and outside the ordinary-role minimum. Configure **Advisor 1**
and optional **Advisor 2**, each with an exact model and thinking policy. Every valid advisor gets the
same question. Weigh disagreements; agreement is not proof. The packaged no-tools/no-extensions
`pi-delegation-policy.advisor` profile advises and executes nothing.

**Advisor launch** inherits globally or per branch, defaulting to `role`:

- `role`: the main agent launches every valid advisor in one background subagent call, with exact
  models and thinking. The extension observes matching attempts but does not launch them.
- `tool`: the always-registered `consult_advisor({ question, brief? })` launches one child per valid
  advisor in parallel through the public `pi-subagents` delegation API, admitted only for the exact
  builds whose launch contract was verified (`0.76.1` and `0.83.1`). Otherwise it returns unavailable
  text. No model, provider or executor fallback is added.

Both modes ask for consultation after orientation before substantive work, when stuck, before changing
approach, and before declaring a multi-step task done (ask for remaining risks, not approval). Short
reactive steps and mechanics in a settled approach need no new call.

Context is `fork` while the session fits in half of every valid advisor's window, `fresh` above that or
with an unknown window, and returns to fork below 35%. Unknown token usage keeps the last mode. Fork
sends the conversation to each provider, with only the question as the task. Fresh requires a short
self-contained `brief`: objective, constraints, relevant facts, options and uncertainty. The tool
retries only an explicitly rejected fork, once with fresh and only with a supplied brief. Fixed thinking
uses its exact level; a range uses its maximum; unset uses `high` if supported, otherwise the first
supported level. Role mode leaves range/unset selection to the main agent.

One pending call per tool: an advisor group launches one child per configured valid advisor, while the
independent reader can run alongside it (at most three children). Abort, branch change, shutdown and
detected authorization changes cancel the tool group. Partial results preserve a successful answer.
Local timeouts and cancellation do not cap external generation, retries or cost.

**Advisor mode** is an independent axis you set in the panel or with `/delegate advisor …`:

| Mode              | Effect                                                                                                     |
| ----------------- | ---------------------------------------------------------------------------------------------------------- |
| `on`              | Consult with delegation off. Requires a valid Advisor model; ordinary roles are not required in that case. |
| `off`             | Inject no Advisor guidance and keep the saved model and thinking policy.                                   |
| `with-delegation` | Consult only while delegation is active and an Advisor is configured. Default when the key is absent.      |

`D:OFF A:ON` shows consultation-only guidance; `D:OFF A:OFF` means neither axis injects a policy block. `/delegate reset`
turns both off for the branch; `/delegate off` leaves an independently enabled Advisor active.

### Errors by axis

Errors are reported per axis. Each entry validates independently: `A:ON` means all valid, `A:PART` means one of two valid
(consult that one), and `A:ERR` means none usable and removes only consultation: valid delegation and an otherwise authorized ContextShunt reader keep working.
`D:ERR` removes delegation guidance and leaves a valid enabled Advisor alone. A malformed main
delegation file still fails closed, and a malformed or stale Advisor companion affects only Advisor:
delegation from the main file wins, and the companion keeps its saved model and thinking policy only
while it is readable and valid, so the next save repairs that pair. A corrupt or unreadable companion
cannot supply Advisor settings. Settings still present in a legacy delegation file are retained;
otherwise, configure the Advisor model and thinking policy again.

Consulting sends a brief, or with `fork` the conversation so far, to another model and can incur
latency and cost, including with delegation off. The host sends it only after an explicit launch or tool call, never from a hook. See the [limits and privacy reference](https://yivas.github.io/pi-delegation-policy/limits-and-privacy/)
for the signals and the retention of the executor and its provider.

### Provider extension

The default profile remains `pi-delegation-policy.advisor`, with no configured tools or extensions.
For each configured Advisor, the **Advisor 1 provider** or **Advisor 2 provider** row offers an
explicit **Anthropic auth 3.4.3** opt-in. It selects the separate package profile
`pi-delegation-policy.advisor-anthropic-auth` in both role and tool mode. The model and thinking
stay unchanged; role launches remain background. In configuration this is
`providerExtension: "anthropic-auth"` on that Advisor entry, available in schema 10. Absence means
the standard profile. Only provider `anthropic` is supported; an incompatible selection is an
Advisor error, never a fallback to the standard profile or another model.

This option runs the installed `@gotgenes/pi-anthropic-auth` **3.4.3** extension as trusted host
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
reimplemented. The option is available from 0.23.0.
One bounded fresh/background real-provider consultation completed on Pi 1.4.0 with pi-subagents
0.83.1. Launch metadata showed the prompt runtime and provider bridge, no required extensions and no
observed tool calls. Fork, `consult_advisor` and other builds were not validated by that run.

With any provider opt-in saved, the extension companion uses envelope 2 containing the full schema-10
state and an exact normalized schema-8 base with Advisor off. The legacy companion also has Advisor
off. Readers through 0.22.2 therefore leave **all Advisors off**, preserving ordinary delegation,
rather than run a provider-dependent Advisor as a standard one. Missing, corrupt or stale envelope-2
state leaves them off until repaired. Without an opt-in, the envelope-1 format below is unchanged.

## Persistence and compatibility

- Global defaults: `~/.pi/agent/delegation-policy.json`, schema 7 delegation only.
- Legacy companion: `delegation-policy.advisor.json`, envelope 1 with schema 8 state for Advisor 1.
  Versions `0.17–0.20` see its mode, model and thinking in role mode; `0.16` sees delegation without
  Advisor. None of those versions sees Advisor 2 or tool launch.
- Advisor extension: `delegation-policy.advisor-extension.json`, envelope 1 with normalized schema-8
  `base`, optional `advisor2` (including thinking), and `advisorLaunch`. Missing, invalid, unreadable
  or mismatched state falls back to Advisor 1 and role launch with a diagnostic, not `A:ERR` for a
  valid first advisor. Older versions ignore it.
- Session Apply: schema 2 off guard, extension entry, schema-8 companion, then schema-7 delegation
  commit. The legacy companion remains adjacent to that commit. A failure leaves both axes off.

Schema 9 accepts ordered `advisors: [{provider, model, thinking?}]` with 1–2 entries and inherited
`advisorLaunch: role|tool`. An omitted list inherits; a list replaces both entries and their thinking;
session `advisors: null` disables. Legacy `advisor` and `thinking.advisor` are single-advisor shorthand,
not combinable with `advisors`. Schemas 2–9 resolve into the schema-10 effective state in memory without writing.

### Compatible saves and interruption recovery

Global saves replace delegation, companion, then extension, individually atomically, not as a
transaction. All three previous files must be readable or absent. On failure, restore and verify only
our committed prefix, never a detected foreign write; otherwise report partial save and reload disk.
Checks are not locks. A crash can leave Advisor off or Advisor 1 only in role mode until repaired.

Content-free events go to `~/.pi/agent/delegation-policy.events.jsonl` (or Pi's configured agent dir):
time, extension version, SHA-256 policy-block hash when it changes, intensity, Advisor modes, context
and count; consultation model IDs, status, context and duration. Role observations are attempts, not
proof of completion; duration zero means unknown. Questions, briefs, answers, conversations, project
paths and raw errors are excluded. Writes are serialized, rotate at 256 KiB to one `.1` backup, and
failures never break a request. Shutdown drains queued writes for at most five seconds. No network telemetry is sent; model identifiers can still be sensitive.

### Downgrade

Before downgrading to a package that cannot read schema 4, set global and branch ContextShunt to
`off`. Before downgrading to `0.6.0`, set intensity to `off`, `normal`, or `aggressive` and run
`/delegate off` in every active branch. For `<=0.5.0`, convert global defaults to schema 2 and
replace ordinary `null` values with exact references. The downgrade guarantee of this line is for
schema 7 readers such as `0.16.0`; earlier versions keep their existing limitations.

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
configuration. It requires a compatible external executor: `pi-subagents` `0.76.1` on Pi `1.1.0` is the
only verified combination, and another build, including `0.69.0`, fails closed with
`reader-unavailable`. **Context advanced** in the panel edits
these values and each limit, and **Reset ContextShunt draft** clears all branch values. Schema 4 still
accepts a positive `limits.readerOutputBytes` from older files, but ignores it and never writes it
again.

Read [limits and privacy](/limits-and-privacy/#contextshunt-reader) for the
request, the answer contract, and retention.
