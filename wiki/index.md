---
layout: home
title: pi-delegation-policy
description: Configure delegation intensity, exact role model references, and optional thinking policies for Pi.
hero:
  name: pi-delegation-policy
  text: Delegation guidance for Pi
  tagline: Choose when to delegate and which exact enabled models guide the work.
  actions:
    - theme: brand
      text: Install the extension
      link: /getting-started/
    - theme: alt
      text: View the source
      link: https://github.com/Yivas/pi-delegation-policy
features:
  - title: Delegation policy
    details: Set an intensity and preference, with explicit model decisions for Small, Medium, and Large.
  - title: Optional roles
    details: Configure Visual Design and Advisor without changing the ordinary-role minimum.
  - title: Thinking policy
    details: Leave thinking unset per role, fix a level, or configure an inclusive range.
  - title: ContextShunt
    details: Protect recognized oversized context through a separate opt-in layer.
---

`pi-delegation-policy` is a local Pi extension that guides the main agent on when delegation is worth it and which exact models to use for Small, Medium, Large, and the optional Visual Design and Advisor roles. It adds guidance to the system prompt and nothing else: it does not route, supervise, or collect delegated work, and it never changes Pi's main model, thinking level, or tool permissions.

::: warning
The extension injects guidance only while an active configuration is valid. It cannot guarantee that another system follows a configured role or thinking choice. ContextShunt is off by default, is not a sandbox, and does not create an automatic worker bridge.
:::

## Start here

Version **0.17.0** requires Pi `0.87.1` or later (`>=0.87.1`). Version `0.14.1` supports Pi `0.84.3` or later (`>=0.84.3`).

1. [Install the extension and reach a valid status](/getting-started/).
2. [Configure models, intensity, and thinking policies](/configuration/).
3. [Operate the panel and read status](/commands-and-status/).
4. [Review limits and privacy](/limits-and-privacy/).

## Configuration at a glance

- **Intensity** — `off`, `normal`, `aggressive`, or `orchestrator`, set globally or per branch.
- **Roles** — an exact `provider/model` reference or an explicit disabled decision for each ordinary role, plus optional Visual Design and Advisor roles.
- **Thinking** — an optional fixed level or inclusive range per role, or no policy so the main agent chooses for each launch.
- **ContextShunt** — a separate opt-in layer that bounds recognized oversized context without launching a worker.

## Availability

Independent Advisor mode and its companion file are available from version `0.17.0`. A configuration saved without an explicit Advisor mode keeps the previous behavior: Advisor is consulted only while delegation is active. Selecting `on` enables consultation with delegation off.

## Product boundary

The extension guides the main agent. It does not run, route, supervise, or collect delegated work, and it does not change Pi's main model, thinking level, or tool permissions. The main agent launches the Advisor as a normal subagent when the configured policy calls for consultation.
