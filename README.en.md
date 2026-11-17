# Tide — chat memory with selective waking

> A chat-memory plugin for DSH: conversations settle into facts and episodes, and the agent speaks only when it should.
> 中文：[README.md](./README.md)

## The problem

Chat agents usually fail in one of two ways: they forget, or they answer everything.

Tide lets the agent remember what people said and speak only when it should — group chatter is not answered line by line, but when a topic it cares about comes up, it joins in. What it remembers can be browsed, edited, and deleted with a record.

## Compatibility

| Item | Requirement |
|---|---|
| DSH | `>=0.2.2-rc.1 <0.3.0`, tested on 0.2.2-rc.1 and 0.2.2-rc.3 |
| Node | `>=22.5` (uses the built-in `node:sqlite`) |
| QQ adapter | Optional, tested with `@tencent-connect/dsh-qqbot@0.5.5`; without it memory still works for local sessions, group waking just never fires |

Everything else is installed with the package. The first run downloads a local embedding model of about 25–30MB.

## How it works

1. **Remember first**: incoming chat is recorded; nothing answers anyone at this stage.
2. **Then decide**: for a group message it checks whether it is being addressed, then whether the topic is something it cares about. If so it speaks; otherwise it rolls a small probability and the model decides whether to join.
3. **Speak with memory**: only when it does speak are the relevant rules, facts and recent episodes brought into the turn. The rest of the time they stay out of the context.
4. **Settle afterwards**: at the end of a turn, facts, episodes and interests worth keeping are extracted.
5. **Clean up over time**: duplicates merge, stale entries retire, one-off claims get corrected.

Memory is kept per person: in a group, what each member said stays under their name. A group's automatic injection filters out private-chat sources by default (the switch can be turned off); the memory lookup tools apply no such filter and read the whole database.

### The four things that must not be lost

Details change; these do not.

1. **Answer on demand** — a group message hits a gate first; anything that should not be answered is dropped before a model call costs anything.
2. **Decline explicitly** — the model has `stay_silent`; calling it produces zero output for the turn. Real silence is not the string "（not replying）".
3. **Gate what gets remembered** — incoming chat is recorded first, then a prefilter and a budget decide what is worth extracting. Extraction follows the session's own model; the plugin never picks one.
4. **Inject rules and facts properly** — rules, facts and episodes each have their own budget, are selected per conversation type, rules are re-sent periodically, and every fact carries whose it is.

`probes/52-core-capabilities.mjs` is the guard for these four.

## Install

Package `dsh-chat-tide`, Loader row id `tide`.

1. Install `dsh-chat-tide` with the DSH plugin manager (or `link:` a local checkout while developing).
2. Add `dsh-chat-tide` to `dsh.profile.bundles` in the profile's `package.json`. Skipping this installs the package without loading it.
3. Open the plugin page and confirm which conversations it should manage under "Scope".
4. On first run keep the waking route off, confirm ingestion and injection work, then enable routing.

Data lives in `~/.dsh/tide/memory.db`.

## Configuration

Most switches and numbers live on the plugin page; changes apply within five seconds without a restart. The ones people touch most:

| Key | Default | Meaning |
|---|---|---|
| `routing.attentionThreshold` | 0.48 | Attention hit threshold; higher is pickier |
| `routing.attentionMargin` | 0.03 | How far ahead of the runner-up a hit must be |
| `routing.ambientReplyProbability` | 0.1 | Chance of a tentative reply outside attention |
| `routing.l2Threshold` | 0.45 | How close a single fact must be to count as relevant |
| `routing.maxWakesPerDay` | 20 | Daily cap on spontaneous replies per conversation |
| `routing.minWakeIntervalMinutes` | 10 | Minimum gap between two wake-ups |
| `scope.mode` | follow | Which conversations it manages: follow dsh-qqbot / a workspace / specific sessions / off |
| `context.unifySessions` | false | Whether private and group chats share one memory |
| `context.groupExcludePrivate` | true | Whether groups are shielded from private sources |

## Known limits

- The default exploration chance is a starting guess; tune it for your group
- Interests grow from real conversations, so an empty memory stays silent
- An image-only message never wakes it; when an image carries text, whether to look is the model's call
- The embedding model downloads on first use, so cold start is slow

## License

MIT — see [LICENSE](./LICENSE).
