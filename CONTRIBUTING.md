# Contributing

Thanks for looking. Tide is small on purpose — please keep it that way.

## Shape of the codebase

- `lib/` — the engine. Host half (`index.js`) plus the browser half (`client.js`) that renders the
  plugin's configuration page. `db.js` owns the schema; every migration is append-only.
  `const.js` is the single source for the row id, route, data directory, log names and style prefix.
- `presets/` — content, not code: rules, attention seeds, recommended configs. Generic presets ship;
  `presets/private.json` never does.
- `probes/` — numbered regression suites. Each one builds its own throwaway database and asserts
  behaviour. They are the test suite; there is no separate framework.
- `scripts/` — operator tooling: packaging, seeding, health, metrics and consistency checks.

## Before opening a pull request

```bash
npm install
npm test          # 等价于 node scripts/run-checks.mjs --skip-model
# 想连模型探针一起跑：node scripts/run-checks.mjs
```

All suites and the three consistency checks must pass. `check-docs` fails when the README drifts
from the code; `check-dead-config` fails when a declared configuration key is never read.

If you change the schema, add a migration to `lib/db.js` and a probe that covers it — do not edit
an existing migration, since someone's database may already be past it.

## Behaviour rules for contributions

- Memory is data, never instructions. Anything injected into a prompt must be fenced as data.
- Prefer deciding with local signals (FTS, vectors) before spending a model call.
- Every deletion is soft, auditable and explainable. Never hard-delete user content.
- Anything that leaves the machine must be visible in the configuration. No silent network calls.
- No personal identifiers in code, tests, docs, or presets. Use placeholders and environment
  variables (`CM_OWNER`, `CM_PEER`).

## Commit style

One change per commit, imperative summary, body explains the why rather than restating the diff.

## Local install

Data lives in `~/.dsh/tide/memory.db`; the read-only page is `/tide` on the host port.

When linking this repository into a profile for development, add `dsh-chat-tide` to the profile's `dsh.profile.bundles`. Without that entry the package is installed but never loaded, and the plugin page shows nothing.

## Tooling

| Command | Purpose |
|---|---|
| `npm test` | every probe plus the three consistency checks |
| `node scripts/doctor.mjs` | read-only health check of an existing database |
| `node scripts/metrics.mjs` | data, routing, injection and recent episodes snapshot |
| `node scripts/curate-report.mjs` | memory quality: duplicates, fragments, expiry, scope violations |
| `node scripts/check-naming.mjs` | route, directory, log and style consistency |
| `node scripts/check-dead-config.mjs` | every declared configuration key is actually read |
| `node scripts/check-docs.mjs` | the README matches the code |
| `node scripts/seed.mjs` | import presets (idempotent) |
