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

          // 宿主自带的 Switch；清单里已声明 inject，拿不到就退回自绘
          let HostSwitch = null;
          try {
            const primitives = require('@deepseek-ai/dsh-client-ui-primitives');
            if (primitives && typeof primitives.Switch === 'function') HostSwitch = primitives.Switch;
          } catch {
            /* 宿主版本没有这些组件 */
          }
          const OWNER_SOURCE = {
            configured: ['你手动指定的', 'set by you'],
            'qqbot-open-list': ['来自 QQBot 私聊名单', 'from the QQBot private list'],
            'allowlist-is-access-control': ['QQBot 名单是准入清单，不授予权限', 'the QQBot list controls access, not ownership'],
            'empty-list': ['名单是空的', 'the list is empty'],
            'no-plugin': ['没有安装 QQBot', 'QQBot is not installed'],
            unknown: ['来源未知', 'unknown source'],
          };

          const SCOPE_LABELS = {
            follow: ['跟随 dsh-qqbot', 'Follow dsh-qqbot'],
            workspace: ['指定工作区', 'Specific workspace'],
            sessions: ['指定会话', 'Specific sessions'],
            off: ['关闭', 'Off'],
            allowlist: ['旧配置：白名单', 'legacy: allowlist'],
            qq: ['旧配置：仅 QQ', 'legacy: QQ only'],
            preset: ['旧配置：按预设', 'legacy: preset'],
            all: ['旧配置：全部', 'legacy: all'],
          };
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
            edit: ['改', 'Edit'],
            del: ['删', 'Delete'],
            saveEdit: ['保存修改', 'Save'],
            cancel: ['取消', 'Cancel'],
            reasonPh: ['删除理由（会留审计）', 'Reason (kept as audit)'],
            confirmDel: ['确认删除', 'Delete'],
            subtype: ['分类', 'Category'],
            editValue: ['事实内容', 'Fact value'],
            saved2: ['已更新', 'Updated'],
            deleted: ['已删除', 'Deleted'],
            weight: ['权重', 'weight'],
            hits: ['命中', 'hits'],
            err: ['出问题了：', 'Something broke: '],
            show: ['"展开', 'Show"'],
            hide: ['"收起', 'Hide"'],
            showAdvanced: ['"显示高级参数', 'Show advanced settings"'],
            ownerNow: ['"当前生效：', 'In effect: "'],
            ownerNone: ['"还没有人可以定规矩', 'Nobody can set rules yet"'],
            transfer: ['"导出与备份', 'Export and backup"'],
            transferHint: ['"导出配置包含设置、人设和规矩，可在另一个环境导入；导入只覆盖设置和规矩，不碰记忆库。备份是整库快照', 'Export carries settings, persona and rules to another environment; import only touches settings and rules. Backup is a full snapshot"'],
            exportConfig: ['"导出配置', 'Export config"'],
            backup: ['"备份数据库', 'Back up database"'],
            importPlaceholder: ['"把导出的配置 JSON 贴在这里', 'Paste an exported config JSON here"'],
            importPreview: ['"预览导入', 'Preview import"'],
            importApply: ['"确认导入', 'Apply import"'],
            planSettings: ['"将改动的设置', 'Settings to change"'],
            planRules: ['规矩 +新增 / ~更新', 'Rules +added / ~updated'],
            planAll: ['查看全部改动', 'Show every change'],
            planLess: ['收起', 'Collapse'],
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
            if (HostSwitch) return h(HostSwitch, { checked, label, onChange });
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

          function Field({ label, type, value, options, overridden, onChange, onClear, labels, hint, ownerInfo }) {
            const numeric = type === 'num';
            const control =
              type === 'sessions'
                ? h(SessionPickerInline, { value, onChange })
                : type === 'bool'
                ? h(Switch, { checked: value === true, onChange, label })
                : type === 'select'
                  ? h(
                      'select',
                      {
                        className: 'tide-input tide-select',
                        value: value ?? '',
                        onChange: (e) => onChange(e.target.value),
                      },
                      (options ?? []).map((opt) =>
                        h('option', { key: opt, value: opt }, labels?.[opt] ? L(labels[opt]) : t(SCOPE_LABELS[opt] ?? [opt, opt])),
                      ),
                    )
                  : h('input', {
                    className: 'tide-input',
                    type: 'text',
                    value: value ?? '',
                    placeholder: type === 'time' ? 'HH:MM' : undefined,
                    // 数字框也必须给字符串：空值转成 0 会静默改坏配置
                    onChange: (e) => onChange(numeric ? (e.target.value === '' ? '' : Number(e.target.value)) : e.target.value),
                  });
            return h(
              'div',
              { className: 'tide-row' },
              h(
                'div',
                { className: 'tide-row-text' },
                h('span', { className: 'tide-label' }, label),
                hint ? h('span', { className: 'tide-hint' }, L(hint)) : null,
                type === 'owner' && ownerInfo
                  ? h(
                      'span',
                      { className: 'tide-hint' },
                      ownerInfo.ids?.length
                        ? t(T.ownerNow) + ' ' + ownerInfo.ids.map((x) => String(x).slice(0, 8) + '…').join(', ') + ' · ' + t(OWNER_SOURCE[ownerInfo.reason] ?? ['', ''])
                        : t(T.ownerNone),
                    )
                  : null,
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

          // Field 里按类型渲染会话多选时用它（与下面的选择器同一个实现）
          const SessionPickerInline = (props) => h(SessionPicker, props);

          // 会话多选：读取最近会话，勾选即写入 scope.sessionIds
          function SessionPicker({ value, onChange }) {
            const [rows, setRows] = React.useState([]);
            const [loading, setLoading] = React.useState(true);
            const [manual, setManual] = React.useState(null);
            // 会话多了以后按标题、路径或 id 筛，找不到就是这里的问题
            const [filter, setFilter] = React.useState('');
            const selected = String(value ?? '')
              .split(',')
              .map((x) => x.trim())
              .filter(Boolean);

            React.useEffect(() => {
              let alive = true;
              getJson('/sessions?limit=60')
                .then((data) => alive && setRows(data.rows ?? []))
                .catch(() => alive && setRows([]))
                .finally(() => alive && setLoading(false));
              return () => {
                alive = false;
              };
            }, []);

            const toggle = (id) => {
              const next = selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id];
              onChange(next.join(','));
            };

            const needle = filter.trim().toLowerCase();
            const visible = needle
              ? rows.filter((r) =>
                  [r.title ?? '', r.cwd ?? '', r.id ?? ''].join(' ').toLowerCase().includes(needle),
                )
              : rows;
            const known = new Set(rows.map((r) => r.id));
            const orphan = selected.filter((id) => !known.has(id));

            return h(
              'div',
              { className: 'tide-sessions' },
              h('input', {
                className: 'tide-search',
                placeholder: '按标题、路径或 id 筛…',
                value: filter,
                onChange: (e) => setFilter(e.target.value),
              }),
              loading
                ? h('p', { className: 'tide-note' }, '读取会话…')
                : h(
                    'div',
                    { className: 'tide-session-list' },
                    ...(rows.length === 0 ? [h('p', { className: 'tide-note' }, '没有找到会话')] : []),
                    ...(visible.length === 0 ? [h('p', { className: 'tide-note' }, '没有匹配的会话')] : []),
                    ...visible.map((r) =>
                      h(
                        'label',
                        { key: r.id, className: 'tide-session' },
                        h('input', { type: 'checkbox', checked: selected.includes(r.id), onChange: () => toggle(r.id) }),
                        h(
                          'span',
                          { className: 'tide-session-text' },
                          h('span', { className: 'tide-session-title' }, r.title || r.cwd || r.id),
                          h('span', { className: 'tide-meta' }, (r.cwd ?? '') + ' · ' + r.id.slice(0, 18)),
                        ),
                      ),
                    ),
                    ...orphan.map((id) =>
                      h(
                        'label',
                        { key: id, className: 'tide-session' },
                        h('input', { type: 'checkbox', checked: true, onChange: () => toggle(id) }),
                        h('span', { className: 'tide-session-text' }, h('span', { className: 'tide-session-title' }, id)),
                      ),
                    ),
                  ),
              manual === null
                ? h(
                    'button',
                    { type: 'button', className: 'tide-link', onClick: () => setManual(String(value ?? '')) },
                    '手动编辑',
                  )
                : h(
                    'div',
                    null,
                    h('input', {
                      className: 'tide-input tide-input-wide',
                      type: 'text',
                      value: manual,
                      onChange: (e) => {
                        setManual(e.target.value);
                        onChange(e.target.value);
                      },
                    }),
                    h('button', { type: 'button', className: 'tide-link', onClick: () => setManual(null) }, '收起'),
                  ),
            );
          }

          function SettingsPage() {
            const [state, setState] = React.useState({ loading: true, error: null, groups: [], fields: [], values: {}, fieldMeta: {}, dirty: {}, saving: false, saved: false, showAdvanced: false, open: {}, ownerInfo: null });

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
              Promise.all([getJson('/settings'), getJson('/owner').catch(() => null)])
                .then(([data, owner]) => alive && setState((s) => ({ ...s, loading: false, ...apply(data), ownerInfo: owner, dirty: {} })))
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
              ...state.groups
                .filter((g) => !g.advanced || state.showAdvanced)
                .map((g) =>
                h(
                  'section',
                  { key: L(g.title), className: 'tide-card' },
                  h(
                    'h4',
                    { className: 'tide-card-title' },
                    L(g.title),
                    g.collapsible
                      ? h(
                          'button',
                          {
                            type: 'button',
                            className: 'tide-link',
                            onClick: () => setOpen((o) => ({ ...o, [L(g.title)]: !(o[L(g.title)] ?? g.defaultOpen) })),
                          },
                          ((state.open ?? {})[L(g.title)] ?? g.defaultOpen) ? t(T.hide) : t(T.show),
                        )
                      : null,
                  ),
                  g.hint ? h('p', { className: 'tide-card-hint' }, L(g.hint)) : null,
                  g.collapsible && !((state.open ?? {})[L(g.title)] ?? g.defaultOpen)
                    ? null
                    :
                  h(
                    'div',
                    { className: 'tide-rows' },
                    ...g.fields
                      .filter(([, , , , when]) => {
                        if (!when) return true;
                        const pairs = Array.isArray(when[0]) ? when : [when];
                        return pairs.every(([k, want]) => String(values[k]) === String(want));
                      })
                      .map(([key, label, type, options, when, opts]) =>
                        h(Field, {
                          key,
                          label: L(label),
                          type,
                          options,
                          labels: opts?.labels,
                          hint: opts?.hint,
                          ownerInfo: type === 'owner' ? state.ownerInfo : null,
                          value: values[key],
                          overridden: Boolean((fieldMeta[key] ?? {}).overridden),
                          onChange: (v) => setValue(key, v),
                          onClear: () => clearKey(key),
                        }),
                      ),
                  ),
                ),
              ),
              !state.showAdvanced
                ? h(
                    'button',
                    { type: 'button', className: 'tide-link tide-advanced', onClick: () => setState((s) => ({ ...s, showAdvanced: true })) },
                    t(T.showAdvanced),
                  )
                : null,
              h(Browse, null),
              h(Transfer, null),
              h(
                'footer',
                { className: 'tide-foot' },
                state.saved ? h('span', { className: 'tide-ok' }, t(T.saved)) : null,
                h('span', { className: 'tide-note' }, t(T.note)),
              ),
              h('p', { className: 'tide-note' }, t(T.firstRun)),
            );
          }

          // 导出、导入、整库备份。导入只在预览确认后落库，且只碰设置和规矩。
          function Transfer() {
            const [busy, setBusy] = React.useState('');
            const [error, setError] = React.useState('');
            const [plan, setPlan] = React.useState(null);
            const [text, setText] = React.useState('');
            const [showAllPlan, setShowAllPlan] = React.useState(false);

            const download = (path, name) => {
              const a = document.createElement('a');
              a.href = BASE + path;
              a.download = name || '';
              document.body.appendChild(a);
              a.click();
              a.remove();
            };

            const preview = async () => {
              setError('');
              setPlan(null);
              setBusy('preview');
              try {
                const cfg = JSON.parse(text);
                const data = await postJson('/import/preview', { config: cfg });
                setPlan({ preview: data, config: cfg });
              } catch (err) {
                setError(String(err.message ?? err));
              } finally {
                setBusy('');
              }
            };

            const applyPlan = async () => {
              if (!plan) return;
              setError('');
              setBusy('apply');
              try {
                await postJson('/import/apply', { config: plan.config });
                setPlan(null);
                setText('');
              } catch (err) {
                setError(String(err.message ?? err));
              } finally {
                setBusy('');
              }
            };

            return h(
              'section',
              { className: 'tide-card' },
              h('h4', { className: 'tide-card-title' }, t(T.transfer)),
              h('p', { className: 'tide-card-hint' }, t(T.transferHint)),
              h(
                'div',
                { className: 'tide-actions' },
                h('button', { type: 'button', className: 'tide-secondary', onClick: () => download('/export/config', 'tide-config.json') }, t(T.exportConfig)),
                h(
                  'button',
                  { type: 'button', className: 'tide-secondary', disabled: busy === 'backup', onClick: () => download('/export/backup') },
                  busy === 'backup' ? t(T.saving) : t(T.backup),
                ),
              ),
              h('textarea', {
                className: 'tide-textarea',
                placeholder: t(T.importPlaceholder),
                value: text,
                onChange: (e) => setText(e.target.value),
              }),
              h(
                'div',
                { className: 'tide-actions' },
                h('button', { type: 'button', className: 'tide-secondary', disabled: !text.trim() || busy === 'preview', onClick: preview }, t(T.importPreview)),
                plan ? h('button', { type: 'button', className: 'tide-primary', disabled: busy === 'apply', onClick: applyPlan }, t(T.importApply)) : null,
              ),
              plan
                ? h(
                    'div',
                    { className: 'tide-plan' },
                    h('p', null, t(T.planSettings) + ': ' + plan.preview.settings.length),
                    ...plan.preview.settings
                      .slice(0, showAllPlan ? plan.preview.settings.length : 8)
                      .map((it) =>
                        h('p', { key: it.key, className: 'tide-note' }, it.key + ': ' + String(it.from) + ' → ' + String(it.to)),
                      ),
                    plan.preview.settings.length > 8
                      ? h(
                          'button',
                          { type: 'button', className: 'tide-link', onClick: () => setShowAllPlan(!showAllPlan) },
                          showAllPlan ? t(T.planLess) : t(T.planAll),
                        )
                      : null,
                    h(
                      'p',
                      null,
                      t(T.planRules) + ': +' + plan.preview.rules.added.length + ' / ~' + plan.preview.rules.updated.length,
                    ),
                    ...[...plan.preview.rules.added.map((r) => ({ tag: '+', r })), ...plan.preview.rules.updated.map((r) => ({ tag: '~', r }))]
                      .slice(0, showAllPlan ? undefined : 8)
                      .map(({ tag, r }) =>
                        h('p', { key: tag + r.key, className: 'tide-note' }, tag + ' ' + r.key + ' (' + (r.appliesTo ?? 'any') + '): ' + String(r.value).slice(0, 80)),
                      ),
                  )
                : null,
              error ? h('p', { className: 'tide-error' }, t(T.err) + error) : null,
            );
          }

          function Browse() {
            const [tab, setTab] = React.useState('facts');
            const [state, setState] = React.useState({ loading: true, rows: [] });
            const [q, setQ] = React.useState('');
            // 行内编辑：editing = { id, value, subtype }；deleting = { id, reason }
            const [editing, setEditing] = React.useState(null);
            const [deleting, setDeleting] = React.useState(null);
            const [notice, setNotice] = React.useState('');

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

            async function saveFactEdit() {
              if (!editing) return;
              try {
                await postJson('/facts/edit', { factId: editing.id, value: editing.value, subtype: editing.subtype });
                setEditing(null);
                setNotice(t(T.saved2));
                await load();
              } catch (err) {
                setNotice(t(T.err) + String(err.message ?? err));
              }
            }

            async function confirmFactDelete() {
              if (!deleting) return;
              try {
                await postJson('/facts/delete', { factId: deleting.id, reason: deleting.reason });
                setDeleting(null);
                setNotice(t(T.deleted));
                await load();
              } catch (err) {
                setNotice(t(T.err) + String(err.message ?? err));
              }
            }

            async function confirmEventDelete() {
              if (!deleting) return;
              try {
                await postJson('/events/delete', { eventId: deleting.id, reason: deleting.reason });
                setDeleting(null);
                setNotice(t(T.deleted));
                await load();
              } catch (err) {
                setNotice(t(T.err) + String(err.message ?? err));
              }
            }

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
              notice ? h('p', { className: 'tide-ok' }, notice) : null,
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
                                  h(
                                    'div',
                                    { className: 'tide-item-head' },
                                    h('code', null, r.key),
                                    h('span', { className: 'tide-meta' }, r.subtype + (r.scope ? ' · ' + r.scope : '')),
                                    h(
                                      'span',
                                      { className: 'tide-acts' },
                                      h(
                                        'button',
                                        {
                                          type: 'button',
                                          className: 'tide-link',
                                          onClick: () =>
                                            setEditing(
                                              editing && editing.id === r.factId
                                                ? null
                                                : { id: r.factId, value: String(r.value ?? ''), subtype: r.subtype },
                                            ),
                                        },
                                        t(T.edit),
                                      ),
                                      h(
                                        'button',
                                        {
                                          type: 'button',
                                          className: 'tide-link',
                                          onClick: () => setDeleting(deleting && deleting.id === r.factId ? null : { id: r.factId, reason: '' }),
                                        },
                                        t(T.del),
                                      ),
                                    ),
                                  ),
                                  editing && editing.id === r.factId
                                    ? h(
                                        'div',
                                        { className: 'tide-editor' },
                                        h('textarea', {
                                          className: 'tide-textarea',
                                          value: editing.value,
                                          onChange: (e) => setEditing({ ...editing, value: e.target.value }),
                                        }),
                                        h(
                                          'select',
                                          {
                                            className: 'tide-select',
                                            value: editing.subtype,
                                            onChange: (e) => setEditing({ ...editing, subtype: e.target.value }),
                                          },
                                          ...['profile', 'preference', 'todo', 'rule', 'relation', 'self'].map((v) =>
                                            h('option', { key: v, value: v }, v),
                                          ),
                                        ),
                                        h(
                                          'span',
                                          { className: 'tide-acts' },
                                          h('button', { type: 'button', className: 'tide-primary', onClick: saveFactEdit }, t(T.saveEdit)),
                                          h('button', { type: 'button', className: 'tide-link', onClick: () => setEditing(null) }, t(T.cancel)),
                                        ),
                                      )
                                    : h('div', { className: 'tide-value' }, String(r.value ?? '').slice(0, 140)),
                                  deleting && deleting.id === r.factId
                                    ? h(
                                        'div',
                                        { className: 'tide-editor' },
                                        h('input', {
                                          className: 'tide-textarea',
                                          placeholder: t(T.reasonPh),
                                          value: deleting.reason,
                                          onChange: (e) => setDeleting({ ...deleting, reason: e.target.value }),
                                        }),
                                        h(
                                          'span',
                                          { className: 'tide-acts' },
                                          h('button', { type: 'button', className: 'tide-danger', onClick: confirmFactDelete }, t(T.confirmDel)),
                                          h('button', { type: 'button', className: 'tide-link', onClick: () => setDeleting(null) }, t(T.cancel)),
                                        ),
                                      )
                                    : null,
                                )
                              : tab === 'events'
                                ? h(
                                    F,
                                    null,
                                    h(
                                      'div',
                                      { className: 'tide-item-head' },
                                      h('span', { className: 'tide-meta' }, (r.speaker ? r.speaker + ' · ' : '') + (r.scope ?? '')),
                                      h(
                                        'span',
                                        { className: 'tide-acts' },
                                        h(
                                          'button',
                                          {
                                            type: 'button',
                                            className: 'tide-link',
                                            onClick: () => setDeleting(deleting && deleting.id === r.eventId ? null : { id: r.eventId, reason: '' }),
                                          },
                                          t(T.del),
                                        ),
                                      ),
                                    ),
                                    h('div', { className: 'tide-value' }, String(r.content ?? '').slice(0, 140)),
                                    deleting && deleting.id === r.eventId
                                      ? h(
                                          'div',
                                          { className: 'tide-editor' },
                                          h('input', {
                                            className: 'tide-textarea',
                                            placeholder: t(T.reasonPh),
                                            value: deleting.reason,
                                            onChange: (e) => setDeleting({ ...deleting, reason: e.target.value }),
                                          }),
                                          h(
                                            'span',
                                            { className: 'tide-acts' },
                                            h('button', { type: 'button', className: 'tide-danger', onClick: confirmEventDelete }, t(T.confirmDel)),
                                            h('button', { type: 'button', className: 'tide-link', onClick: () => setDeleting(null) }, t(T.cancel)),
                                          ),
                                        )
                                      : null,
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
              const ago = (ms) => {
                if (!ms) return '—';
                const d = Date.now() - ms;
                if (d < 60_000) return '刚刚';
                if (d < 3_600_000) return Math.floor(d / 60_000) + ' 分钟前';
                if (d < 86_400_000) return Math.floor(d / 3_600_000) + ' 小时前';
                return Math.floor(d / 86_400_000) + ' 天前';
              };
              getJson('/overview')
                .then((d) => {
                  if (!alive) return;
                  const head = `${t(T.facts)} ${d.facts} · ${t(T.events)} ${d.events} · ${t(T.attention)} ${d.attention}`;
                  // 这两个时间是判断「到底有没有在跑」的唯一凭据
                  const live = `入库 ${ago(d.lastIngestAt)} · 注入 ${ago(d.lastInjectAt)}`;
                  setText(head + ' · ' + live);
                })
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
                .tide-primary{padding:5px 14px;border-radius:8px;border:1px solid transparent;background:var(--dsw-alias-brand-primary,#2563eb);color:var(--dsw-alias-bg-base,#fff);font-size:12px;cursor:pointer}
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
                .tide-select{text-align:left;width:140px}
                .tide-switch{width:34px;height:20px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.35));background:var(--dsw-alias-bg-layer-2,transparent);position:relative;cursor:pointer;padding:0;transition:background .15s,border-color .15s}
                .tide-switch.on{background:var(--dsw-alias-brand-primary,#3b82f6);border-color:transparent}
                .tide-knob{position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:#fff;transition:transform .15s}
                .tide-switch.on .tide-knob{transform:translateX(14px)}
                .tide-tag{display:inline-flex;align-items:center;gap:6px;font-size:11px;color:var(--dsw-alias-brand-primary,#3b82f6)}
                .tide-acts{display:inline-flex;gap:8px;margin-left:auto}
                .tide-editor{display:flex;flex-direction:column;gap:6px;margin-top:6px}
                .tide-textarea{width:100%;min-height:52px;font:inherit;font-size:12px;padding:6px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.25));background:var(--dsw-alias-bg-layer-2,transparent);color:inherit}
                .tide-select{font:inherit;font-size:12px;padding:4px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.25));background:var(--dsw-alias-bg-layer-2,transparent);color:inherit}
                .tide-danger{padding:4px 10px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1,rgba(200,60,60,.5));background:transparent;color:var(--dsw-alias-label-error,#c0392b);font-size:12px;cursor:pointer}
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
                .tide-sessions{display:flex;flex-direction:column;gap:6px;margin-top:4px}
                .tide-session-list{display:flex;flex-direction:column;gap:2px;max-height:220px;overflow:auto}
                .tide-session{display:flex;align-items:flex-start;gap:8px;padding:3px 0;cursor:pointer}
                .tide-session-text{display:flex;flex-direction:column;gap:1px;min-width:0}
                .tide-session-title{font-size:12px}
                .tide-row-block{flex-direction:column;align-items:stretch}
                .tide-input-wide{width:100%;text-align:left;margin:4px 0}
                .tide-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px}
                .tide-secondary{padding:4px 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.3));background:transparent;color:inherit;font-size:12px;cursor:pointer}
                .tide-secondary:hover{border-color:var(--dsw-alias-brand-primary,#3b82f6)}
                .tide-secondary:disabled{opacity:.4;cursor:default}
                .tide-hint{font-size:11px;color:var(--dsw-alias-label-tertiary,rgba(127,127,127,.75))}
                .tide-plan{margin-top:8px;padding-top:8px;border-top:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.12));font-size:12px}
                .tide-advanced{align-self:flex-start;margin-top:4px}
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
