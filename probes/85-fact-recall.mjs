// 用内存库验证召回的顺序、隔离筛选和事实更新。
import assert from 'node:assert/strict';
import { openDatabase } from '../lib/db.js';
import { writeFact } from '../lib/facts.js';
import { buildInjection, recallQuery } from '../lib/inject.js';
import { ensureVecTables, loadVec, putVector } from '../lib/vec.js';

const db = openDatabase(':memory:');
const now = Date.now();
const input = { userId: 'saved-user', scope: 'group', provenanceTier: 'human_explicit', occurredAt: now };
const binding = { peerId: input.userId, conversationKey: 'qq:second-chat', scope: 'c2c' };
const assemble = (text, options = {}) => buildInjection({
  db, binding, now, payload: { messages: [{ role: 'user', content: [{ type: 'text', text }] }] },
  cfg: { unifySessions: true, maxChars: 180 }, ...options,
}).factBlock;

try {
  const city = writeFact(db, { ...input, canonicalKey: 'profile.city', value: '杭州', evidence: '我常住杭州' });
  db.prepare('UPDATE fact SET updated_at=1 WHERE fact_id=?').run(city.factId);
  for (let i = 0; i < 38; i++) {
    writeFact(db, { ...input, canonicalKey: 'profile.unrelated_' + i, value: '无关事项 ' + i });
  }
  writeFact(db, { ...input, canonicalKey: 'profile.future', value: '未来搬到杭州', validFrom: now + 1000 });
  const text = '[Chat history begins]\n无关事项\n[Current message]\n[小林 (saved-user)] 我常住哪里？(@you)';
  assert.equal(recallQuery({ messages: [{ content: [{ type: 'text', text }] }] }).text, '我常住哪里？');
  assert.match(assemble(text), /profile.city: 杭州/);
  assert.doesNotMatch(assemble('我的住址和杭州有关吗？'), /未来搬到杭州/);
  assert.doesNotMatch(assemble(text, { cfg: { unifySessions: false } }), /profile.city/);

  if (loadVec(db)) {
    ensureVecTables(db);
    const close = new Float32Array(512);
    close[0] = 0.9;
    close[1] = Math.sqrt(1 - 0.9 ** 2);
    const exact = new Float32Array(512);
    exact[0] = 1;
    putVector(db, 'vec_fact', city.versionRowid, close);
    for (let i = 0; i < 10; i++) {
      const other = writeFact(db, { ...input, userId: 'another-user-' + i, canonicalKey: 'profile.city', value: '南京' });
      putVector(db, 'vec_fact', other.versionRowid, exact);
    }
    const query = '我定居在哪座城市？';
    assert.match(assemble(query, { vector: exact }), /profile.city: 杭州/);
    assert.doesNotMatch(assemble(query, { vector: exact }), /南京/);
    const corrected = writeFact(db, {
      ...input, occurredAt: now + 1, canonicalKey: 'profile.city', value: '苏州', evidence: '我现在常住苏州',
    });
    putVector(db, 'vec_fact', corrected.versionRowid, close);
    assert.match(assemble(query, { vector: exact }), /profile.city: 苏州/);
    assert.doesNotMatch(assemble(query, { vector: exact }), /杭州/);
  }
  console.log('旧事实可按问题召回，筛选后才排名，更新只取新值');
} finally {
  db.close();
}
