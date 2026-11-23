# Tide — memory for your DSH chats

[简体中文](./README.md)

Tide (`dsh-chat-tide`) is a chat-memory plugin for DeepSeek Harness (DSH). It lets the assistant recall what you said in one chat while answering in another, and lets a QQ group bot join conversations when it makes sense. Local chats work on their own; QQ group support requires QQBot.

- **Remembers useful details**: preferences, to-dos and things that happened are extracted with the model already selected for that chat — the plugin never picks its own.
- **Memories are correctable**: facts can be edited or deleted, deletions keep an audit row, and answers only carry current values plus possibly relevant events.
- **Joins in when it makes sense.** Tide checks whether a group message is worth a reply. If the assistant takes a look, it can still decide to stay quiet.
- **Rules stay resident**: chat rules and red lines live in the system prompt, so they neither occupy the conversation nor get summarised away.
- **Cross-chat**: different chats can optionally share one memory; automatic selection for a group reply skips private-chat sources by default.

| | |
| --- | --- |
| Package | `dsh-chat-tide` (plugin row id `tide`) |
| Runtime | DSH `>=0.2.2-rc.1 <0.3.0`, Node.js `>=22.5` |
| QQ support | Optional, needs `@tencent-connect/dsh-qqbot` (tested with 0.5.5) |
| Storage | `~/.dsh/tide/memory.db`; embedding model in `~/.dsh/tide/models` (about 25–30 MB, downloaded on first use) |
| License | MIT |

Installation, configuration, a first run and troubleshooting: [install and usage guide](./docs/INSTALL.en.md).

For development and troubleshooting internals see [CONTRIBUTING.md](./CONTRIBUTING.md).
