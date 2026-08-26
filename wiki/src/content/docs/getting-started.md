---
title: Installation
description: Install pi-delegation-policy and start with a safe session state.
---

## Requirements

- Pi `0.84.1`.
- Access to npm when installing the published package.

## Install from npm

Install the package in your Pi user settings:

```bash
pi install npm:pi-delegation-policy
```

Restart Pi or run `/reload` after installation.

## Install a local checkout

To test a local checkout from its parent directory, point Pi at the package folder:

```bash
pi install ./pi-delegation-policy
```

## Start safely

A new session inherits global intensity when configured and otherwise uses the built-in `off`
default. A branch can override that value or return to **Use global default**; a fork restores the
latest valid delegation entry in its history. Open `/delegate` to choose the behavior you want.

## Next step

Continue with [configuration](/pi-delegation-policy/configuration/) to define global defaults and
understand how session branches override them.
