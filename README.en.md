# Tide — chat memory with selective waking

> A chat-memory plugin for DSH: conversations settle into facts and episodes, and the agent speaks only when it should.
> 中文：[README.md](./README.md)

## The problem

Chat agents usually fail in one of two ways: they forget, or they answer everything.

Tide treats memory as data with provenance and "should I speak" as a tunable decision: facts carry an evidence tier and a validity window, episodes are stored per speaker and scope; group chatter passes a filter first, a matching attention topic wakes it directly, anything else only gets an exploration roll.

## Compatibility

| Item | Requirement | Notes |
|---|---|---|
| DSH | `>=0.2.2-rc.1 <0.4.0` | Exercise with 0.2.2-rc.1 only; run the self-check after a Harness upgrade |
| Node | `>=22.5` | Uses the built-in `node:sqlite` |
| `sqlite-vec` | Installed with the package | Vector search |
| `@huggingface/transformers` | Installed with the package | Local embedding model, ~25–30MB download on first use |
| Cordis / `dsh-llm` / `dsh-tools` / `schemastery` | Provided by the Harness | Declared as optional peers; do not install them yourself |
| QQ adapter | Optional, tested with `@tencent-connect/dsh-qqbot@0.5.5` | Group waking depends on it; without it, memory still works for local sessions via `scope.mode: all` |

Without the QQ adapter the plugin still records and injects memory for local sessions; only the group-waking decision never fires.

## Seven steps

```
1 ingest -> 2 scope -> 3 waking -> 4 injection
                    -> 5 model turn -> 6 extraction -> 7 janitor
```

| Step | What happens | Code |
|---|---|---|
| 1 Ingest | Messages are mirrored as evidence | `lib/index.js`, `lib/events.js` |
| 2 Scope | Allowlist / preset / workspace / all | `lib/scope.js` |
| 3 Waking | An attention-vector hit wakes directly; otherwise an exploration probability applies | `lib/route-decision.js`, `lib/route.js` |
| 4 Injection | Rule block, fact block and episode block, delivered as deltas | `lib/inject.js`, `lib/context.js` |
| 5 Model turn | The host's own turn; the plugin does not take it over | — |
| 6 Extraction | Facts, episodes and attention at turn end, with retries | `lib/extract.js` |
| 7 Janitor | Dedupe, expiry, orphan vectors, attention retirement | `lib/janitor.js` |

## Memory rules

- **Namespaced keys**: `owner.*`, `other.*`, `pref.owner.*`, `todo.*`, `rule.*`, `self.*`, `rel.*`
- **Evidence tiers**: `human_explicit`, `source_verifiable`, `agent_inferred`
- **Scope isolation**: facts record `scope` (group / private / local); groups cannot see private sources by default
- **Per-speaker groups**: facts are fetched per recent speaker and rendered with names; same keys from different people are not merged
- **Undoable deletion**: soft delete plus a `tombstone` with a reason
- **Injection states, never instructs**: facts, episodes and rules are data, with no embedded commands

## Install

Package `dsh-chat-tide`, Loader row id `tide`.

1. Install the package with the plugin manager (or `link:` this directory in a profile).
2. **Add `dsh-chat-tide` to `dsh.profile.bundles` in the profile's `package.json`.** Skipping this installs the package without loading it.
3. Edit `cordis.patch.yml`: replace `scope.peers`, `extract.provider` and `extract.model` with your own.
4. On first run keep the waking route off, confirm ingestion and injection work, then enable routing.

Data lives in `~/.dsh/tide/memory.db` (`dbFile` overrides it). The read-only page is at `http://127.0.0.1:<port>/tide`.

## Configuration

Two layers: the config file for structural choices, the plugin page for runtime overrides (stored in the database, applied within five seconds, config file untouched).

| Key | Default | Meaning |
|---|---|---|
| `routing.attentionThreshold` | 0.5 | Attention-vector hit threshold |
| `routing.attentionMargin` | 0.04 | Required lead over the runner-up |
| `routing.ambientReplyProbability` | 0.1 | Exploration chance outside attention |
| `routing.l2Threshold` | 0.45 | Fact-layer threshold for relevance |
| `routing.maxWakesPerDay` | 20 | Daily cap per conversation |
| `routing.minWakeIntervalMinutes` | 10 | Minimum gap between wake-ups |
| `context.unifySessions` | false | Whether private and group chats share one fact pool |
| `context.groupExcludePrivate` | true | Whether groups are shielded from private sources |

A group sees private facts only when `unifySessions=true` **and** `groupExcludePrivate=false`.

## Checks

```bash
node --version    # Node 22.5+ (uses node:sqlite)
npm test          # probes plus consistency checks, same as CI
node scripts/doctor.mjs   # read-only health check for an existing database
```

39 probes, each building its own temporary database. Probes 01–03 print capabilities; the rest assert.

## Presets

Rules, attention seeds and recommended configs live in [presets/](./presets/README.md). Generic rules are publishable; deployment-specific rules stay in `presets/private.json` (gitignored, stripped from the package).

## Known limits

- The default exploration chance is a starting guess; tune it for your group
- Attention grows from real conversations, so an empty memory stays silent
- The image cache only fills after the model has looked at an image; an image-only message never wakes anyone, and whether the model looks at an image that also carries text is its own call
- The embedding model downloads on first use and cold start is slow

## License

MIT — see [LICENSE](./LICENSE).
