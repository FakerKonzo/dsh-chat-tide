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
for f in probes/*.mjs; do node "$f" || echo "FAILED: $f"; done
node scripts/check-naming.mjs
node scripts/check-dead-config.mjs
node scripts/check-docs.mjs
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
