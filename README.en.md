# Tide

<img src="./assets/icon.png" width="96" alt="Tide">

Chat memory and selective waking for [DeepSeek Harness](https://deepseek.com) (DSH).

Tide gives an agent a small, curated memory of the people and topics it talks to, injects that
memory as data (never instructions), and — only when it is genuinely relevant and allowed — lets
the agent speak up on its own.

> Memory comes in waves: most messages pass by; occasionally one is worth answering.

## What it does

- **Ingest** every inbound message into a raw ledger (including messages later rejected).
- **Extract** facts, events and *attention* topics at the end of a turn, using the host LLM.
- **Store** them in a local SQLite database with evidence tiers, versioning and CAS updates.
- **Retrieve** with bigram FTS5 plus local embeddings (`bge-small-zh-v1.5`, no API calls).
- **Inject** compact blocks (rules → facts → recent events) as *data*, incrementally.
- **Gate** ambient replies: scope → classification → budget → vector/fact check → attention →
  probability → quiet hours / daily cap / cooldown. Anything rejected ends the turn with zero
  model calls.
- **Curate** with a rule-based health check: namespaces, fragments, attribution, tier misuse,
  stale todos, attention drift, missing audit, near-duplicates.

## Pipeline (seven steps)

1. **Ingest** — mirror all inbound messages to the raw ledger (`features.ingest`).
2. **Scope** — only sessions inside the configured scope are handled (`scope`).
3. **Screen** (group ambient only) — classify, silence windows, budget, daily cap, cooldown,
   vector + fact similarity, keyword rescue, attention gate, reply probability (`features.routing`).
4. **Inject** — rules, facts and recent events, with per-block budgets (`features.contextInject`).
5. **Model turn**.
6. **Extract** — facts / events / attention, with evidence tiers (`features.writePipeline`).
7. **Janitor** — expiry, attention drift, junk events, payload retention.

## Configuration

Configuration is exposed in DSH's standard plugin configuration page. Everything can also be set
in the bundle's `cordis.patch.yml`.

Key groups:

- `scope` — `off | all | qq | allowlist | workspace | preset | sessions`, plus `sessionIds` and
  `includeSubagents`.
- `routing` — similarity thresholds, attention gate, reply probability, quiet window, daily cap,
  cooldown.
- `context` — rule/fact/event budgets, recent window, session unification, group privacy.
- `extract` — which of facts / events / attention are stored.
- `attention` — enabled, capacity, TTL, block patterns.

## Privacy and safety

- The HTTP surface (`/tide` and `/tide/api/*`) accepts **loopback hosts only**.
- Memory is stored locally in `~/.dsh/tide/memory.db`; no network calls except the model
  requests you already configured and optional model downloads.
- Injected memory is always fenced as *data, not instructions*.
- Deletions are soft, audited via `tombstone`, and deleting user quotes requires explicit
  confirmation.
- Group chat can be configured to exclude anything that originated in private chats.

## Presets

Reusable rules, attention seeds and recommended configs live in [presets/](./presets/README.md).
Generic rules are publishable; deployment-specific rules stay local in `presets/private.json`
(gitignored). Import with `node scripts/seed.mjs` — idempotent, fills gaps only.

## Release

See [RELEASE.md](./RELEASE.md) for the step-by-step checklist.

## Development

```bash
node scripts/doctor.mjs   # read-only health check for an existing database
npm install
node probes/04-storage.mjs     # and the other probes/ suites
node scripts/curate-report.mjs # read-only memory health check
```

The package is a DSH bundle: `main` is the host half, `./client` is the browser half that renders
the plugin's configuration page.

## Status

Early, actively developed. Interfaces and the database schema may change; migrations are included.

## License

MIT — see [LICENSE](./LICENSE).
