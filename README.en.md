# Tide — memory for your DSH chats

[简体中文](./README.md)

Tell your assistant you take your coffee without sugar, or mention a trip you took last week. With cross-chat memory enabled, you can ask about it in another chat. Open Tide’s Memory view to see the facts and events it has saved.

- **Remember useful details.** Tide picks out things worth keeping, such as preferences, to-dos, and things that happened. It uses the model selected for the chat to organize them.
- **Correct memories.** Wrong values can be edited; unwanted facts and events can be deleted, and the reason stays on record. When answering, Tide supplies only the current value and the events that may be relevant.
- **Join group chats when it makes sense.** With group screening enabled, Tide checks whether someone addressed the assistant and what the group is talking about. It can skip chatter or ask the model to judge a borderline message. The assistant can also choose to stay quiet.
- **Set chat rules.** You can give the assistant a rule such as “Keep group replies short.” Saved rules that apply to the chat become part of the assistant’s instructions.

Settings live under “Tide” on the plugin page. Changes take effect within five seconds; no restart.

## Install and try it

1. Install `dsh-chat-tide` in the DSH plugin manager. Make sure `dsh.profile.bundles` in the active profile’s `package.json` includes `dsh-chat-tide`; without it the plugin is installed but never loaded.
2. Open the plugin page and choose the chats it manages under “Scope”. With QQBot, `follow` covers QQBot sessions plus local chats in the same workspace; for local use, name a workspace or specific sessions.
3. Check that “Context injection” is on under “Switches”, so the assistant can use what it remembers when answering.
4. Start with a private or local chat: tell the assistant one specific thing, wait for the turn to finish, find it in the Memory view, then ask the assistant about it.

The same switches can be written in the profile’s plugin configuration instead:

```yaml
scope:
  mode: follow
features:
  contextInject: true
  routing: false
```

Turn on `features.routing` when you want Tide to decide which group messages are worth answering.

## Cross-chat memory

Turn on “Unify sessions” (`context.unifySessions`) and the assistant will use memories from other chats when answering. To try it, use the same QQ account to mention something specific in one chat Tide manages, then ask about it in another.

“Keep private facts out of groups” is on by default, so automatically selected memories for a group reply skip private-chat content. That filter applies to selection only: when the assistant searches its memories directly, it still sees the whole database.

## Compatibility and storage

| Item | Requirement |
| --- | --- |
| DSH | `>=0.2.2-rc.1 <0.3.0` |
| Node.js | `>=22.5` |
| QQBot | QQ chats and group screening require the QQ adapter. Tested with `@tencent-connect/dsh-qqbot@0.5.5`. Local chats work on their own. |

Tide stores memories in `~/.dsh/tide/memory.db` by default; fix a wrong entry with the edit and delete controls on the settings page rather than by hand. On first use it downloads a local model of about 25–30 MB to match topics with relevant memories. The model lives in `~/.dsh/tide/models` and survives reinstalls.

See [CONTRIBUTING.md](./CONTRIBUTING.md) for development and troubleshooting.

MIT. See [LICENSE](./LICENSE).
