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
          const F = React.Fragment;
          const BASE = '/tide/api';
          const ZH = (navigator.language || '').toLowerCase().startsWith('zh');
          const L = (pair) => (Array.isArray(pair) ? pair[ZH ? 0 : 1] : pair);
          const t = (pair) => pair[ZH ? 0 : 1];
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
            reading: ['读取中…', 'Loading…'],
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

          function Switch({ checked, onChange, label }) {
            return h(
              'button',
              {
                type: 'button',
                role: 'switch',
                'aria-checked': checked,
                'aria-label': label,
                className: checked ? 'tide-switch on' : 'tide-switch',
                onClick: () => onChange(!checked),
              },
              h('span', { className: 'tide-knob' }),
            );
          }

          function Field({ label, type, value, overridden, onChange, onClear }) {
            const control =
              type === 'bool'
                ? h(Switch, { checked: value === true, onChange, label })
                : h('input', {
                    className: 'tide-input',
                    type: type === 'text' ? 'text' : 'number',
                    value: value ?? '',
                    step: type === 'num' ? 'any' : undefined,
                    onChange: (e) => onChange(type === 'text' ? e.target.value : Number(e.target.value)),
                  });
            return h(
              'div',
              { className: 'tide-row' },
              h(
                'div',
                { className: 'tide-row-text' },
                h('span', { className: 'tide-label' }, label),
                overridden
                  ? h(
                      'span',
                      { className: 'tide-tag' },
                      t(T.overridden),
                      h('button', { type: 'button', className: 'tide-link', onClick: onClear }, t(T.reset)),
                    )
                  : null,
              ),
              control,
            );
          }

          function SettingsPage() {
            const [state, setState] = React.useState({ loading: true, error: null, groups: [], fields: [], dirty: {}, saving: false, saved: false });

            const apply = (data) => {
              const map = {};
              const meta = {};
              for (const f of data.fields ?? []) {
                map[f.key] = f.value;
                meta[f.key] = { overridden: f.overridden === true };
              }
              return { groups: data.groups ?? [], fields: data.fields ?? [], values: map, fieldMeta: meta };
            };

            React.useEffect(() => {
              let alive = true;
              getJson('/settings')
                .then((data) => alive && setState((s) => ({ ...s, loading: false, ...apply(data), dirty: {} })))
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
                setState((s) => ({ ...s, ...apply(data), dirty: {}, saved: false, error: null }));
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

            if (state.loading) return h('p', { className: 'tide-note' }, t(T.loading));

            const dirtyCount = Object.keys(state.dirty ?? {}).length;
            return h(
              'div',
              { className: 'tide-panel' },
              h(
                'header',
                { className: 'tide-head' },
                h(
                  'div',
                  null,
                  h('h3', { className: 'tide-title' }, 'Tide'),
                  h('p', { className: 'tide-sub' }, t(T.brandTag)),
                ),
                h(
                  'button',
                  { type: 'button', className: 'tide-primary', disabled: state.saving || dirtyCount === 0, onClick: save },
                  state.saving ? t(T.saving) : t(T.save),
                ),
              ),
              state.error ? h('p', { className: 'tide-error' }, t(T.err) + state.error) : null,
              ...state.groups.map((g) =>
                h(
                  'section',
                  { key: L(g.title), className: 'tide-card' },
                  h('h4', { className: 'tide-card-title' }, L(g.title)),
                  g.hint ? h('p', { className: 'tide-card-hint' }, L(g.hint)) : null,
                  h(
                    'div',
                    { className: 'tide-rows' },
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
              ),
              h(Browse, null),
              h(
                'footer',
                { className: 'tide-foot' },
                state.saved ? h('span', { className: 'tide-ok' }, t(T.saved)) : null,
                h('span', { className: 'tide-note' }, t(T.note)),
              ),
              h('p', { className: 'tide-note' }, t(T.firstRun)),
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
            const tabs = [
              ['facts', t(T.facts)],
              ['events', t(T.events)],
              ['attention', t(T.attention)],
            ];
            return h(
              'section',
              { className: 'tide-card' },
              h('h4', { className: 'tide-card-title' }, t(T.browse)),
              h(
                'div',
                { className: 'tide-tabs' },
                ...tabs.map(([k, label]) =>
                  h('button', { key: k, type: 'button', className: tab === k ? 'tide-tab on' : 'tide-tab', onClick: () => setTab(k) }, label),
                ),
                tab === 'facts'
                  ? h('input', {
                      className: 'tide-search',
                      placeholder: t(T.search),
                      value: q,
                      onChange: (e) => setQ(e.target.value),
                    })
                  : null,
              ),
              state.loading
                ? h('p', { className: 'tide-note' }, t(T.reading))
                : h(
                    'div',
                    { className: 'tide-list' },
                    ...(rows.length === 0
                      ? [h('p', { className: 'tide-note' }, t(T.empty))]
                      : rows.slice(0, 40).map((r, i) =>
                          h(
                            'div',
                            { key: i, className: 'tide-item' },
                            tab === 'facts'
                              ? h(
                                  F,
                                  null,
                                  h('div', { className: 'tide-item-head' }, h('code', null, r.key), h('span', { className: 'tide-meta' }, r.subtype + (r.scope ? ' · ' + r.scope : ''))),
                                  h('div', { className: 'tide-value' }, String(r.value ?? '').slice(0, 140)),
                                )
                              : tab === 'events'
                                ? h(
                                    F,
                                    null,
                                    h('div', { className: 'tide-item-head' }, h('span', { className: 'tide-meta' }, (r.speaker ? r.speaker + ' · ' : '') + (r.scope ?? ''))),
                                    h('div', { className: 'tide-value' }, String(r.content ?? '').slice(0, 140)),
                                  )
                                : h(
                                    F,
                                    null,
                                    h(
                                      'div',
                                      { className: 'tide-item-head' },
                                      h('code', null, r.label),
                                      h('span', { className: 'tide-meta' }, t(T.weight) + ' ' + r.weight + ' · ' + t(T.hits) + ' ' + r.hits),
                                      h('button', { type: 'button', className: 'tide-link', onClick: () => retire(r.id) }, t(T.retire)),
                                    ),
                                  ),
                          ),
                        )),
                  ),
            );
          }

          function Summary() {
            const [text, setText] = React.useState('Tide');
            React.useEffect(() => {
              let alive = true;
              getJson('/overview')
                .then((d) => alive && setText(`${t(T.facts)} ${d.facts} · ${t(T.events)} ${d.events} · ${t(T.attention)} ${d.attention}`))
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
              style.dataset.dshChatTide = 'true';
              style.textContent = `
                .tide-panel{display:flex;flex-direction:column;gap:16px;padding:2px 0 8px;color:var(--dsw-alias-label-primary,inherit);font-size:13px}
                .tide-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}
                .tide-title{margin:0;font-size:16px;font-weight:600;letter-spacing:.2px}
                .tide-sub{margin:2px 0 0;font-size:12px;color:var(--dsw-alias-label-tertiary,rgba(127,127,127,.7))}
                .tide-primary{padding:5px 14px;border-radius:8px;border:1px solid transparent;background:var(--dsw-alias-brand-primary,#3b82f6);color:#fff;font-size:12px;cursor:pointer}
                .tide-primary:disabled{opacity:.4;cursor:default}
                .tide-card{border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.18));border-radius:10px;padding:12px 14px;background:var(--dsw-alias-bg-layer-1,transparent)}
                .tide-card-title{margin:0;font-size:12px;font-weight:600;letter-spacing:.4px;text-transform:uppercase;color:var(--dsw-alias-label-secondary,rgba(127,127,127,.9))}
                .tide-card-hint{margin:4px 0 0;font-size:12px;color:var(--dsw-alias-label-tertiary,rgba(127,127,127,.7))}
                .tide-rows{display:flex;flex-direction:column;margin-top:8px}
                .tide-row{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:7px 0;border-top:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.12))}
                .tide-row:first-child{border-top:0}
                .tide-row-text{display:flex;align-items:center;gap:8px;min-width:0}
                .tide-label{font-size:13px}
                .tide-input{width:104px;padding:4px 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.3));background:var(--dsw-alias-bg-layer-2,transparent);color:inherit;font-size:12px;text-align:right}
                .tide-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary,#3b82f6)}
                .tide-switch{width:34px;height:20px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.35));background:var(--dsw-alias-bg-layer-2,transparent);position:relative;cursor:pointer;padding:0;transition:background .15s,border-color .15s}
                .tide-switch.on{background:var(--dsw-alias-brand-primary,#3b82f6);border-color:transparent}
                .tide-knob{position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:#fff;transition:transform .15s}
                .tide-switch.on .tide-knob{transform:translateX(14px)}
                .tide-tag{display:inline-flex;align-items:center;gap:6px;font-size:11px;color:var(--dsw-alias-brand-primary,#3b82f6)}
                .tide-link{border:0;background:transparent;color:inherit;opacity:.7;font-size:11px;cursor:pointer;padding:0;text-decoration:none}
                .tide-link:hover{opacity:1;text-decoration:underline}
                .tide-note{font-size:12px;color:var(--dsw-alias-label-tertiary,rgba(127,127,127,.7));margin:0}
                .tide-ok{font-size:12px;color:var(--dsw-alias-state-success-primary,#16a34a)}
                .tide-error{font-size:12px;color:var(--dsw-alias-state-error-primary,#dc2626);margin:0}
                .tide-foot{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
                .tide-tabs{display:flex;align-items:center;gap:14px;margin:10px 0 6px;flex-wrap:wrap}
                .tide-tab{border:0;background:transparent;color:var(--dsw-alias-label-secondary,rgba(127,127,127,.9));font-size:12px;cursor:pointer;padding:2px 0;border-bottom:2px solid transparent}
                .tide-tab.on{color:var(--dsw-alias-label-primary,inherit);border-bottom-color:var(--dsw-alias-brand-primary,#3b82f6)}
                .tide-search{flex:1;min-width:120px;padding:4px 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.3));background:var(--dsw-alias-bg-layer-2,transparent);color:inherit;font-size:12px}
                .tide-list{display:flex;flex-direction:column;max-height:320px;overflow:auto;margin-top:4px}
                .tide-item{padding:8px 0;border-top:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.12))}
                .tide-item:first-child{border-top:0}
                .tide-item-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
                .tide-item-head code{font-size:12px}
                .tide-meta{font-size:11px;color:var(--dsw-alias-label-tertiary,rgba(127,127,127,.7))}
                .tide-value{font-size:12px;margin-top:2px;color:var(--dsw-alias-label-secondary,rgba(127,127,127,.95));word-break:break-word}
              `;
              document.head.append(style);
              return () => style.remove();
            }, 'tide: settings styles');

            ctx.slots.inject('plugins.row.config', function* () {
              yield ctx.slots.register(
                { name: 'plugins.row.config', key: 'dsh-chat-tide#tide' },
                (props) => (props.view === 'summary' ? h(Summary, null) : h(SettingsPage, null)),
              );
            });
            // 自检：apply 跑到这里说明前端那一半起来了；宿主记一行，便于排查注册问题
            try {
              void fetch(BASE + '/client-loaded', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ key: 'dsh-chat-tide#tide', id: 'dsh-chat-tide' }),
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
