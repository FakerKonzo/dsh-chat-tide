# Release checklist

Run through this before tagging the first public release. Nothing here touches a live deployment.

## 1. Code and tests

- [ ] `for f in probes/*.mjs; do node "$f"; done` — all suites pass
- [ ] `node scripts/doctor.mjs` against a copy of a real database — no `fail`
- [ ] `node --check` every file under `lib/` (the exporter does this too)
- [ ] No new one-off patch scripts inside `lib/`; patches live in `scripts/patches/` only

## 2. Sanitisation

- [ ] No real openids, account ids, host paths, or `appSecret` anywhere in the publishable tree
- [ ] `presets/private.json` is absent from the export (it is gitignored and removed by the exporter)
- [ ] `cordis.patch.yml` uses placeholders only
- [ ] `scripts/export-repo.mjs` prints `敏感标识检查： 通过`

## 3. Package metadata

- [ ] `name` is `dsh-chat-tide`, `version` follows semver, `private` is false
- [ ] `license` is MIT and `LICENSE` is present
- [ ] `icon` points to an existing file and `files` lists `lib`, `assets`, `presets`, docs
- [ ] `README.md` and `README.en.md` both mention the current schema version

## 4. Documentation claims

- [ ] Every feature described in the README exists and is reachable from configuration
- [ ] Known gaps are stated, not hidden (see `docs/实现验收报告.md`)
- [ ] Anything that leaves the machine is documented (model calls, optional model download)

## 5. Repository

- [ ] `node scripts/export-repo.mjs <target>` produces the tree
- [ ] `git init`, first commit, remote added, pushed
- [ ] Tags: `v0.1.0`
- [ ] Issue templates optional; `CONTRIBUTING.md` present

## 6. Optional npm publish

- [ ] `npm pack --dry-run` shows only intended files (no `presets/private.json`, no `.db`)
- [ ] `dsh.engines.dsh` matches the tested Harness version range
- [ ] Publish, then install from the registry into a clean profile and open the config page once

## 7. After release

- [ ] Install from the published artifact, run one real conversation, confirm the config page and
      `/tide` respond
- [ ] Record the schema version shipped; note the migration path for existing databases
