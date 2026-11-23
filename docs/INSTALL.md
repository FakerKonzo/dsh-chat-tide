# 安装与使用指南

Tide 是 DSH 的聊天记忆插件。这份文档讲怎么装、怎么配、怎么验证它在工作，以及出问题时先看哪里。

- 包名 `dsh-chat-tide`，插件行 id `tide`
- 数据在 `~/.dsh/tide/memory.db`，向量模型在 `~/.dsh/tide/models`
- 设置项在插件详情页的「Tide」里，保存后五秒内生效，不用重启

## 安装

1. 在 DSH 的插件管理器里安装 `dsh-chat-tide`。
2. 确认当前配置（profile）的 `package.json` 里，`dsh.profile.bundles` 包含 `dsh-chat-tide`。少了这一步会「装了但不加载」。
3. 重新加载插件或重启宿主。

首次使用会下载一个约 25–30 MB 的本地向量模型，用来判断话题和记忆的相关性。下载失败会明确报错，不会在宿主进程里偷偷重试。

## 选作用域

「作用域」决定它管哪些聊天：

| 取值 | 含义 |
| --- | --- |
| `follow` | 跟着 QQBot：QQ 会话 + 同一工作区的本地会话 |
| `workspace` | 指定工作区路径下的会话 |
| `sessions` | 只认手动点名的会话 id |
| `off` | 关闭 |

私聊不参与接茬判定，只要在作用域内就照常注入记忆。

## 五个常用开关

设置页最前面那组就是日常要动的：

| 项 | 键 | 默认 |
| --- | --- | --- |
| 群聊初筛（按需接话） | `features.routing` | 开 |
| 上下文注入（回答时用记忆） | `features.contextInject` | 开 |
| 统一会话（跨聊天共用记忆） | `context.unifySessions` | 关 |
| 群聊屏蔽私聊来源 | `context.groupExcludePrivate` | 开 |
| 写入事实 / 经历 / 关注点 | `extract.storeFacts`、`storeEvents`、`storeAttention` | 开 |

这七项也能写进 profile 的插件配置，效果一样：

```yaml
scope:
  mode: follow
features:
  contextInject: true
  routing: false
```

## 试用

1. 先挑一个私聊或本地聊天。
2. 说一件具体的事，例如「我喝咖啡不加糖」。
3. 等这轮回复结束。
4. 在「记忆浏览」里找到刚才那条事实。
5. 再问机器人「我喝咖啡加糖吗」，看它答得对不对。

跨会话记忆：打开「统一会话」，在一处说件事，再到另一处问起它。用同一个 QQ 账号最容易验证。

## 机器人设置

- **身份**：`owner.ids` 填主人 openid，逗号分隔。留空时会去读 QQBot 的私聊名单（仅在其模式为开放时），读不到就没人有权限。设置页的「身份」组里能填。
- **人设**：`persona.mode` 默认 `off`，即完全交给工作区的 AGENTS/SOUL 文档；切到 `custom` 才使用 `persona.text` 那段文本。规矩不受这里影响，始终单独注入。

## 出问题先看哪

- **没记住任何东西**：确认作用域选对、`features.contextInject` 和写入开关都开着；再看注入日志有没有记录。
- **群里有消息但不回**：`features.routing` 打开时才有接茬判定；机器人可以选择整轮不输出，这是正常行为。
- **旧值还在**：事实改过之后旧值不该再出现；如果还看得到，先确认插件是 0.5.3 以上。
- **数据库状态**：插件目录里跑 `node scripts/doctor.mjs`，它会报数据库完整性、向量维度、外键和索引对齐。

## 数据与备份

记忆是单个 SQLite 文件，备份直接复制 `~/.dsh/tide/memory.db`。删除一条事实或经历会留审计行，仍可用设置页或只读查询查回原因。

开发和排查的内部细节见 [CONTRIBUTING.md](../CONTRIBUTING.md)。
