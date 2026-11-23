# Install and usage guide

Tide is a chat-memory plugin for DSH. This guide covers installing it, configuring it, checking that it works, and where to look when it does not.

- Package `dsh-chat-tide`, plugin row id `tide`
- Data lives in `~/.dsh/tide/memory.db`; the embedding model in `~/.dsh/tide/models`
- Settings are on the plugin page under “Tide” and take effect within five seconds — no restart

## Install

1. Install `dsh-chat-tide` in the DSH plugin manager.
2. Make sure `dsh.profile.bundles` in the active profile’s `package.json` includes `dsh-chat-tide`; without it the plugin is installed but never loaded.
3. Reload the plugin or restart the host.

On first use it downloads a local embedding model of about 25–30 MB, used to match topics with memories. A failed download reports a clear error instead of silently retrying inside the host process.

## Choose the scope

| Value | Meaning |
| --- | --- |
| `follow` | Follow QQBot: QQ sessions plus local sessions in the same workspace |
| `workspace` | Sessions under a given workspace path |
| `sessions` | Only the session ids you name |
| `off` | Disabled |

Private chats are never screened for waking; if they are in scope, they still get memory injected.

## The five everyday switches

| Item | Key | Default |
| --- | --- | --- |
| Group screening | `features.routing` | on |
| Context injection | `features.contextInject` | on |
| Unify sessions | `context.unifySessions` | off |
| Keep private facts out of groups | `context.groupExcludePrivate` | on |
| Store facts / events / attention | `extract.storeFacts`, `storeEvents`, `storeAttention` | on |

These can also be written in the profile’s plugin configuration:

```yaml
scope:
  mode: follow
features:
  contextInject: true
  routing: false
```

## Try it

1. Start with a private or local chat.
2. Say something specific, such as “I take my coffee without sugar”.
3. Wait for the turn to finish.
4. Find that fact in the Memory view.
5. Ask the assistant whether you take sugar in your coffee.

For cross-chat memory, turn on “Unify sessions”, mention something in one chat and ask about it in another. The same QQ account is the easiest way to check.

## Bot settings

- **Identity**: `owner.ids` holds the owner openids, comma separated. When empty, the QQ adapter’s private-chat list is used (only when its mode is open); if neither exists, nobody has owner rights. It is on the settings page under “Identity”.
- **Persona**: `persona.mode` defaults to `off`, leaving identity and tone entirely to the workspace’s AGENTS/SOUL documents. Switch it to `custom` to use `persona.text`. Rules are unaffected and always injected separately.

## Where to look when something is off

- **Nothing is remembered**: check the scope, and that context injection and the store switches are on; then look at the injection log.
- **Group messages get no reply**: waking only happens with `features.routing` on, and the assistant may choose to stay silent for the whole turn — that is expected.
- **An old value still shows up**: after editing a fact the previous value must not appear; if it does, check that the plugin is 0.5.3 or newer.
- **Database state**: run `node scripts/doctor.mjs` inside the plugin directory for integrity, vector dimensions, foreign keys and index alignment.

## Data and backup

Memories are one SQLite file; back it up by copying `~/.dsh/tide/memory.db`. Deleting a fact or an event leaves an audit row, so the reason is still recoverable from the settings page or a read-only query.

Internal details for development and troubleshooting are in [CONTRIBUTING.md](../CONTRIBUTING.md).
