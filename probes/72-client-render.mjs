// 设置页真渲染：用桩 React 调一次组件，抓运行期错误（未定义变量、坏结构）
import { readFileSync } from 'node:fs';

const src = readFileSync('D:/Projects/dsh-chat-tide/lib/client.js', 'utf8');

let fail = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  if (!cond) fail++;
};

const nodes = [];
const stateQueue = [];
const h = (type, props, ...children) => {
  const node = { type: typeof type === 'function' ? type.name || 'fn' : String(type), props: props ?? {}, children: children.flat(9) };
  nodes.push(node);
  return node;
};

const React = {
  createElement: h,
  Fragment: 'Fragment',
  useState(init) {
    // 第一次渲染用初始值；组件内部 setState 一律记录不执行
    const value = stateQueue.length ? stateQueue.shift() : typeof init === 'function' ? init() : init;
    return [value, () => {}];
  },
  useEffect(fn) {
    // 渲染期不跑副作用（真实环境是提交后跑），但把函数留存以便检查
    void fn;
  },
  useMemo: (fn) => fn(),
  useRef: (v) => ({ current: v }),
  useCallback: (fn) => fn,
};

const modules = { react: React };
globalThis.window = { __ModuleLoader__: { load(entry) { globalThis.__entry = entry; } }, location: { href: '' } };
globalThis.document = {
  createElement: () => ({ click() {}, remove() {}, style: {}, dataset: {}, set textContent(v) {}, append() {}, appendChild() {} }),
  head: { append() {} },
  body: { appendChild() {}, removeChild() {} },
  addEventListener() {},
  removeEventListener() {},
};
globalThis.fetch = () => Promise.resolve({ ok: false, json: () => Promise.resolve({}) });

new Function('window', 'document', 'globalThis', 'fetch', src)(globalThis.window, globalThis.document, globalThis, globalThis.fetch);
const entry = globalThis.__entry;
const api = entry.factory((name) => modules[name] ?? React);

// 用假 ctx 调 apply，截获注册进来的组件
let registered = null;
const disposers = [];
const ctx = {
  effect(fn) {
    const d = fn();
    if (typeof d === 'function') disposers.push(d);
    return d;
  },
  slots: {
    inject(_key, cb) {
      // client 侧用生成器注入
      const gen = typeof cb === 'function' ? cb() : null;
      if (gen && typeof gen.next === 'function') {
        const { value } = gen.next();
        // value 可能是 register 的返回
        void value;
      }
    },
    register(_key, component) {
      registered = component;
      return () => {};
    },
  },
};

await api.apply(ctx).catch((err) => {
  ok(false, 'apply 可执行', String(err?.message ?? err));
});
ok(typeof registered === 'function', '设置页组件已注册');

if (typeof registered === 'function') {
  // 桩数据：页面需要 groups/fields/state
  const settingsPayload = {
    ok: true,
    groups: [
      {
        title: ['日常', 'Everyday'],
        hint: ['提示', 'hint'],
        advanced: false,
        collapsible: false,
        defaultOpen: true,
        fields: [
          ['scope.mode', ['在哪些聊天里使用', 'Which chats'], 'select', ['follow', 'off'], null, { labels: { follow: ['跟随 QQBot', 'Follow'], off: ['关闭', 'Off'] } }],
          ['scope.sessionIds', ['选中的聊天', 'Chosen'], 'sessions', null, { when: ['scope.mode', 'sessions'] }],
          ['extract.enabled', ['自动记事', 'Remember'], 'bool', null, { hint: ['关掉后暂停', 'off pauses'] }],
          ['owner.ids', ['谁可以定规矩', 'Who can set rules'], 'owner'],
          ['routing.quietStart', ['从', 'From'], 'time', null, { when: ['routing.quietEnabled', true] }],
          ['routing.maxWakesPerDay', ['每天最多', 'Attempts'], 'num'],
        ],
      },
      {
        title: ['高级参数', 'Advanced'],
        hint: ['高级', 'adv'],
        advanced: true,
        collapsible: false,
        defaultOpen: true,
        fields: [['routing.high', ['高位阈值', 'High'], 'num']],
      },
    ],
    fields: [
      { key: 'scope.mode', value: 'follow', overridden: false },
      { key: 'scope.sessionIds', value: '', overridden: false },
      { key: 'extract.enabled', value: true, overridden: false },
      { key: 'owner.ids', value: '', overridden: false },
      { key: 'routing.quietStart', value: '00:00', overridden: false },
      { key: 'routing.maxWakesPerDay', value: 20, overridden: false },
      { key: 'routing.high', value: 0.55, overridden: false },
    ],
  };

  // 让 settings 已经加载完成：模拟 useState 的初始值序列由组件内部决定，
  // 这里直接调用组件，Bool 值为初始值（loading=true → 只渲染 loading 文案）
  try {
    const out = registered({ view: 'config' });
    ok(Boolean(out), '组件首次渲染不抛错');
  } catch (err) {
    ok(false, '组件首次渲染不抛错', String(err?.stack ?? err).split('\n').slice(0, 3).join(' | '));
  }

  // 关键：把状态换成「已加载」，走真正的列表渲染路径
  stateQueue.length = 0;
  stateQueue.push({
    loading: false,
    error: null,
    groups: settingsPayload.groups,
    fields: settingsPayload.fields,
    values: Object.fromEntries(settingsPayload.fields.map((f) => [f.key, f.value])),
    fieldMeta: Object.fromEntries(settingsPayload.fields.map((f) => [f.key, { overridden: false }])),
    dirty: {},
    saving: false,
    saved: false,
    showAdvanced: false,
    open: {},
    ownerInfo: { ids: ['OPENID_X'], reason: 'qqbot-allowlist-single' },
  });
  try {
    registered({ view: 'config' });
    ok(true, '已加载状态渲染不抛错');
  } catch (err) {
    ok(false, '已加载状态渲染不抛错', String(err?.stack ?? err).split('\n').slice(0, 3).join(' | '));
  }

  // 回归：折叠组依赖 setOpen，定义和使用顺序都要在
  ok(/const setOpen =/.test(src), 'setOpen 已定义');

  // 回归：初始状态必须带 open/showAdvanced，否则加载完成后渲染会读 undefined
  ok(/showAdvanced: false, open: \{\}/.test(src), '初始状态包含 open 与 showAdvanced');

  // 高级组在默认状态下不应出现
  const titles = nodes.filter((n) => n.type === 'section').map((n) => n.props?.key);
  ok(!titles.includes('高级参数'), '高级参数默认隐藏', JSON.stringify(titles));

  // 再跑一次 summary 视图
  try {
    const out = registered({ view: 'summary' });
    ok(Boolean(out), '摘要视图不抛错');
  } catch (err) {
    ok(false, '摘要视图不抛错', String(err?.message ?? err));
  }
}

console.log(fail === 0 ? '\n全部通过' : `\n${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
