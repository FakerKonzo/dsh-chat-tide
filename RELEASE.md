# Release checklist

Run through this before tagging a public release. Nothing here touches a live deployment.

## 0. Versioning and cadence

Version numbers follow what changed, not arithmetic and not the calendar.

| Change | Bump |
|---|---|
| Bug fix, docs, internal cleanup, test-only | patch — `0.2.8` → `0.2.9` |
| New capability, new configuration, behaviour change | minor — `0.2.9` → `0.3.0` |
| Incompatible change: data migration that cannot be undone, removed configuration, removed export | major — `0.3.x` → `1.0.0` |

- **`0.2.9` is followed by `0.2.10`, never `0.3.0`.** Decimal carries do not apply to semver;
  the third number is an independent counter.
- While the package is `0.x`, semver allows a minor bump to break things. That is not a reason to
  inflate version numbers: still use patch for fixes.

**Batch releases.** Do not publish once per change. Keep work in an `Unreleased` section of
`CHANGELOG.md` and publish when one of these is true:

- a defect that affects installed users is fixed;
- a capability is finished end to end (code, tests, docs, presets);
- the unreleased set is large enough that holding it back is riskier than shipping it.

Several fixes accumulate into one patch release. A session that touches ten things is not ten
releases: users pay for every update with a re-download and an upgrade risk.

## 1. Code and checks

- [ ] `for f in probes/*.mjs; do node "$f"; done` — all suites pass (probe 14 prints `SKIP` when
      the embedding model is not cached; set `MODEL_CACHE_DIR` to reuse an existing download)
- [ ] `node scripts/check-naming.mjs` — route, directory, log names and style prefix agree
- [ ] `node scripts/check-dead-config.mjs` — every declared configuration key is actually read
- [ ] `node scripts/check-docs.mjs` — the README matches the code
- [ ] `node scripts/doctor.mjs` against a copy of a real database — no `fail`
- [ ] CI is green on both Node majors for the release commit
- [ ] `node --check` every file under `lib/` (the exporter does this too)

## 2. Sanitisation

- [ ] No real openids, account ids, host paths, or `appSecret` anywhere in the publishable tree
- [ ] `presets/private.json` is absent from the export (gitignored, removed by the exporter)
- [ ] `cordis.patch.yml` uses placeholders only
- [ ] `node scripts/export-repo.mjs` prints `敏感标识检查： 通过`

## 3. Package metadata

- [ ] `name` is `dsh-chat-tide`, `version` follows semver (bump when behaviour changes)
- [ ] `license` is MIT and `LICENSE` is present
- [ ] `icon` points to an existing file; `files` lists `lib`, `assets`, `presets`, docs
- [ ] `dsh.engines.dsh` matches the Harness versions actually tested

## 4. Documentation claims

- [ ] Every feature described in the README exists and is reachable from configuration
- [ ] Known limits are stated, not hidden (README "Known limits" section)
- [ ] Anything that leaves the machine is documented (model calls, optional model download)
- [ ] No links to files that are not shipped

## 5. Repository

- [ ] `node scripts/export-repo.mjs <target>` produces the tree
- [ ] `git init`, first commit, remote added, pushed
- [ ] Tag the release (`vX.Y.Z`)
- [ ] `CONTRIBUTING.md` present; issue templates optional

## 6. Optional npm publish

- [ ] `npm pack --dry-run` shows only intended files (no `presets/private.json`, no `.db`)
- [ ] Publish, then install from the registry into a clean profile
- [ ] **Add `dsh-chat-tide` to that profile's `dsh.profile.bundles`**, otherwise the package
      installs but never loads

## 7. After release

- [ ] Install from the published artifact, run one real conversation, confirm the config page and
      `/tide` respond
- [ ] Record the schema version shipped; note the migration path for existing databases
