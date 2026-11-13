window.__ModuleLoader__.load({
  id: 'dsh-chat-tide',
  factory: (require) => {
    const modules = {
      'client/index.js': {
        imports: {},
        run(module, exports, require) {
          'use strict';
          const React = require('react');
          const h = React.createElement;
          const BASE = '/chat-memory/api';
          const ZH = (navigator.language || '').toLowerCase().startsWith('zh');
          const L = (pair) => (Array.isArray(pair) ? pair[ZH ? 0 : 1] : pair);
          const T = {
            brandTag: ['记忆像潮汐，偶尔才响一声', 'Memory comes in waves'],
            loading: ['读取设置…', 'Loading settings…'],
            save: ['保存', 'Save'],
            saving: ['保存中…', 'Saving…'],
            saved: ['已保存，最多 5 秒生效', 'Saved — applies within 5 seconds'],
            overridden: ['已覆盖', 'overridden'],
            reset: ['恢复默认', 'reset'],
            note: ['改的是运行时覆盖值，不动配置文件；这里没列出的字段请到插件配置区改。', 'These are runtime overrides; the config file is untouched. Fields not listed here live in the plugin config page.'],
            firstRun: ['第一次用：确认作用域里勾了 QQ 会话，然后随便聊两句；空库时它不会开口，等有记忆了才可能接茬。', 'First run: make sure your chat session is in scope, then just talk. An empty memory stays silent until it has something to say.'],
            browse: ['记忆浏览', 'Memory'],
            facts: ['事实', 'Facts'],
            events: ['经历', 'Events'],
            attention: ['关注点', 'Attention'],
            search: ['搜索键或值…', 'Search keys or values…'],
            empty: ['（空）', '(empty)'],
            retire: ['不再关注', 'Stop watching'],
            weight: ['权重', 'weight'],
            hits: ['命中', 'hits'],
            err: ['出问题了：', 'Something broke: '],
          };

          async function getJson(path) {
            const r = await fetch(BASE + path, { headers: { accept: 'application/json' } });
            if (!r.ok) throw new Error('HTTP ' + r.status);
            return r.json();
          }
          async function postJson(path, body) {
            const r = await fetch(BASE + path, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(body ?? {}),
            });
            const data = await r.json().catch(() => ({}));
            if (!r.ok || data.ok === false) throw new Error(data.error ?? 'HTTP ' + r.status);
            return data;
          }

          // 分组清单由宿主 /settings 返回，页面不再硬编码键名
          function Field(props) {
            const { label, type, value, overridden, onChange, onClear } = props;
            const tag = overridden
              ? h(
                  'span',
                  { className: 'tide-tag' },
                  T.overridden[ZH ? 0 : 1],
                  h('button', { type: 'button', className: 'tide-reset', onClick: onClear }, T.reset[ZH ? 0 : 1]),
                )
              : null;
            if (type === 'bool') {
              return h(
                'label',
                { className: 'tide-row' },
                h('input', { type: 'checkbox', checked: value === true, onChange: (e) => onChange(e.target.checked) }),
                h('span', { className: 'tide-label' }, label, tag),
              );
            }
            return h(
              'label',
              { className: 'tide-row' },
              h('span', { className: 'tide-label' }, label, tag),
              h('input', {
                type: type === 'text' ? 'text' : 'number',
                value: value ?? '',
                step: type === 'num' ? 'any' : undefined,
                onChange: (e) => onChange(type === 'text' ? e.target.value : Number(e.target.value)),
              }),
            );
          }

          function SettingsPage() {
            const [state, setState] = React.useState({ loading: true, error: null, groups: [], fields: [], dirty: {}, saving: false, saved: false });
            React.useEffect(() => {
              let alive = true;
              getJson('/settings')
                .then((data) => {
                  if (!alive) return;
                  const map = {};
                  const meta = {};
                  for (const f of data.fields ?? []) {
                    map[f.key] = f.value;
                    meta[f.key] = { overridden: f.overridden === true };
                  }
                  setState((s) => ({ ...s, loading: false, groups: data.groups ?? [], fields: data.fields ?? [], fieldMeta: meta, values: map, dirty: {} }));
                })
                .catch((err) => alive && setState((s) => ({ ...s, loading: false, error: String(err.message ?? err) })));
              return () => {
                alive = false;
              };
            }, []);

            const values = state.values ?? {};
            const fieldMeta = state.fieldMeta ?? {};
            async function clearKey(key) {
              try {
                await postJson('/settings', { clear: [key] });
                const data = await getJson('/settings');
                const map = {};
                const meta = {};
                for (const f of data.fields ?? []) {
                  map[f.key] = f.value;
                  meta[f.key] = { overridden: f.overridden === true };
                }
                setState((s) => ({ ...s, values: map, fieldMeta: meta, dirty: {}, saved: false, error: null }));
              } catch (err) {
                setState((s) => ({ ...s, error: String(err.message ?? err) }));
              }
            }
            const setValue = (key, value) =>
              setState((s) => ({ ...s, values: { ...(s.values ?? {}), [key]: value }, dirty: { ...(s.dirty ?? {}), [key]: true }, saved: false }));

            async function save() {
              setState((s) => ({ ...s, saving: true, error: null }));
              try {
                const patch = {};
                for (const k of Object.keys(state.dirty ?? {})) patch[k] = values[k];
                await postJson('/settings', { values: patch });
                setState((s) => ({ ...s, saving: false, saved: true, dirty: {} }));
              } catch (err) {
                setState((s) => ({ ...s, saving: false, error: String(err.message ?? err) }));
              }
            }

            if (state.loading) return h('p', { className: 'tide-note' }, T.loading[ZH ? 0 : 1]);
            return h(
              'div',
              { className: 'tide-panel' },
              h(
                'div',
                { className: 'tide-brand' },
                h('strong', null, 'Tide'),
                h('span', { className: 'tide-note' }, T.brandTag[ZH ? 0 : 1]),
              ),
              state.error ? h('p', { className: 'tide-error' }, T.err[ZH ? 0 : 1] + state.error) : null,
              ...state.groups.map((g) =>
                h(
                  'section',
                  { key: g.title, className: 'tide-group' },
                  h('h4', null, L(g.title)),
                  g.hint ? h('p', { className: 'tide-hint' }, L(g.hint)) : null,
                  ...g.fields.map(([key, label, type]) =>
                    h(Field, {
                      key,
                      label: L(label),
                      type,
                      value: values[key],
                      overridden: Boolean((fieldMeta[key] ?? {}).overridden),
                      onChange: (v) => setValue(key, v),
                      onClear: () => clearKey(key),
                    }),
                  ),
                ),
              ),
              h(Browse, null),
              h(
                'div',
                { className: 'tide-actions' },
                h('button', { type: 'button', disabled: state.saving || !Object.keys(state.dirty ?? {}).length, onClick: save }, state.saving ? T.saving[ZH ? 0 : 1] : T.save[ZH ? 0 : 1]),
                state.saved ? h('span', { className: 'tide-note' }, T.saved[ZH ? 0 : 1]) : null,
              ),
              h('p', { className: 'tide-note' }, T.note[ZH ? 0 : 1]),
              h(
                'p',
                { className: 'tide-note' },
                '第一次用：确认作用域里勾了 QQ 会话，然后随便聊两句；空库时它不会开口，等有记忆了才可能接茬。',
              ),
            );
          }


          function Browse() {
            const [tab, setTab] = React.useState('facts');
            const [state, setState] = React.useState({ loading: true, rows: [] });
            const [q, setQ] = React.useState('');

            const load = React.useCallback(async () => {
              setState((s0) => ({ ...s0, loading: true }));
              try {
                const path =
                  tab === 'facts'
                    ? '/facts?limit=40' + (q ? '&q=' + encodeURIComponent(q) : '')
                    : tab === 'events'
                      ? '/events?limit=40'
                      : '/attention';
                const data = await getJson(path);
                setState({ loading: false, rows: data.rows ?? [] });
              } catch (err) {
                setState({ loading: false, rows: [], error: String(err.message ?? err) });
              }
            }, [tab, q]);

            React.useEffect(() => {
              void load();
            }, [load]);

            async function retire(id) {
              try {
                await postJson('/attention/retire', { id });
                await load();
              } catch {
                /* 失败保留原列表 */
              }
            }

            const rows = state.rows ?? [];
            return h(
              'section',
              { className: 'tide-group' },
              h('h4', null, T.browse[ZH ? 0 : 1]),
              h(
                'div',
                { className: 'tide-tabs' },
                ...[
                  ['facts', '事实'],
                  ['events', T.events[ZH ? 0 : 1]],
                  ['attention', T.attention[ZH ? 0 : 1]],
                ].map(([k, label]) =>
                  h(
                    'button',
                    { key: k, type: 'button', className: tab === k ? 'tide-tab on' : 'tide-tab', onClick: () => setTab(k) },
                    label,
                  ),
                ),
                tab === 'facts'
                  ? h('input', {
                      className: 'tide-search',
                      placeholder: T.search[ZH ? 0 : 1],
                      value: q,
                      onChange: (e) => setQ(e.target.value),
                    })
                  : null,
              ),
              state.loading
                ? h('p', { className: 'tide-note' }, '读取中…')
                : h(
                    'div',
                    { className: 'tide-list' },
                    ...(rows.length === 0
                      ? [h('p', { className: 'tide-note' }, T.empty[ZH ? 0 : 1])]
                      : rows.slice(0, 40).map((r, i) =>
                          h(
                            'div',
                            { key: i, className: 'tide-item' },
                            tab === 'facts'
                              ? h(
                                  _FragmentOf(),
                                  null,
                                  h('code', null, r.key),
                                  h('span', { className: 'tide-meta' }, r.subtype + (r.scope ? ' · ' + r.scope : '')),
                                  h('div', { className: 'tide-value' }, String(r.value ?? '').slice(0, 120)),
                                )
                              : tab === 'events'
                                ? h(
                                    _FragmentOf(),
                                    null,
                                    h('span', { className: 'tide-meta' }, (r.speaker ? r.speaker + ' · ' : '') + (r.scope ?? '')),
                                    h('div', { className: 'tide-value' }, String(r.content ?? '').slice(0, 120)),
                                  )
                                : h(
                                    _FragmentOf(),
                                    null,
                                    h('code', null, r.label),
                                    h('span', { className: 'tide-meta' }, T.weight[ZH ? 0 : 1] + ' ' + r.weight + ' · ' + T.hits[ZH ? 0 : 1] + ' ' + r.hits),
                                    h(
                                      'button',
                                      { type: 'button', className: 'tide-reset', onClick: () => retire(r.id) },
                                      '不再关注',
                                    ),
                                  ),
                          ),
                        )),
                  ),
            );
          }

          function _FragmentOf() {
            return React.Fragment;
          }

          function Summary() {
            const [text, setText] = React.useState('聊天记忆');
            React.useEffect(() => {
              let alive = true;
              getJson('/overview')
                .then((d) => alive && setText(`事实 ${d.facts}（规则 ${d.rules}）· 经历 ${d.events} · 关注点 ${d.attention}`))
                .catch(() => {});
              return () => {
                alive = false;
              };
            }, []);
            return h('span', null, text);
          }

          module.exports.name = 'tide-settings';
          module.exports.inject = ['slots'];
          module.exports.apply = async function apply(ctx) {
            ctx.effect(() => {
              const style = document.createElement('style');
              style.dataset.dshChatMemory = 'true';
              style.textContent = `
                .tide-panel{display:flex;flex-direction:column;gap:14px;padding:4px 0}
                .tide-group{border:1px solid rgba(127,127,127,.22);border-radius:8px;padding:8px 12px}
                .tide-group h4{margin:2px 0 8px;font-size:13px;opacity:.8}
                .tide-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:3px 0;font-size:13px}
                .tide-row input[type=number],.tide-row input[type=text]{width:120px;padding:2px 6px;border:1px solid rgba(127,127,127,.35);border-radius:5px;background:transparent;color:inherit}
                .tide-actions{display:flex;align-items:center;gap:10px}
                .tide-actions button{padding:4px 14px;border-radius:6px;border:1px solid rgba(127,127,127,.35);background:rgba(127,127,127,.12);color:inherit;cursor:pointer}
                .tide-actions button:disabled{opacity:.45;cursor:default}
                .tide-note{font-size:12px;opacity:.6}
                .tide-error{color:#c43;font-size:12px}
                .tide-brand{display:flex;align-items:baseline;gap:8px;font-size:14px}
                .tide-hint{margin:-4px 0 8px;font-size:12px;opacity:.55}
                .tide-tabs{display:flex;gap:6px;align-items:center;margin:6px 0 8px;flex-wrap:wrap}
                .tide-tab{padding:2px 10px;border-radius:999px;border:1px solid rgba(127,127,127,.3);background:transparent;color:inherit;cursor:pointer;font-size:12px}
                .tide-tab.on{background:rgba(64,132,255,.14);border-color:rgba(64,132,255,.4)}
                .tide-search{flex:1;min-width:120px;padding:2px 8px;border:1px solid rgba(127,127,127,.3);border-radius:6px;background:transparent;color:inherit;font-size:12px}
                .tide-list{display:flex;flex-direction:column;gap:6px;max-height:320px;overflow:auto}
                .tide-item{display:flex;flex-direction:column;gap:2px;padding:6px 0;border-bottom:1px solid rgba(127,127,127,.12)}
                .tide-item code{font-size:12px}
                .tide-meta{font-size:11px;opacity:.55}
                .tide-value{font-size:12px}
                .tide-label{display:inline-flex;align-items:center;gap:6px}
                .tide-tag{display:inline-flex;align-items:center;gap:4px;font-size:11px;padding:1px 6px;border-radius:999px;background:rgba(64,132,255,.12);color:#3b82f6}
                .tide-reset{font-size:11px;border:0;background:transparent;color:inherit;opacity:.75;cursor:pointer;text-decoration:underline;padding:0}
              `;
              document.head.append(style);
              return () => style.remove();
            }, 'tide: settings styles');

            ctx.slots.inject('plugins.row.config', function* () {
              // 主键是标准写法；另外两个是兜底：不同宿主版本对「行 id」的取法不完全一致，
              // 多注册不会多渲染，只会让真正被分发的那个键一定存在。
              for (const key of ['dsh-chat-tide#chat-memory']) {
                yield ctx.slots.register(
                  { name: 'plugins.row.config', key },
                  (props) => (props.view === 'summary' ? h(Summary, null) : h(SettingsPage, null)),
                );
              }
            });
            // 自检：apply 跑到这里说明前端那一半起来了；宿主记一行，便于排查注册问题
            try {
              void fetch(BASE + '/client-loaded', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ key: 'dsh-chat-tide#chat-memory', id: 'dsh-chat-tide' }),
              }).catch(() => {});
            } catch {
              /* 忽略 */
            }
          };
        },
      },
    };
    const cache = Object.create(null);
    function load(id) {
      if (cache[id]) return cache[id].exports;
      const entry = modules[id];
      if (!entry) throw new Error('Unknown Tide browser module: ' + id);
      const module = { exports: {} };
      cache[id] = module;
      entry.run(module, module.exports, (request) =>
        Object.hasOwn(entry.imports, request) ? load(entry.imports[request]) : require(request),
      );
      return module.exports;
    }
    return load('client/index.js');
  },
});
