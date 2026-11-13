# Tide — 聊天记忆与选择性接茬

<img src="./assets/icon.png" width="96" alt="Tide">

> English: [README.en.md](./README.en.md)

按 `docs/聊天 Agent 记忆与主动消息接收系统设计v2.0.md` 实现。

## 现在做到哪（2026-11-08）

**当前启用状态**：按 peer 白名单上线（群聊与主人私聊生效，其余会话零介入）；入站镜像、轮末抽取、上下文注入开启，路由按需开启。

**端到端已验**：workspace 作用域绑定真实会话跑通入站镜像 → 轮末抽取 → 事实入库 → FTS/向量写入；插件默认 scope=off，装完静默。


**阶段零 4/5 通过**（sqlite-vec、bigram FTS5、embedding、存储层），
第 5 项（`agent/pre-step` 行序）需要装进 profile 才能验，留到装包时一起做。

**阶段一代码已落地并装包（scope=off 静默态）**：

| 模块 | 内容 | 本地自测 |
|---|---|---|
| `lib/db.js` | schema/迁移/事务（libsqlite，`allowExtension`） | ✅ |
| `lib/fts.js` | bigram 分词 + FTS5 检索 | ✅ 6/6 两字词 |
| `lib/vec.js` | sqlite-vec 加载、vec0 读写、KNN | ✅ 往返/覆盖/删除 |
| `lib/facts.js` | 证据分级、时间仲裁、CAS、插入竞态重试、冲突、确认、删除 | ✅ 18 项 |
| `lib/events.js` | 入站镜像、判重、事件追加（审计事件不进索引） | ✅ |
| `lib/egress.js` | generation 状态机、`llm/stream` 文本挂起 | ✅ 7 项 |
| `lib/embed.js` | transformers 惰性加载、降级 | ✅ 探针 |
| `lib/scope.js` | QQ 会话→peer 映射、作用域过滤、发送者解析 | 待宿主验证 |
| `lib/extract.js` | 轮末抽取、证据分级、JSON 容错 | ✅ 11 项 |
| `lib/context.js` | 事实快照选取/渲染、增量块、注入消息 | ✅ 10 项 |
| `lib/janitor.js` | 待确认超时、冲突报告、向量积压 | ✅ |
| `lib/route.js` | 标签推断、阈值判定、预算/熔断分标注 | ✅ 24 项 |
| `lib/silence.js` | B 禁言、C 临时覆盖（30 分钟硬上限、到期自取消） | ✅ |
| 向量管线 | 事实/事件写入时embedding → vec0；L2 距离→余弦；阈值按实测校准 | ✅ 6 项 |
| `lib/exemplar.js` | 示例库（人工审核才入库）、向量匹配 | ✅ |
| `lib/budget.js` | 固定窗口预算、超限记 budget_skipped、过期窗口清理 | ✅ |
| `lib/merge.js` | 多跳候选合并（层级+时间仲裁，不把推测当事实） | ✅ 17 项 |
| `lib/conflict.js` | 冲突落定与未解决列表 | ✅ |
| `lib/circuit.js` | 连续失败熔断、冷却半开、成功关闭（与预算跳过分开） | ✅ 10 项 |
| `lib/embed-worker.mjs` | worker 线程跑 ONNX（绕开宿主 CJS 钩子） | ✅ 宿主内验证 |
| 迁移 | schema v3（exemplar / route_budget / vec_exemplar），实机已迁到 3 | ✅ |
| `lib/index.js` | 插件入口：工具注册（scope=off 直接返回）、入站监听、轮末抽取、闸门 | 宿主加载已验证 |

## 下一步

1. 启用作用域（allowlist 一个 peer）后端到端验入站镜像、轮末抽取、出站闸门。
2. 阶段三：ambient 感知待平台「接收全部群消息」开关；direct 路径已上线。
3. 可选：把记忆能力收成独立预设（Host 瘦行 + 预设胖行）。

## 只读入口

- 状态页：http://127.0.0.1:55535/chat-memory （仅本机 Host，只读）
- 体检：`node scripts/doctor.mjs`（完整性/索引对齐/孤儿向量/审计，只读）
- 指标快照：`node scripts/metrics.mjs`（数据/路由/注入/最近经历）
- 召回预演：`node scripts/recall-check.mjs "问句" <peer>`
- 话题相关性：`node scripts/eval-topic.mjs`（真实记忆做语料，评估「群友聊到已知主题」能否召回）
- 阈值标定：`node scripts/eval-route.mjs`（40 正反例，输出阈值/kNN/规则/融合四组 P/R/F1）

## 消息处理流程（配置项里的「第 N 步」）

一条群消息从进来到变成记忆，经过七步；任何一步都可以在插件配置里关掉或调参。

1. **入站镜像**（`features.ingest`）：所有消息先写进原始流水账，被拒绝的也写。这一步决定「以后能不能回溯」。
2. **作用域检查**（`scope`）：只处理白名单/开放范围内的会话，其他一律不介入。
3. **群聊初筛**（`features.routing`）：没 @ 的群消息走这里。分类 → 静默时段 → 预算 → 每日上限/冷却 → 向量 + 事实 + 关键词判定 → 关注点闸门 → 接茬概率。任何一关不过就 `reject`，零模型调用、零回复。
4. **上下文注入**（`features.contextInject`）：通关的轮次才注入。顺序是规则块 → 事实块 → 经历块（增量）；窗口、条数、字符上限都在 `context.*`。
5. **模型回合**：模型看到的就是上面三块加当前消息。
6. **轮末抽取**（`features.writePipeline` + `extract.*`）：抽出事实/经历/关注点，按证据分级写入；三类可分别关。
7. **巡检与保留**（`janitor` / `retention`）：过期待办、关注点漂移、垃圾事件、原始记录保留期。

## 写入规范（给模型看，也是验收口径）

一句话：**记得住、读得懂、找得到、删得掉**。

- 键命名空间：主人 `owner.*`、别人 `other.*`、偏好 `pref.owner.*`/`pref.other.*`、待办 `todo.owner.*`/`todo.other.*`、规矩 `rule.*`、助手自己 `self.*`、关系 `rel.*`；别用昵称当键
- `subtype` 选对：`profile` 资料 / `preference` 偏好 / `todo` 待办 / `rule` 规矩 / `self` 关于助手自己 / `relation` 人际关系
- `rule`：常驻注入、单独成块，不参与唤醒；值要能独立读懂，别带「【来源:…】」这类搬运标签
- `self`：助手自己的属性、计划、愿望。`entityId` 固定写 `assistant`，别记成主人
- `value` 只写事实本身：不混计划、打算、做法（生日就写日期；计划另开 `todo`）
- 值必须有对象：缺主语、缺宾语的碎片（「精修」「晚上修一下」）不记
- 证据等级：本人第一人称原话 `human_explicit`；可核转述 `source_verifiable`；自己归纳 `agent_inferred`
- 经历（`events`）要带发言人，群聊尤其要——不然分不清谁说的
- 删除走软删并写 `tombstone` 审计；删 `human_explicit` 需要 `confirm:true` 并说明 `reason`

## 预置

规则、关注点、推荐配置都在 [presets/](./presets/README.md)：通用规则可公开，私人规则留在本地
（`presets/private.json`，已 gitignore）。导入用 `node scripts/seed.mjs`，幂等，只补缺。

## 发布

见 [RELEASE.md](./RELEASE.md)：测试、脱敏、包元信息、仓库与 npm 的逐项清单。

## 自检

```bash
cd works/chat-memory
CM_PEERS=<群openid>,<私聊openid> node scripts/smoke.mjs
```

只读，打印 schema 版本、白名单绑定、各表计数、最近 QQ 入站、向量积压与 embed 日志时间。

## 结构

```
lib/          插件源码（db/fts/vec/facts/events/egress/embed/scope/index）
probes/       阶段零探针与本地自测（不进产物）
cordis.patch.yml  bundle 补丁（插一行，scope 默认 off）
probe_report.md   探针结论
```

## 关键环境事实

- `node:sqlite` 载入扩展必须 `{ allowExtension: true }`。
- `vec0` 主键必须 `BigInt` 绑定；向量参数必须 `Uint8Array`。
- 模型走 `HF_ENDPOINT=https://hf-mirror.com`，量化 `q8`，512 维；冷启 82s，推理 P50 21ms。
- 余弦整体偏低（相关 0.32–0.43，不相关 0.25–0.37），margin 可小到 0.013 → 阈值以绝对分为主，别照搬 0.75/0.8；BGE 查询指令前缀在短句上更差，别默认加。
- 依赖安装用 `npm install --ignore-scripts`（沙箱里生命周期脚本 EPERM），npm cache 指到工作区内。
- 入站 msgId：平台有（`ROBOT1.0_…`），但官方 QQ 插件不透传，插件层看不到；去重键已做成可插拔，透传后零改动升级。

## 与预设的关系

- 本插件是 **Host 级 bundle 行**（`chat-memory`），安装本身不修改任何 agent preset，默认预设（standard / ptc / minimal / cordis）不受影响。
- `scope.mode` 支持 `off / all / allowlist / workspace / preset`：
  - `allowlist`：只对指定 QQ peer 生效（推荐给 QQ 机器人）；
  - `preset`：只对 `agentPreset` 命中 `scope.presets` 的会话生效（默认预设天然被排除）；
  - `workspace`：按会话工作目录匹配。
- 工具可见性只是 UI 层，**执行前统一过绑定校验**，作用域外一律返回 `out-of-scope`。
- 若要把记忆能力打包成**独立预设**（在预设列表里可选），需要新增 preset 声明并把工具/注入/路由挂进预设；出站闸门仍须留在 Host（`llm/stream` 是根作用域事件）。这一步尚未做，按需再定。

## 约定

- 模型权重放 `D:\Cache\chat-memory-models\`（探针期因沙箱限制暂放 `.cache/`），不进仓库。
- `node_modules/`、`.cache/`、`.npm-cache/` 不进仓库。
- 作用域默认 `off`：装完不介入任何会话，工具也不出现，需显式配置 peer 白名单。

## 许可

MIT，见 [LICENSE](./LICENSE)。
