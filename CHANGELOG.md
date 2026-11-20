# Changelog

## 0.4.0 — 2026-11-20

Minor version: memory editing is a new capability, and two context defaults changed
(past reasoning is stripped, injected blocks are replaced rather than appended).
No database migration.

### Added

- Memory can now be edited from the settings page: change a fact value (written as a new
  version, old one kept), change its category, delete a fact or an episode with a reason.
  Deletions and edits both leave an audit row; ownership (user/entity) is deliberately not
  editable, because that would be forging the source.
- The session picker has a filter (title, path or id) — with dozens of sessions the old list
  was unusable.
- The header shows when data last arrived and when memory was last injected. Without those
  two timestamps there was no way to tell a working install from a silently broken one.

### Fixed

- Injected memory no longer accumulates in the conversation. Each turn used to append a fresh
  block, so a long session carried 84 rule blocks, 88 fact blocks and 51 episode blocks — the
  same rules restated dozens of times. A change now replaces the previous block instead of
  appending, and stale duplicates collapse to the newest one, so exactly one memory block is
  ever in front of the model.
- The injection diagnostic log had silently stopped writing: it referenced a variable that
  no longer existed, and the surrounding try/catch swallowed the ReferenceError. `inject.log`
  had been frozen since the delta refactor, which is why "is injection working?" kept needing
  manual archaeology.
- Past reasoning is stripped from the context sent to the model (`context.stripReasoning`,
  default on). In a real group session reasoning was 97% of the assistant text, and leaving it
  in made the model imitate its own earlier thinking — the wobble that persisted after the tool
  itself was fixed. It stays in the session log for inspection.
- Sessions that leave scope no longer keep carrying memory: blocks injected earlier were left
  in history and travelled with every later request. They are now removed, without injecting
  anything new.

## 0.3.1 — 2026-11-17

Fixes only. Two tuning keys are new (`extract.lookbackMinutes`, `extract.lookbackRows`)
but they only shape the fixed behaviour, so this stays a patch.


### Fixed

- Extraction looked at the current turn only. In a group chat that is usually one
  message (85% of turns in a real database), so pronouns had nothing to resolve
  against: "你不是喜欢三轮电摩吗" arrived alone and 你 became whoever the model
  guessed. The window is now time-based (`extract.lookbackMinutes`, default 5,
  `lookbackRows` default 12): earlier messages are supplied as 前文 for resolving
  references only, and the prompt says to extract from the current messages alone.
- Silence is now recognised at the dispatch layer (`tools/execute`), not only from
  the top-level tool names of one stream. Agent presets that expose a single
  `run_code` tool call Tide's tools inside the program, where the name never
  appears on the outer stream — the model could decline and nothing noticed. The
  egress gate also consults the declared-silent flag now, so later steps in the
  same turn stay quiet.

## 0.3.0 — 2026-11-17

Minor version: two configuration keys are gone and the silence path now depends on a
tool that was previously never registered. Existing databases need no migration.

### Breaking

- `extract.provider` and `extract.model` are removed. If a deployment set them,
  nothing breaks at load time — they are simply ignored, and extraction follows the
  session model instead. Delete them from your patch to keep the config honest.

### Changed

- **The plugin no longer chooses a model.** Extraction used to require
  `extract.provider` / `extract.model`, and the shipped patch handed out
  placeholders, so every turn quietly extracted nothing. Extraction now follows
  the model the session is already using (taken from `agent/pre-step`), passes
  the same reasoning effort, and skips the call when no selection is known.
  Two configuration keys and two placeholder lines are gone.
- The rule block is re-sent every `context.ruleRefreshTurns` turns (default 20,
  `0` disables). Sending rules only when they change meant that a long session
  eventually carried them far enough back to be compacted away, which is how
  "don't answer with a placeholder" got forgotten within the same evening.

### Added

- The `stay_silent` tool is registered whenever tools are enabled, not only when
  the egress gate is on. With the gate off the tool was missing entirely, so a
  model that wanted to decline had nothing to call and improvised a placeholder
  line — `（图跳过）`, or a bare `。`. Declining now has a route that does not
  depend on an unrelated switch.
- A group-scoped rule (`rule.group_silence_tool`) that tells the model to end the
  turn through that tool. The tool contract says the same thing, because the rule
  block only reaches the model when context injection is enabled while the tool
  schema always does.

### Removed

- An earlier attempt filtered punctuation-only and bracket-only replies out of the
  stream. That was the wrong layer: once the model has produced text, guessing
  whether the text "means anything" is unbounded and brittle. Silence belongs
  upstream — the routing gate, or an explicit tool call.

### Fixed

- Event rows now carry the evidence record of the speaker they were attributed to,
  not always the newest message in the turn.
- Speakers in one turn are labelled uniquely (`名字#2` on a nickname clash) so two
  members with the same nickname no longer collapse onto one person.
- Search now fetches several times more candidates, and reserved slots go to hits from
  other conversations first — same-conversation hits are already covered by the recent
  list, so reserving for them fixed nothing.
- Episodes dropped by the character budget are no longer recorded as sent; they get
  another chance next turn instead of disappearing.
- Relevant episodes never reached the context when the current conversation already
  had its fill of recent ones: the candidate list was recent-first, hits-last,
  then truncated, so a cross-session hit was dropped every time. Two slots are now
  reserved for search hits (`context.eventRelatedReserve`, 0 restores the old
  behaviour) and spare slots still fall back to recent episodes.
- A turn carrying several speakers attributed every extracted candidate to the last
  one, and graded all of them with one provenance tier. Extraction now labels each
  source line with its speaker, keeps `speaker` on every candidate, and resolves
  user, evidence record and tier per item. Unknown or missing speakers fall back to
  the previous single-speaker behaviour.
- `fact_get` described itself as returning historical versions while the query only
  returns each candidate's current value and status. The description now matches.

- `scripts/seed.mjs` referenced `defaultDbFile` without importing it, so it threw
  on every run.

## 0.2.8

### Fixed

- **Injected facts did not say whose they were.** The speaker label was only
  rendered for group chats; a private conversation got a bare statement
  (`pref.other.local_resources: ...`) with no subject, so the model had to infer
  ownership from the key prefix — and `other.*` means "not the owner", not "the
  person you are talking to".
- Worse, de-duplication outside groups keyed on the canonical key alone, so two
  people with the same key collapsed into one line and one person's fact was
  silently dropped. De-duplication now always includes the user id, and a block
  containing more than one person labels every line.
- When every fact in the block belongs to one person, the header names them once
  instead of repeating a prefix on each line.
- The nickname of a fact's owner is now looked up for every conversation type,
  not just groups. A missing nickname renders as a short `id:` prefix rather than
  a bare 6-character fragment.

### Added

- Probe 47 covers the owner labelling, the collapsed-duplicate regression and the
  no-nickname fallback.

## 0.2.7

### Fixed

- **Rules were ranked by edit time, which buried the most important ones.**
  `selectRuleFacts` ordered rules by `updated_at DESC`, so rules written once
  and never edited — every redline and every authority rule — sorted last and
  were cut by the character budget. In a 44-rule database the block fit 16
  lines and not one redline survived. Ordering is now by importance
  (`redline` → `auth` → everything else, stable by key), and `limit` no longer
  truncates before the budget does.
- The default rule budget was 1800 characters, too small for a mature rule set.
  It is now 5000. Rules are injected as a delta, so a larger block only costs
  when it actually changes.
- Truncation used to be silent. It now logs `rule-truncated` with the number of
  rules dropped.

### Added

- **Per-conversation rule scope** (schema 14, `fact.applies_to`):
  `any` / `group` / `private` / `local`, default `any`. Rules are filtered by the
  conversation type they belong to, so a browsing routine or a scheduled push
  stops costing every turn in an unrelated chat. The split is deliberately
  coarse — scheduled work cannot be told apart from an ordinary local session,
  so it shares the `local` bucket rather than being guessed at.
- Rule presets accept an optional `appliesTo`; `scripts/seed.mjs` writes it.
- Probe 46 covers scope filtering, the priority ordering and truncation reporting.

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
