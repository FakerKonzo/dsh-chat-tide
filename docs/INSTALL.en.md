# Install and usage guide

Tide is a chat-memory plugin for DSH. This guide covers installing it, configuring it, checking that it works, and where to look when it does not.

- Package `dsh-chat-tide`, plugin row id `tide`
- Data in `~/.dsh/tide/memory.db`; embedding model in `~/.dsh/tide/models`
- Settings are on the plugin page under “Tide” and take effect within five seconds

## Install

1. Open the DSH plugin manager, choose “Add plugin,” and install `dsh-chat-tide`.
2. Select “Enable now” after installation. DSH adds Tide to the active profile automatically. Restart DSH if prompted.
3. The bundled configuration uses the `follow` scope: **QQ sessions only** (groups and private chats), with memory injection and group screening on. To include local sessions, switch Scope to `workspace` (a workspace path — every session there, QQ or local) or `sessions` (name specific sessions).

On first use it downloads a local embedding model of about 25–30 MB. A failed download reports a clear error instead of silently retrying inside the host process.

## What the settings page looks like

Four blocks, top to bottom:

**Everyday** — which chats Tide works in, automatic remembering, looking up memory before answering, and joining group chats. A path or session picker appears only for the matching scope. “Use memories from other chats too” appears once lookup is on, followed by “skip private-chat memories in groups”.

**Your bot** — who can set rules (the effective openids and where they came from are shown), and how it sounds (follow the workspace docs, or use your own text).

**More** — collapsed: quiet hours, daily attempts, and the gap between attempts.

**Advanced** — hidden behind “Show advanced settings” at the bottom: thresholds, character budgets and diagnostics.

Turning “Remember automatically” off stops both normal extraction and the repair pass; raw chat logs are still kept, and the three sub-switches keep their values for when you turn it back on.

## Try it

1. Start with a private or local chat.
2. Say something specific, such as “I take my coffee without sugar”.
3. Wait for the turn to finish.
4. Find that fact in the Memory view.
5. Ask the assistant whether you take sugar in your coffee.

For cross-chat memory, turn on “Use memories from other chats too”, mention something in one chat and ask about it in another.

## Export and backup

At the bottom of the settings page:

**Export config** — a JSON file with settings, persona and rules. Paste it back into the import box elsewhere to preview the differences (which settings change, which rules are new) before applying. Import only touches settings and rules, never the memory database.

**Back up database** — a full snapshot taken with SQLite’s consistent backup, so writes still sitting in the WAL are included. It is reopened read-only to verify integrity and row counts before the download starts. To restore, quit DSH and replace `~/.dsh/tide/memory.db` with the file.

Copying `memory.db` while DSH runs is not enough: recent writes may still be in the `-wal` file. Use the backup button, or quit DSH first.

## Where to look when something is off

- **Nothing is remembered**: check the scope, and that “Remember automatically” and the store switches are on.
- **Group messages get no reply**: waking only happens with “Join group chats” on, and the assistant may choose to stay silent for the whole turn.
- **An old value still shows up**: after editing a fact the previous value must not appear; check that the plugin is 0.5.3 or newer.
- **Database state**: run `node scripts/doctor.mjs` inside the plugin directory.
- **A session will not open, with `system/message does not match an open turn and step`**: the log was damaged by 0.6.3 or earlier. Quit DSH, then run `node scripts/repair-session-log.mjs --scan "%USERPROFILE%\.dsh\sessions" --write` (without `--write` it only reports).

## Data

Memories live in one SQLite file. Deleting a fact or an event leaves an audit row with the reason.

Internal details are in [CONTRIBUTING.md](../CONTRIBUTING.md).

### Silent replies and session repair

With the silence gate enabled, Tide waits for each model step to finish before sending its text. If the step calls `run_code`, Tide forwards the tool call and drops that step's interim text. A later step can send the final reply.

Session repair writes a temporary file and replays it through DSH's V4 session reader before replacing the original. Standalone use requires the matching `@deepseek-ai/dsh-session-format-catalog`, included in development installs. A missing reader or failed replay leaves the original in place.
