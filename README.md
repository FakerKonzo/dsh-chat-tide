# Tide — 聊天记忆与选择性接茬

> 给 DSH 的聊天记忆插件：把对话沉淀成事实与经历，在合适的时候才开口。
> English: [README.en.md](./README.en.md)

## 它解决什么

聊天机器人常见两种坏状态：记不住，或者什么都接。

Tide 把记忆做成有出处的数据，把「要不要说话」做成可调的判定：事实有证据等级和有效期，经历按人按场景分开；群聊先过筛选，关注点命中才直接开口，其余按概率探索。

## 兼容与依赖

| 项 | 要求 | 说明 |
|---|---|---|
| DSH | `>=0.2.2-rc.1 <0.4.0` | 只在 0.2.2-rc.1 上实机跑过；宿主升级后请先跑一次自检 |
| Node | `>=22.5` | 用内置 `node:sqlite`，低于此版本没有该模块 |
| `sqlite-vec` | 随包安装 | 向量检索；WASM/预编译由它自己选 |
| `@huggingface/transformers` | 随包安装 | 本地向量模型，首次使用下载约 25–30MB |
| Cordis / `dsh-llm` / `dsh-tools` / `schemastery` | 由宿主提供 | 已声明为可选 peer，不需要自己装 |
| QQ 适配器 | 可选，`@tencent-connect/dsh-qqbot@0.5.5` | 群聊/私聊接茬依赖它；没有 QQ 也能用 `scope.mode: all` 记本地会话 |

没有 QQ 适配器时，插件仍然可以记录与注入本地会话的记忆，只是「群聊接茬」这套判定不会被触发。

## 七个步骤

```
① 入站镜像 → ② 作用域判定 → ③ 接茬判定 → ④ 上下文注入
                                      → ⑤ 模型回合 → ⑥ 记忆抽取 → ⑦ 巡检
```

| 步骤 | 做什么 | 代码 |
|---|---|---|
| ① 入站镜像 | 消息原文落库，作为抽取的证据 | `lib/index.js`、`lib/events.js` |
| ② 作用域 | 白名单 / 预设 / 工作区 / 全部 | `lib/scope.js` |
| ③ 接茬判定 | 关注点向量命中直接唤醒；否则按概率探索 | `lib/route-decision.js`、`lib/route.js` |
| ④ 上下文注入 | 规则块 + 事实块 + 经历块，按增量给 | `lib/inject.js`、`lib/context.js` |
| ⑤ 模型回合 | 宿主自己的回合，插件不接管 | — |
| ⑥ 记忆抽取 | 轮末抽事实 / 经历 / 关注点，失败重试 | `lib/extract.js` |
| ⑦ 巡检 | 去重、过期、孤儿向量、关注点退休 | `lib/janitor.js` |

## 记忆的规矩

- **事实键有命名空间**：`owner.*`、`other.*`、`pref.owner.*`、`todo.*`、`rule.*`、`self.*`、`rel.*`
- **证据分等级**：`human_explicit` / `source_verifiable` / `agent_inferred`
- **场景隔离**：事实记 `scope`（group / private / local），群聊默认拿不到私聊来源
- **群聊分人**：按发言人取事实，渲染带昵称，不同人的同名键不合并
- **删除可回退**：软删 + `tombstone` 记原因
- **注入只陈述**：事实、经历、规则都是数据，不夹带指令

## 安装

包名 `dsh-chat-tide`，插件行 id 是 `tide`。

1. 用插件管理器安装本包（或在 profile 里 `link:` 本目录）。
2. **把 `dsh-chat-tide` 加进 profile 的 `package.json` → `dsh.profile.bundles`**。漏了会「装了但不加载」。
3. 改 `cordis.patch.yml`：把 `scope.peers`、`extract.provider`、`extract.model` 换成自己的。
4. 首次只开入站镜像与注入，确认没问题再开路由。

数据默认在 `~/.dsh/tide/memory.db`（`dbFile` 可改）。只读页面在 `http://127.0.0.1:<端口>/tide`。

## 配置

分两层：配置文件（`cordis.patch.yml`）给结构性选项，插件详情页给运行时覆盖（写库，5 秒生效，不动配置文件）。

| 键 | 默认 | 含义 |
|---|---|---|
| `routing.attentionThreshold` | 0.5 | 关注点向量命中阈值 |
| `routing.attentionMargin` | 0.04 | 关注点命中还要跟第二名拉开多少 |
| `routing.ambientReplyProbability` | 0.1 | 不在关注点内时探索开口的概率 |
| `routing.l2Threshold` | 0.45 | 事实层单独判相关的门槛 |
| `routing.maxWakesPerDay` | 20 | 每会话每日上限 |
| `routing.minWakeIntervalMinutes` | 10 | 两次开口的最小间隔 |
| `context.unifySessions` | false | 私聊与群聊是否共享同一份事实池 |
| `context.groupExcludePrivate` | true | 群里是否屏蔽私聊来源 |

群聊要看到私聊来源，需要 `unifySessions=true` **且** `groupExcludePrivate=false`；只开一个不生效。

## 自检

```bash
node --version   # 需要 Node 22.5+（用 node:sqlite）
npm test         # 全部探针与一致性检查（与 CI 同款）
node scripts/doctor.mjs   # 只读体检：完整性、索引对齐、孤儿向量、审计
```

共 39 个探针，每个自带临时数据库，不碰真实数据。01–03 是能力探针（打印结论），其余断言通过/失败。

## 预置

规则、关注点、推荐配置在 [presets/](./presets/README.md)。通用规则可公开，私人规则留在 `presets/private.json`（已 gitignore，打包时剔除）。

## 已知边界

- 探索概率的默认值来自经验，需要按自己的群调
- 关注点需要真实对话积累，空库时不会主动开口
- 图片语义缓存只有模型看过图之后才会写入；纯图片消息不会唤醒，带文字或被 @ 时是否看图由模型判断
- 向量模型首次运行需要下载，冷启动慢

## 许可

MIT，见 [LICENSE](./LICENSE)。
