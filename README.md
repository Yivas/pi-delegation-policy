<h1 align="center">pi-delegation-policy</h1>

<p align="center">Delegation guidance for Pi: when delegation is worth it, which exact model does the work, and an optional Advisor that answers with advice only.</p>

<p align="center">
  <a href="https://www.npmjs.com/package/pi-delegation-policy"><img src="https://img.shields.io/npm/v/pi-delegation-policy" alt="Version on npm"></a>
  <a href="https://www.npmjs.com/package/pi-delegation-policy"><img src="https://img.shields.io/npm/dm/pi-delegation-policy" alt="Monthly downloads on npm"></a>
  <a href="https://www.npmjs.com/package/pi-delegation-policy"><img src="https://img.shields.io/npm/l/pi-delegation-policy" alt="License on npm"></a>
</p>

[Documentation](https://yivas.github.io/pi-delegation-policy/) · Version **0.35.0**

Requires Pi `0.87.1` or later (`>=0.87.1`). Version `0.14.1` supports Pi `0.84.3` or later.

## What it does

It adds one policy to the request in two places — the marked system block, and one message carrying the same block with a revision, rebuilt on every request and never stored, so a change reaches the model even when the host keeps the system prompt it built at session start — one ephemeral notice after an effective configuration change, and an optional Advisor reminder. It never changes Pi's main model, thinking level, or tool permissions, and no hook launches a child.

It is not a subagent runner. It does not start, route, supervise, or collect delegated work. Only explicit tools reach the authorized host executor: `context_shunt_delegate`, and `consult_advisor` when Advisor launch is `tool`.

While delegation is active or an Advisor is enabled, a launch check runs before any child starts. By default it corrects three unambiguous cases, writes the exact values into the call, and refuses what it cannot settle. See [launch check](https://yivas.github.io/pi-delegation-policy/limits-and-privacy/#launch-check).

The block also asks for a brief on every child: the bounded outcome and its owner, the context already decided, the scope, the permissions and the exclusions, how it is verified, what it returns, and when it should stop and ask.

## Install

```bash
pi install npm:pi-delegation-policy@0.35.0
# restart Pi, or run /reload
```

1. Open `/delegate`, or press `Alt+G`.
2. Give each role an explicit decision: an exact authenticated `provider/model`, or **Disable for this session**. At least one ordinary role stays enabled.
3. Choose an intensity and **Apply changes**, then confirm `/delegate status`.

Global defaults live in `~/.pi/agent/delegation-policy.json`, and any branch can override them. Installing or upgrading changes no configuration: a session with no saved intensity starts at `off`.

## Intensities

| Intensity      | What the guidance asks                                                                                                                                                                     |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `off`          | No execution-delegation guidance. An independently enabled Advisor still injects its own section. With both off, no policy block is injected.                                              |
| `normal`       | Delegate substantial, separable work only when the expected benefit clearly outweighs briefing, supervision, review, and integration. Borderline work stays with you.                      |
| `aggressive`   | Delegate suitable substantial, independently checkable work by default when the objective and the acceptance criteria are clear.                                                           |
| `orchestrator` | Delegate all transferable execution before it begins when an enabled capable role and an authorized launcher exist, regardless of size. Direct work then needs a briefly stated exception. |

The [configuration reference](https://yivas.github.io/pi-delegation-policy/configuration/#intensities) states the full orchestrator rule and its exceptions.

## Roles and thinking

While delegation is active, every ordinary role needs an explicit decision: an exact `provider/model`, or disabled. A disabled role is a decision, not a missing model. An absent, unavailable, out-of-scope, or unauthenticated reference, zero enabled ordinary roles, or an unsupported thinking level on an ordinary role produces `D:ERR` and removes execution-delegation guidance, while a valid enabled Advisor keeps its own section. There is no fallback of any kind.

The policy weighs task fit and then picks the least costly enabled role that can meet the acceptance criteria. When none can, the work stays with the main agent. Preference (`efficient`, `standard`, `intensive`) only breaks ties between Small and Medium, and does nothing when either is disabled.

Visual Design, Vision and Writing are optional, hold up to three models each, and stay outside the cheapest-role comparison. A configured role adds a rule per family and a line per entry, and the block states which models the host reports as able to read images.

Thinking is unset by default, or a fixed level, or an inclusive range. Advisor thinking is not a setting, and the level chosen for one run is never stored. The [configuration reference](https://yivas.github.io/pi-delegation-policy/configuration/#roles-and-validation) covers entries, sidecars, and validation.

## Advisor

Advisor is optional and has no model until you configure one. Its mode defaults to `with-delegation`, `on` keeps consultation with delegation off, and `off` silences it while keeping the saved models. Each of the three slots takes an exact model, and every valid entry gets the same context.

- **`tool` launch** (the default): `consult_advisor()` needs no arguments, because the host writes the context from what it observed, and launches one child per advisor in parallel. It needs a stable `pi-subagents` SemVer `>=0.76.1`.
- **`role` launch**: the main agent launches every valid advisor in one background subagent call.
  While a task holds its changes, the launch must be in the foreground (`async: false`) so the
  answer arrives inside the call.

Every consultation runs in fresh context and never carries your conversation, unless `pi-subagents` itself defaults a launch to fork, which the extension cannot read. The default `composed` context sends your request, the agent's last two messages, the paths and commands it touched and the change it held back, within 12 KiB, and never command output, file contents, the system prompt or earlier conversation. The one exception to file contents is that held change: its path, its line count and up to 3 KiB of the new text travel with the context, which for a `write` can be file content, and a sensitive path is withheld; the agent's messages are only the ones from this task. `/delegate advisor context manual` goes back to a brief the agent writes. The nudge level, `standard` by default, adds a short note every few tool results. `strict` and `guard` also hold every change after several made with no consultation, until an Advisor answers. Asking the user, the task list and the supervisor channel are never held, and neither is the wait tool, recognised by its default name `bg_wait`, so a held task keeps its way to a person; a wait tool the host renamed counts as a change like any other unknown tool. Nothing releases the hold automatically: a consultation that did start and failed twice in a row gives you one notice, with the level, the launcher and the closed statuses it saw, and gives the model a refusal that says to ask you and stop, while every change stays refused, and each later pair of failures gives you one more. The hold ends with an answered consultation or with you, by fixing the Advisor, changing the level with `/delegate` and sending a new prompt, because a task keeps the level it started with, or cancelling the task, and these levels are not meant for unattended runs. A slot can also be given the `read` tool for role launches, off by default, which opens a file the brief names, though the host's own permission rules decide what `read` may reach ([SECURITY.md](https://github.com/Yivas/pi-delegation-policy/blob/main/SECURITY.md)). Consulting another model costs latency and money. `A:PART` means some entries are usable and `A:ERR` means none is.

[Advisor reference](https://yivas.github.io/pi-delegation-policy/configuration/#advisor) covers modes, threads, provider extensions, and the reading flag.

## ContextShunt

ContextShunt is a separate opt-in layer, off by default. `observe` records what enforcement would block without changing a call or its result. `enforce` blocks recognized declared excess and compacts a known textual result it has already preserved, so `context_shunt_recover` returns one bounded range. Errors, valid JSON text, images, binaries, mixed blocks, and unknown tool contracts stay untouched, nothing is launched from a hook, and delegation `off` suspends the layer. The [limits reference](https://yivas.github.io/pi-delegation-policy/limits-and-privacy/) states the caps and the answer contract.

## Commands

```text
/delegate                                      Open the editor
/delegate off|normal|aggressive|orchestrator   Set the branch intensity
/delegate status                               Show effective session state
/delegate reset                                Turn both axes off for the branch
/delegate advisor off|on|with-delegation       Set the Advisor mode
/delegate advisor launch role|tool             Select the launch surface
/delegate advisor level off|standard|strict|guard|default  Set the branch nudge level
/delegate advisor level global off|standard|strict|guard|default  Set the global nudge level
/delegate advisor level model off|standard|strict|guard|default  Set the level for this main model
/delegate advisor context composed|manual      Choose who writes the consultation context
/delegate advisor 1|2|3 model PROVIDER/MODEL   Configure an entry
/delegate advisor 1|2|3 model inherit          Return every entry to inheritance
/delegate advisor 1|2|3 model remove           Remove an entry
/delegate advisor threads status|recover|reset  Inspect, recover or reset threads
/delegate vision [2|3] PROVIDER/MODEL         Add a Vision entry
/delegate visual-design 2|3 PROVIDER/MODEL    Add a Visual Design entry
/delegate writing [2|3] PROVIDER/MODEL        Add a Writing entry
/delegate context off|observe|enforce|status   Set or inspect ContextShunt
/delegate context allow TOKEN LINES BYTES     Approve the next blocked read once
```

Panel changes stay in a draft until **Apply changes**. The commands above write when they run. Status tokens carry their source, for example `advisor-mode=with-delegation (global)` and `A:OFF`. `D:OFF`, `D:NORM`, `D:AGG`, and `D:ORCH` describe delegation, while `launches=` counts launches by role, so a configured role that never ran stays visible at zero. [Commands and status](https://yivas.github.io/pi-delegation-policy/commands-and-status/) covers the panel keys and the status fields.

## Where state lives

State lives under `~/.pi/agent`. The extension stores no credentials and no prompts.

`delegation-policy.json` (schema 7) holds the intensity, the preference, the three ordinary roles, `uiDesign`, the thinking policies, and the ContextShunt configuration. Companions sit beside it: the Advisor pair, optional entries, provider admissions, and the private threads journal. Content-free events go to `delegation-policy.events.jsonl`.

Loading never rewrites a file. [Persistence](https://yivas.github.io/pi-delegation-policy/configuration/#persistence-and-compatibility) lists the schemas each version reads and the downgrade steps.

## Development and license

```bash
npm ci
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
npm run pack:check
```

Tests use local mocks, with no paid model calls and no network. [CONTRIBUTING.md](https://github.com/Yivas/pi-delegation-policy/blob/main/CONTRIBUTING.md) covers working in this repository and [SECURITY.md](https://github.com/Yivas/pi-delegation-policy/blob/main/SECURITY.md) how to report a problem.

ContextShunt adapts the large-read routing pattern of [Spotify Engineering's Portal and `shunt`](https://engineering.atspotify.com/2026/9/portal-by-spotify-cut-my-claude-code-token-usage-by-90/) and its [`shunt` plugin](https://github.com/spotify/portal-ai-plugins/tree/main/plugins/shunt), independently for Pi, with no affiliation or endorsement.

MIT. See [LICENSE](https://github.com/Yivas/pi-delegation-policy/blob/main/LICENSE).
