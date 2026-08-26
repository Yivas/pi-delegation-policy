# Changelog

## Unreleased

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
