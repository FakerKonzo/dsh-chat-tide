# Changelog

## 0.2.1

### Fixed

- The published package now includes CONTRIBUTING.md and RELEASE.md, so the
  advertised `npm test` runs after install instead of failing on missing docs.
- Probe 28 skips its wake assertion when sqlite-vec's platform package is
  absent, instead of reporting a failure for an environment it cannot control.

### Changed

- README states the installation weight honestly: about 300MB of dependencies
  (onnxruntime and friends) before the model itself is downloaded.

## 0.2.0

### Added

- Scope is selectable on the plugin page: follow dsh-qqbot (default), a specific
  workspace, specific sessions picked from a list, or off.
- `/tide/api/sessions` lists recent sessions (title, workspace, time) for that picker.
- Attention labels are normalised on write: leading subjects and instruction
  clauses are stripped, descriptions are kept, nothing is truncated.
- `scripts/attention-doctor.mjs` reports labels needing rework, missing vectors,
  orphan vectors and duplicate labels; `--fix` applies the repairs.
- CI runs every probe plus the naming, dead-config and docs checks on Node 22 and 24.

### Changed

- Waking only screens group chats; private and local sessions pass through.
- Routing scores the current human message alone instead of every block in the
  step payload, which used to drag one-word messages across the threshold.
- Attention thresholds recalibrated from measurements: 0.48 hit, 0.03 gap.
- Extraction is told who is speaking, so a group member's words are no longer
  written as the owner's facts.
- The embedding model stays bge-small-zh; bge-base measured 0.01 AUC better at
  three times the latency.

### Fixed

- Image-only messages are rejected instead of merely logged, and QQ's `[图片]`
  placeholder no longer counts as text.
- `routing.uncertainPolicy` now decides the action instead of only naming it.
- Re-extraction records the source scope instead of leaving facts as `unknown`.
- The status route registers through `ctx.inject(['webServer'])`, so a restart or
  a web-service rebuild no longer leaves it 404.
- The package ships `probes/`, so the advertised `npm test` works after install.

## 0.1.1

First repository snapshot.
