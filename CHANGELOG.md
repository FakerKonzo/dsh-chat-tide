# Changelog

## Unreleased

_Work in progress. Published as part of the next release; see RELEASE.md for what triggers one._

### Changed

- The optional chat preset is now `tide-persona`, shown as “Tide 人格”. The old id read like the
  package name backwards and was easy to confuse with it.

## 0.6.4 — 2026-11-26

Fixes only: memory-block retirement no longer writes events outside an open step (which made
sessions fail to load), and host markers are kept out of stored memory.

### Fixed

- The repair tool now remaps **every** seq reference, not a guessed subset: `surfaceOp`,
  `sourceEventSeqs`, `developer/message.headerSeq`, `command/done.sourceEventSeq`, `messageSeqs`,
  `shadowedSeqs`/`shadowedRange` and `throughSeq`. Missing `headerSeq` shifted a developer
  message onto the wrong header and the session still would not load. If any reference points at
  an event being removed, the tool now refuses to write rather than silently re-pointing it, and
  it re-validates the result before replacing the file.
- **A session could become unloadable.** To drop a stale memory block from the request, Tide
  replaced it with an empty system message — but wrote that event during `agent/pre-step`, before
  the host opens the step, and again after `turn/end`. The host requires `system/message` to fall
  inside an open turn **and** step, so it later rejected the whole log with
  `system/message does not match an open turn and step`. Retirement now happens on `step/start`
  (a legal position, still before the request is built), and only for blocks whose text differs
  from what this turn should show.
- Host markers were stored as conversation. Lines the host injects — `Time sampled while
  preparing…`, `[model changed: …]`, `Browser time zone…`, `<system-reminder>` blocks — leaked
  into the raw log when they were glued to a real message, then got extracted as facts and events.
  Ingest strips them now, and the repair pass skips them.
- `scripts/repair-session-log.mjs` ships with the package to fix logs already damaged by older
  versions: `--scan <sessions dir>` reports, adding `--write` removes the misplaced events and
  renumbers seqs with every reference fixed. Run it with DSH closed. The output keeps the host
  container layout — frame 0 holds only the header line — which is what a naive single-frame
  rewrite got wrong and made logs unreadable even after the events were fixed.

## 0.6.3 — 2026-11-23

Fixes only: import updates rules in place, a stale preview can no longer be applied, and
the two client probes no longer depend on a Windows path.

### Fixed

- Importing a rule that already exists now updates that rule in place: the fact id, attribution and
  evidence tier stay, and only the value and scope change. Previously the import could only add or
  overwrite blindly, so a group-only rule could come back as a global one.
- The import preview could still be applied after the input changed: a stale response could win a
  race against a newer paste. Responses now carry the input version and are dropped when it moved.
- Two client probes read the module from a hard-coded Windows path, so CI failed on Linux before any
  assertion ran. They now resolve the module relative to their own location.

- Imported rules lost their scope: the plan dropped `appliesTo`, so a rule meant for groups was
  stored as a global rule and reached private chats too. The scope now travels with the plan and
  is asserted after import.
- The import preview could still hide changes: the "show every change" toggle only appeared when
  more than eight *settings* changed, so ten changed rules still listed eight, and each rule body
  was cut at 80 characters. The toggle now counts rules too, and bodies are shown in full.
- Editing the pasted JSON kept the previous preview, so confirming imported what was previewed
  earlier rather than what was on screen. Editing clears the preview; you must preview again.
- A failed backup verification left the copy behind and the read-only connection open. Both are
  cleaned up now, alongside the existing abort and error paths.
- Collapsing "More" threw `setOpen is not defined`: the helper was used but never declared.
  A regression check now asserts it exists.

## 0.6.2 — 2026-11-23

Fixes only: conditional fields, the import preview, and backup cleanup.

### Fixed

- Conditional fields never actually hid: the condition sat inside an options object that the page
  read as if it were the condition tuple, so it passed for every value. The field shape is now
  explicit — `[key, label, type, options, when, opts]` — and a field can depend on more than one
  switch. Turning off memory lookup now also hides cross-chat memory and the private-chat filter,
  instead of leaving them visible but inert.
- The import preview listed only the first eight changes while applying all of them, and showed
  rule changes as a count. There is a "show every change" toggle now, including each rule's
  content and the scope it applies to.
- A backup download that the client aborted left a complete copy of the database on disk: the
  read stream was never destroyed and only the file was removed. Downloads now go through
  `pipeline` and the whole temporary directory is removed on completion, abort or transfer error.

## 0.6.1 — 2026-11-23

Fixes only: the settings page rendered blank after loading.

### Fixed

- The settings page came up blank after loading. Its initial state lacked the collapse and
  advanced-shown fields, so the first group render read a property of undefined. A render probe
  now drives the loaded state as well as the loading state.

## 0.6.0 — 2026-11-23

Minor version: the settings page is reorganised, automatic remembering gained a master switch, and
export/import/backup arrived. No database migration.

### Added

- Export, import and backup, on the settings page. Export writes settings, persona and rules to
  one JSON file; import previews the differences first and only touches settings and rules.
  Backup takes a consistent snapshot (writes still in the WAL included), reopens it read-only to
  verify integrity and row counts, then hands over the file.
- `extract.enabled`: one switch for automatic remembering. Turning it off stops normal extraction
  **and** the repair pass, which used to keep writing behind the user's back; raw chat logs stay.

### Changed

- The settings page is now four blocks: Everyday, Your bot, More, Advanced. Everyday holds the
  five things a user actually changes; tuning knobs sit behind "Show advanced settings" and
  deployment-only switches (preset registration, subagents, grey-zone model fallback) are off the
  page. Field labels were rewritten in plain language, and dependent fields appear only when the
  switch they depend on is on.
- Identity and persona are saved as text again. The value check keyed on a hand-maintained list of
  string fields, so every new text field (owner openids, persona mode, persona text) failed with
  `not-a-number`. The type now comes from the field declaration itself.
- Controlled fields reject values outside their declared options, and time fields are validated
  instead of being stored as free text.

### Fixed

- Clearing a number input stored 0, which silently zeroed a budget. Empty input is no longer
  coerced.

## 0.6.5 — 2026-11-26

Fixes only: the session-log repair tool now remaps every seq reference and refuses to write when a
reference would dangle.

### Fixed

- The bundled patch shipped `scope.mode: allowlist` with placeholder peers, so a fresh install
  matched no session and looked broken. The default is `follow` now (QQBot sessions plus local
  chats in the same workspace), and the placeholders are gone. The guides also stop telling people
  to edit `dsh.profile.bundles` by hand: the plugin manager adds an installed bundle there itself.

### Changed

- The README is a one-screen summary now: what the plugin is, the facts a reader (or an AI
  assistant) needs to compare it with alternatives, and links. Step-by-step install and usage
  moved to `docs/INSTALL.md` (`docs/INSTALL.en.md` for English), which also covers the everyday
  switches, the bot identity and persona settings, and where to look when something is off.
- A doc check fails when the README links to a repository file that does not exist.

## 0.5.3 — 2026-11-23

Fixes only. Two data-integrity bugs: an edited fact kept its old value in the request, and repair
extraction credited a whole round to one speaker.

### Fixed

- Editing a fact left the old value in the model request. Filtering messages in `agent/pre-step`
  could not work: the host appends those messages and derives the request from the whole session
  surface. Old memory nodes are now retired on the surface itself, each replaced by an empty
  system message, so the previous value stops reaching the model while the log keeps it.
- Repair extraction attributed every message of a round to the last speaker, because it joined the
  messages and kept only the final sender and record id. Each message is now labelled and bound to
  its own sender, and candidates that do not name a real label are dropped.

## 0.5.2 — 2026-11-22

Settings only: identity and persona lead the page, and the owner field left the injection-budget
group where nobody would look for it.

### Fixed

- The owner field sat inside the injection-budget group, where nobody would look for it. Identity
  and persona now lead the page: they are what a new install needs to decide first.

## 0.5.0 — 2026-11-22

Minor version: rules and persona moved into the system prompt, and the plugin can register its
own chat preset. Several security fixes change who counts as the owner — read the Security
section before upgrading. No database migration.

### Security

- Owner identity is resolved from the QQ adapter's live configuration when `owner.ids`
  is empty: the host `configEditor` service is read, and the adapter's private-chat list
  is used only when `c2cMode` is `open` — under `allowlist` that same list is an access
  control list, and treating it as privilege would promote everyone allowed to chat.
  A missing plugin, a missing service, or an empty list all resolve to "no owner" with a
  logged reason.
- Owner identity can be adopted explicitly: `POST /tide/api/owner/adopt` writes the chosen
  openid into `owner.ids`, accepting only identities that already have a binding. There is no
  inference step and no automatic promotion.
- Private-chat messages are attributed by the `[name (openid)]` tag in the text, same as group
  messages, instead of always being credited to the bound peer.
- Private-chat bindings no longer grant owner identity. The QQ adapter defaults `c2cMode` to
  `open`, so **any** user who messages the bot privately gets a c2c binding; treating that as
  authorization made "whoever DMed me" the owner, and rules from that user were then admitted.
  Owner identity now comes only from `owner.ids`, with a warning logged when it is unset.
- Owner identity no longer comes from memory. It used to be inferred from the existence of
  `owner.*` facts, which made content grant permission: one writable ordinary fact naming a
  user was enough for that user to be treated as the owner, and therefore to have rules
  admitted. Identity now comes only from `owner.ids` in configuration and from the private-chat
  binding that the adapter already whitelists.

### Fixed

- A group member's suggestion could be extracted as `rule.*`, which is a **global** rule — one
  sentence from anyone would then apply to every conversation. Rules are now refused unless
  the speaker is the owner, both in the prompt and by a hard filter on the parsed items.
- Two speakers who share a nickname were treated as one person (the multi-speaker test used
  distinct *names*), so everything was attributed to whoever spoke last. It now counts
  distinct users.
- A turn with no messages of its own fell back to the whole lookback window, re-extracting
  messages that had already been processed. Empty turns now do nothing.
- The "already sent" episode set did not match the block that was actually rendered: it was
  built from the delta while the block carried the full list, so budget-truncated episodes
  were either re-sent forever or never sent.
- Lookback context could push the current message out of the extraction text when the window
  was tight. The current message is now reserved first and the prior text is trimmed from its
  head.
- Only a few search candidates were fetched, so a conversation with many same-session hits
  could hide the cross-session one that mattered. The candidate pool is wider now.
- Rule admission now checks the candidate's **subtype** as well as its key: rules are read
  by subtype, so a key outside the `rule.` namespace could smuggle a global rule in. Identity is also required —
  the repair path used to run without it, and an unknown speaker was treated as allowed.
- In a multi-speaker turn, a candidate without a matching speaker label is dropped instead of
  being attributed to whoever spoke last. A wrongly attributed fact is worse than a missing one.
- `extract.lookbackMinutes: 0` used to disable extraction itself, because current-turn rows
  were read from the same time window. The current turn is now selected by correlation id and
  the window only limits the prior context.
- Speaker labels were applied by array position after unnamed records had been filtered
  out, so a message without a nickname shifted every later label and its evidence onto the
  wrong person. Labels are keyed by record id now, and unnamed records keep a placeholder
  label instead of disappearing.
- Our prompt sections are registered with `interpolate: false`: rule or persona text
  containing `{{...}}` must not be rendered as a template by the host.

### Added

- A **chat preset** (`tide-chat`) can now be registered by the plugin itself
  (`preset.enabled`, default off) instead of being hand-written into a profile patch. It is
  the host minimal preset plus what chat actually uses — file read/write, shell (for browser
  CLI), schedule, skills, time context, file search — and it deliberately leaves persona
  incomplete so workspace docs (AGENTS/SOUL) still load. Registration is disposed cleanly
  when the switch is turned off.

### Changed

- **Rules moved into the system prompt.** They used to travel as a user message, which made
  them look like something the user said, let compaction summarise them away, and forced a
  periodic re-send (the old `context.ruleRefreshTurns`). A plugin-assembled section is
  stronger, always present, and costs nothing extra: it is scoped by the same session check
  the rest of the plugin uses, and it disappears cleanly when the plugin is disabled.
- **Persona is now a choice, not a fixture.** `persona.mode` defaults to `off`, which leaves
  identity and style entirely to the workspace docs (AGENTS/SOUL). Set it to `custom` and
  `persona.text` becomes a system-prompt section. Nothing is appended when the text is empty.

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

### Changed


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
