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

A new session without a delegation entry starts with intensity set to `off`, even when global
defaults exist. A branch inherits the latest valid delegation entry in the history at its fork
point. Open `/delegate` when you are ready to change that branch's model references or intensity.

## Next step

Continue with [configuration](/pi-delegation-policy/configuration/) to define global defaults and
understand how session branches override them.
