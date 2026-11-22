# presets —— 预置规范

引擎管机制，预置管内容。这里放的是**可以公开**的默认内容；你自己那份私人规则不入库。

## 目录

```
presets/
  rules/generic.json        通用行为规矩（写作文风、自我保护、删除纪律），18 条
  rules.schema.json         规则文件格式说明
  attention/example.json    关注点种子（示例，按需改）
  config/profiles.json      三档推荐配置：只观察 / 私聊记忆 / 群聊初筛
  private.example.json      私人规则的模板
  private.json              你自己的私人规则（已在 .gitignore，永不入库）
```

## 导入

```bash
node scripts/seed.mjs                 # 通用规则 + 私人规则 + 关注点
node scripts/seed.mjs --rules         # 只灌通用规则
node scripts/seed.mjs --attention     # 只灌关注点
node scripts/seed.mjs --force         # 覆盖已存在的同名键（默认跳过）
```

幂等：同一个键已存在就跳过，不会重复写入、也不会覆盖你后来改过的内容。

## 为什么要分两份

私人规则里通常有账号标识、评分体系、群聊比例、个人路径，这些不该出现在公开仓库。所以：

- `rules/generic.json` 进仓库，任何人都能用；
- `private.json` 只在本地，用来重建你自己的部署；
- 想把现有部署导出成私人预置：这份导出工具留在你自己的私有工作区里，不进本仓库（它会读到真实数据）。

## 写规矩的几条经验

一条规矩一行，能独立读懂，不要写「同上」。别把计划、打算混进规矩里。规矩会在每轮对话里常驻注入，占的是上下文预算——写得越短，能装下的越多。

**规矩里不要写工具的调用写法**（例如「在代码里是 `await tools.xxx()`」）。调用方式随部署而变：同一份配置在这里是原生工具、在那里可能收在 `run_code` 里，写死了就会让模型去调一个不存在的工具，报 `UNKNOWN_TOOL`。规矩只说「该做什么」，调用形式交给工具本身。

只在一类会话里才用得上的规矩，给它加 `appliesTo`，别让它占满每一轮的预算：

```json
{ "key": "rule.xiaoheihe.browse_tool", "value": "逛小黑盒时用指定工具打开。", "appliesTo": "local" }
```

取值是 `any`（默认，哪都注入）、`group`、`private`、`local`。分得刻意很粗：只有这四类，
不按话题、不按时间段细分。定时任务和普通本地会话在执行时看不出区别，所以共用 `local`，
不去猜「这次是不是定时任务」。拿不准就留 `any`——少注入一条规矩的代价，比把红线漏掉小得多。

