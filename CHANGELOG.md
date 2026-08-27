# Changelog

## Unreleased

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
- Removed project configuration, external skill loading, tool interception, enforcement, persisted thinking, and model fallbacks.
