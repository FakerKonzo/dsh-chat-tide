// 设置页真渲染：用桩 React 调一次组件，抓运行期错误（未定义变量、坏结构）
import { readFileSync } from 'node:fs';
import { DEFAULTS, GROUPS } from '../lib/schema.js';

const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');

let fail = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  if (!cond) fail++;
};

const nodes = [];
const stateQueue = [];
let transferHooks = null;
const h = (type, props, ...children) => {
  if (type.name === 'SettingsPage' || type.name === 'Summary') return type(props ?? {});
  const node = { type: typeof type === 'function' ? type.name || 'fn' : String(type), component: type, props: props ?? {}, children: children.flat(9) };
  nodes.push(node);
  return node;
};

const React = {
  createElement: h,
  Fragment: 'Fragment',
  useState(init) {
    if (transferHooks) {
      const { slots } = transferHooks;
      const index = transferHooks.index++;
      if (!(index in slots)) slots[index] = typeof init === 'function' ? init() : init;
      return [slots[index], (next) => { slots[index] = typeof next === 'function' ? next(slots[index]) : next; }];
    }
    const value = stateQueue.length ? stateQueue.shift() : typeof init === 'function' ? init() : init;
    return [value, () => {}];
  },
  useEffect(fn) {
    // 渲染期不跑副作用（真实环境是提交后跑），但把函数留存以便检查
    void fn;
  },
  useMemo: (fn) => fn(),
  useRef(value) {
    if (!transferHooks) return { current: value };
    const index = transferHooks.index++;
    return (transferHooks.slots[index] ??= { current: value });
  },
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
let releasePreview;
const fetch = (url) => {
  if (url.endsWith('/import/preview')) return new Promise((resolve) => { releasePreview = resolve; });
  return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
};

new Function('window', 'document', 'globalThis', 'fetch', 'navigator', src)(
  globalThis.window, globalThis.document, globalThis, fetch, { language: 'zh-CN' },
);
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
    groups: GROUPS,
    values: DEFAULTS,
    fieldMeta: {},
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

  const transfer = nodes.find((node) => node.type === 'Transfer')?.component;
  ok(typeof transfer === 'function', '设置页包含导入面板');
  if (transfer) {
    transferHooks = { slots: [], index: 0 };
    const render = () => {
      transferHooks.index = 0;
      nodes.length = 0;
      transfer();
    };
    const button = (label) => nodes.find((node) => node.type === 'button'
      && node.children.some((child) => String(child).includes(label)));
    const edit = (value) => nodes.find((node) => node.type === 'textarea').props.onChange({ target: { value } });
    render();
    edit('{"rules":[{"key":"rule.old","value":"旧输入"}]}');
    render();
    const oldRequest = button('预览导入').props.onClick();
    render();
    edit('{"rules":[]}');
    const response = { ok: true, json: async () => ({ ok: true, settings: [], rules: { added: [], updated: [] } }) };
    releasePreview(response);
    await oldRequest;
    render();
    ok(!button('确认导入'), '编辑期间返回的旧预览不能确认');
    const newRequest = button('预览导入').props.onClick();
    releasePreview(response);
    await newRequest;
    render();
    ok(Boolean(button('确认导入')), '当前输入重新预览后可以确认');
  }
}

console.log(fail === 0 ? '\n全部通过' : `\n${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
