# Changelog

## 0.2.6

### Added

- Group chats can hide raw tool errors from the model (`egress.hideToolErrors`,
  default on, also a switch on the plugin page). A failed tool result is replaced
  with one neutral line naming the tool and, when it is a short identifier, the
  error code; the call still fails. Only group-scoped conversations are touched:
  private chats, local sessions and subagents keep the original error text.
- Probe 45 covers the decision table (group vs private, toggle, successful call,
  blocked decision, context preservation).

## 0.2.5

### Changed

- **Breaking:** the model cache no longer lives inside the package. It defaults to
  `~/.dsh/tide/models` (`MODEL_CACHE_DIR` still overrides), so reinstalling or
  upgrading no longer throws the model away. Anyone who already downloaded the
  model into the old `node_modules/dsh-chat-tide/.cache/models` path moves or
  re-downloads it once.
- The in-process ONNX fallback is now opt-in (`embedding.allowInline`, default
  `false`). Loading ONNX in the host pins `onnxruntime-node`'s native DLLs, and
  the next uninstall cannot delete them: updating from the plugin page hangs on
  "stopping and removing the old plugin" until the host is restarted. When the
  model cannot be loaded, the embedder now reports a single actionable line
  instead of silently switching implementations.
- New `embedding.allowRemote` (default `true`). Set it to `false` to use only the
  local cache, which fails immediately instead of retrying a download.

### Fixed

- Embedder fatal messages were forwarded with a full stack, which then leaked
  into the user-facing error. Only the first line is used now.

## 0.2.4

### Fixed

- Quoted replies were dropped entirely. The qqbot adapter wraps them as
  `[Quoted message begins]…[Current message]\n[nickname (openid)] text`, and the
  ingest path tested the prefix for meta text *before* stripping the envelope,
  so the whole message — including what the person actually said — was
  discarded. Inbound text now goes through one `inboundBody()` check that
  strips the envelope first, in all three entry points (session event, pre-step
  routing and the pre-step mirror).
- The same ordering also dropped any message wrapped in
  `[Chat history begins]…[Current message]`, because the envelope was tested
  for system noise before being parsed.

## 0.2.3

### Fixed

- If the embedding child process died after starting successfully, the cached
  instance kept being handed out, so every later vector write failed until the
  host was restarted. The exit handler now marks the instance dead, rejects
  in-flight calls and clears the singleton, so the next call rebuilds it.
- `/tide/api/client-loaded` accumulated an unbounded request body. It is now
  capped at 16 KB.

### Added

- `doctor` reports `向量维度一致`, catching a database whose `vec0` tables were
  created with different widths.
- Probe 42 kills the embedding child and checks that the next call rebuilds it.
- CONTRIBUTING documents the DLL contention during upgrade and the steps for
  switching to a model with a different dimension.

## 0.2.2

### Fixed

- The session picker rendered once per settings group instead of once, because
  its condition was global. It now renders only in the scope group.

### Changed

- Scope is the first section on the settings page, before the switches.

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
