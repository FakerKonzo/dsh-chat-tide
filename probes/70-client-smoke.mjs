// 客户端模块冒烟：用最小 React 桩真正跑一次模块体，抓未定义变量和坏结构
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');

let fail = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  if (!cond) fail++;
};

const nodes = [];
const h = (type, props, ...children) => {
  const node = { type: typeof type === 'function' ? type.name || 'fn' : type, props: props ?? {}, children: children.flat(9) };
  nodes.push(node);
  return node;
};
const React = {
  createElement: h,
  Fragment: 'Fragment',
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: () => {},
  useMemo: (fn) => fn(),
  useRef: (v) => ({ current: v }),
  useCallback: (fn) => fn,
};

let factoryResult = null;
const modules = {
  react: React,
};

globalThis.window = {
  __ModuleLoader__: {
    load(entry) {
      factoryResult = entry;
    },
  },
  location: { href: '' },
  setTimeout: () => 0,
  clearTimeout: () => {},
};
globalThis.document = { createElement: () => ({ click() {}, remove() {}, style: {} }), body: { appendChild() {}, removeChild() {} }, addEventListener() {}, removeEventListener() {} };
globalThis.fetch = () => Promise.resolve({ ok: false, json: () => Promise.resolve({}) });

// 载入模块体（它会把自己注册进来）
try {
  new Function('window', 'document', 'globalThis', 'fetch', src)(globalThis.window, globalThis.document, globalThis, globalThis.fetch);
  ok(true, '模块体可执行');
} catch (err) {
  ok(false, '模块体可执行', String(err?.message ?? err));
}

ok(factoryResult?.id === 'dsh-chat-tide', '注册到 ModuleLoader 的 id 正确', factoryResult?.id);

// 跑工厂，逼出客户端代码里的未定义引用
let api = null;
try {
  api = factoryResult.factory((name) => {
    if (modules[name]) return modules[name];
    if (name === 'react') return React;
    return React;
  });
  ok(true, '工厂可执行');
} catch (err) {
  ok(false, '工厂可执行', String(err?.message ?? err));
}

ok(api && typeof api === 'object', '导出对象存在', JSON.stringify(Object.keys(api ?? {})).slice(0, 80));

// 文案键完整性：用了但没定义的 t(T.x) 会在页面上显示成空白
const usedLabels = new Set([...src.matchAll(/t\(T\.(\w+)/g)].map((m) => m[1]));
const missing = [...usedLabels].filter((k) => !new RegExp('\\b' + k + ': \\[').test(src));
ok(missing.length === 0, '用到的文案键都有定义', JSON.stringify(missing));

// 主人来源的键必须齐全（多一种来源就多一行显示）
for (const k of ['configured', 'qqbot-open-list', 'allowlist-is-access-control', 'empty-list', 'no-plugin']) {
  ok(src.includes("'" + k + "'") || new RegExp('\\b' + k.replace(/-/g, '\\-') + ': \\[').test(src), '主人来源文案含 ' + k);
}

// 结构检查（这些是新页面依赖的东西）
for (const name of ['function Transfer()', 'const SessionPickerInline', 'OWNER_SOURCE', 'state.showAdvanced', 'tide-advanced']) {
  ok(src.includes(name), `包含 ${name}`);
}

console.log(fail === 0 ? '\n全部通过' : `\n${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
