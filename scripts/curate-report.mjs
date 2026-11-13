// 记忆体检（只读，不调模型）：规则层 + 向量层，圈出该处理的条目。
// 用法：node scripts/curate-report.mjs [--json]
import { DatabaseSync } from 'node:sqlite';
import { getLoadablePath } from 'sqlite-vec';

const OWNER_ID = process.env.CM_OWNER ?? 'AAAA0000BBBB1111CCCC2222DDDD3333';
const dbFile = process.env.MEMORY_DB ?? `${process.env.USERPROFILE}/.dsh/chat-memory/memory.db`;
const db = new DatabaseSync(dbFile, { allowExtension: true });
let vecReady = false;
try {
  db.loadExtension(getLoadablePath());
  vecReady = true;
} catch {
  vecReady = false;
}

const all = (sql, ...a) => {
  try {
    return db.prepare(sql).all(...a);
  } catch (e) {
    return [{ error: e.message }];
  }
};
const one = (sql, ...a) => all(sql, ...a)[0] ?? {};

const NS = {
  rule: /^rule\./,
  self: /^self\./,
  relation: /^rel\./,
  profile: /^(owner|other)\./,
  preference: /^pref\.(owner|other)\./,
  todo: /^todo\.(owner|other)\./,
};

const findings = [];
const add = (kind, severity, items, hint) => findings.push({ kind, severity, count: items.length, hint, items });

// ── 规则层 ──
const facts = all(
  `SELECT f.fact_id AS id, f.user_id AS uid, f.entity_id AS eid, f.canonical_key AS k, f.subtype AS s,
          f.provenance_tier AS tier, f.updated_at AS up, f.source_record_id AS src, v.value AS val, v.surface AS surface
     FROM fact f JOIN fact_version v ON v.fact_id=f.fact_id AND v.version=f.current_version
    WHERE f.status='active'`,
);

// 1) 命名空间不合规
const badNs = facts.filter((f) => NS[f.s] && !NS[f.s].test(f.k)).map((f) => ({ 键: f.k, 类型: f.s, 值: String(f.val).slice(0, 30) }));
add('键不符合命名空间', '中', badNs, '按 subtype 套前缀');

// 2) 值像碎片（无对象/过短）
const frags = facts
  .filter((f) => f.s !== 'rule' && String(f.val ?? '').trim().length <= 6 && /[了着过一下的吧]/.test(String(f.val)))
  .map((f) => ({ 键: f.k, 值: f.val, 类型: f.s }));
add('疑似碎片（短且带虚词）', '中', frags, '回原文补全对象，补不上就删');

// 3) 缺证据原句
const noSurface = facts.filter((f) => !f.surface && f.s !== 'rule').map((f) => ({ 键: f.k, 值: String(f.val).slice(0, 30) }));
add('缺证据原句 surface', '低', noSurface, '可用于回溯，缺了不影响使用');

// 4) 等级可疑：human_explicit 但值含推测词
const HEDGE = /(可能|大概|也许|似乎|应该是|估计)/;
const badTier = facts
  .filter((f) => f.s !== 'rule' && f.s !== 'todo' && f.tier === 'human_explicit' && HEDGE.test(String(f.val ?? '')))
  .map((f) => ({ 键: f.k, 值: String(f.val).slice(0, 30) }));
add('等级可疑（原话里带推测词）', '中', badTier, '改为 agent_inferred 或 source_verifiable');

// 5) 归属核对：只比"流水账里真的写了信封"的那些，系统噪声/群级归因不算
const mism = all(
  `SELECT f.canonical_key k, f.user_id uid, r.user_id sender, r.payload p
     FROM fact f JOIN raw_log r ON r.record_id = f.source_record_id
    WHERE f.status='active' AND f.user_id IS NOT NULL AND r.user_id IS NOT NULL AND f.user_id <> r.user_id`,
).filter((r) => {
  if (r.error) return false;
  const text = String(r.p ?? '');
  // 只有带 [昵称 (openid)] 信封的才说明真实发言人
  const m = /^\s*\[[^\]\n]{1,24}?\s*\(([0-9A-Fa-f]{20,})\)\]/.exec(text);
  return Boolean(m && m[1] !== r.uid);
});
add('归属与流水账不一致', '高', mism.map((r) => ({ 键: r.k, 事实归属: String(r.uid).slice(0, 8), 流水账: String(r.sender).slice(0, 8) })), '以流水账发送者为准');

// 6) 观察缺发言人
const noSpeaker = all(
  "SELECT content FROM event WHERE status='active' AND event_type='observation' AND speaker_name IS NULL LIMIT 50",
);
add('经历缺发言人', '中', noSpeaker.map((r) => ({ 内容: String(r.content).slice(0, 30) })), '群聊里分不清谁说的');

// 7) 陈旧待办
const staleTodos = all(
  "SELECT canonical_key k, datetime(updated_at/1000,'unixepoch') at FROM fact WHERE status='active' AND subtype='todo' AND updated_at < ?",
  Date.now() - 45 * 86_400_000,
);
add('待办超过 45 天未动', '低', staleTodos.map((r) => ({ 键: r.k, 更新时间: r.at })), '可能已经做完或作废');

// 8) 关注点漂移（长期零命中）
const drift = all(
  "SELECT label, weight, datetime(created_at/1000,'unixepoch') at FROM attention WHERE status='active' AND hits=0 AND created_at < ?",
  Date.now() - 14 * 86_400_000,
);
add('关注点长期零命中', '低', drift.map((r) => ({ 主题: r.label, 建立: r.at })), '考虑退休');

// 9) 软删但无审计
const noAudit = all(
  "SELECT f.canonical_key k FROM fact f LEFT JOIN tombstone t ON t.target_id=f.fact_id AND t.target_type='fact' WHERE f.status='deleted' AND t.target_id IS NULL LIMIT 50",
);
add('删除无 tombstone 审计', '低', noAudit.map((r) => ({ 键: r.k })), '历史遗留，新删除已补审计');

// 10) 同键多活
const dupKeys = all(
  "SELECT canonical_key k, user_id u, count(*) c FROM fact WHERE status='active' GROUP BY canonical_key, user_id HAVING c>1",
);
add('同键多活', '高', dupKeys.map((r) => ({ 键: r.k, 条数: r.c })), '正常不该出现');

// 11) 非规则事实缺来源关联（历史索引断了）
const noLink = all(
  "SELECT f.canonical_key k FROM fact f LEFT JOIN raw_log r ON r.record_id=f.source_record_id WHERE f.status='active' AND f.subtype<>'rule' AND r.record_id IS NULL",
);
add('缺来源关联（历史断链）', '中', noLink.map((r) => ({ 键: r.k })), '应能回溯到原始消息，便于核对');

// 12) 非 openid 归属（测试会话或历史脏数据）
const oddOwner = all(
  "SELECT canonical_key k, user_id u FROM fact WHERE status='active' AND (user_id LIKE 'session-%' OR user_id LIKE '%-%-%-%-%')",
);
add('非 openid 归属', '中', oddOwner.map((r) => ({ 键: r.k, 归属: String(r.u).slice(0, 10) })), '应挂到 openid 或标记为测试数据');

// 13) 关注点缺向量（会导致永远无法直接唤醒）
if (vecReady) {
  const noVec = all(
    `SELECT a.label FROM attention a
      WHERE a.status='active' AND NOT EXISTS (SELECT 1 FROM vec_attention v WHERE v.rowid = a.rowid)`,
  );
  add('关注点缺向量', '高', noVec.map((r) => ({ 主题: r.label })), '关注点不进向量空间就无法直接唤醒');
}

// 14) 人表缺昵称
const noNick = all("SELECT openid FROM people WHERE nickname IS NULL OR nickname = ''");
add('人表缺昵称', '低', noNick.map((r) => ({ openid: String(r.openid).slice(0, 10) })), '注入时只能显示 id 前缀');

// 15) 事实缺场景（unknown 比例高说明来源链路断了）
const unknownOther = all(
  "SELECT canonical_key k FROM fact WHERE status='active' AND COALESCE(scope,'unknown')='unknown' AND subtype <> 'rule' AND user_id <> OWNER_ID",
);
const unknownOwner = all(
  "SELECT canonical_key k FROM fact WHERE status='active' AND COALESCE(scope,'unknown')='unknown' AND subtype <> 'rule' AND user_id = OWNER_ID",
);
add('他人事实场景未知', '高', unknownOther.map((r) => ({ 键: r.k })), '可能把私聊内容带进群聊');
add('主人事实场景未知', '低', unknownOwner.map((r) => ({ 键: r.k })), '主人的事实在群里出现风险较低');

// 16) 孤儿向量
if (vecReady) {
  const orphanFacts = all(
    `SELECT v.rowid AS rid FROM vec_fact v WHERE NOT EXISTS (
        SELECT 1 FROM fact_version fv JOIN fact f ON f.fact_id=fv.fact_id AND f.current_version=fv.version
         WHERE fv.rowid=v.rowid AND f.status='active') LIMIT 50`,
  );
  const orphanEvents = all(
    `SELECT v.rowid AS rid FROM vec_event v WHERE NOT EXISTS (SELECT 1 FROM event e WHERE e.rowid=v.rowid AND e.status='active') LIMIT 50`,
  );
  add('孤儿向量', '高', [...orphanFacts, ...orphanEvents].map((r) => ({ rowid: Number(r.rid) })), '已删除内容仍在参与 KNN');
}

// 17) 重复规则（同尾键）
const rulesByTail = new Map();
for (const r of facts.filter((f) => f.s === 'rule')) {
  const tail = r.k.split('.').pop();
  if (!rulesByTail.has(tail)) rulesByTail.set(tail, []);
  rulesByTail.get(tail).push(r.k);
}
const dupRules = [...rulesByTail.entries()].filter(([, ks]) => ks.length > 1).map(([t, ks]) => ({ 同尾: t, 键: ks }));
add('重复规则（同尾键）', '高', dupRules, '规则块预算被占用');

// ── 向量层：近重复事实 ──
if (vecReady) {
  const vecRows = all(
    `SELECT vf.rowid AS rid, f.fact_id AS id, f.canonical_key AS k, f.subtype AS s, v.value AS val
       FROM vec_fact vf
       JOIN fact_version v ON v.rowid = vf.rowid
       JOIN fact f ON f.fact_id = v.fact_id AND f.current_version = v.version
      WHERE f.status='active' LIMIT 500`,
  ).filter((r) => !r.error);
  const seen = new Set();
  const pairs = [];
  for (const r of vecRows) {
    const near = all(
      `SELECT vf.rowid AS rid, distance FROM vec_fact vf
        WHERE vf.embedding MATCH (SELECT embedding FROM vec_fact WHERE rowid=?) AND k=2`,
      r.rid,
    ).filter((n) => !n.error);
    for (const n of near) {
      if (Number(n.rid) === Number(r.rid)) continue;
      const other = vecRows.find((x) => Number(x.rid) === Number(n.rid));
      if (!other) continue;
      const cos = 1 - n.distance;
      if (cos < 0.9) continue;
      // 短值向量不可靠：要求值本身也有明显重叠
      const norm = (x) => String(x ?? '').replace(/[\s，。；、！？]/g, '');
      const a = norm(r.val);
      const b = norm(other.val);
      const overlap = a && b ? (a === b || a.includes(b) || b.includes(a) ? 1 : [...new Set(a)].filter((ch) => b.includes(ch)).length / Math.max(a.length, b.length)) : 0;
      if (overlap < 0.6) continue;
      const key = [r.id, other.id].sort().join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push({ a: r.k, av: String(r.val).slice(0, 24), b: other.k, bv: String(other.val).slice(0, 24), cos: Number(cos.toFixed(3)) });
    }
  }
  add('疑似同义/重复事实（余弦≥0.9）', '中', pairs, '合并或建别名');
}

// ── 输出 ──
const total = findings.reduce((n, f) => n + f.count, 0);
if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ total, findings }, null, 2));
} else {
  console.log(`体检：${facts.length} 条活跃事实，${total} 项待看\n`);
  for (const f of findings) {
    if (!f.count) continue;
    console.log(`[${f.severity}] ${f.kind}：${f.count} 项 — ${f.hint}`);
    for (const it of f.items.slice(0, 3)) console.log('   ', JSON.stringify(it));
    if (f.count > 3) console.log(`    ...还有 ${f.count - 3} 项`);
    console.log('');
  }
  const zero = findings.filter((f) => !f.count).map((f) => f.kind);
  if (zero.length) console.log('无问题：', zero.join('、'));
}
db.close();
