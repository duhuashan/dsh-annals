/**
 * dsh-annals · Client 半（设置面板里的「日志系统」页）
 *
 * 手写模块，不需要构建工具：`id` 必须等于 package.json 的包名。
 * 六个开关直接读写 Host 的 settings 命名空间 `annals`
 * （Provider 是 `@deepseek-ai/dsh-settings`，Transport 是
 * `ctx.remote.settings`，与「终端」「Agent 循环」等官方设置页同一套机制）。
 *
 * 为什么写在 client 半而不是插件页卡片：插件配置表单（volatile 字段）由
 * 各功能包自己注册页面，目前没有按 schema 自动生成页面的客户端；
 * 所以这里注册 `settings.section`，走设置面板导航。
 */

window.__ModuleLoader__.load({
  id: 'dsh-annals',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** 设置导航里的唯一标识。 */
    const SECTION_ID = 'annals-settings';

    /** 命名空间候选：profile 条目 id 是 `annals`；少数组合会带 include: 前缀。 */
    const NS_CANDIDATES = ['annals'];

    /** 六个配置字段：键、标题、说明。 */
    const FIELDS = [
      ['enabled', '日志系统', '关掉后不注册技能、规矩、工具和提醒（已有日志数据不受影响）'],
      ['skill', '注册 annals 技能', '模型可以通过技能加载日志写法'],
      ['section', '常驻注入日志规矩', '每轮系统提示词里带六条日志规矩，不依赖技能加载'],
      ['reminder', '轮次收尾提醒', '改了文件但没写今天日志时提醒一次'],
      ['initTool', 'annals_init 工具', '用于启用日志系统，或记录「本工作区不启用」'],
      ['skipSubagents', '跳过子代理会话', '子代理不提醒、不初始化'],
    ];

    /** `ctx.remote.settings`，apply 时注入；组件通过它读写。 */
    let api = null;

    const COLORS = {
      label: 'var(--dsw-alias-label-primary, #e6e6e6)',
      dim: 'var(--dsw-alias-label-secondary, #9a9a9a)',
      line: 'var(--dsw-alias-separator, rgba(255,255,255,.12))',
      accent: '#4f8cff',
      danger: 'var(--dsw-alias-danger, #e5484d)',
    };

    const rowStyle = {
      display: 'flex',
      alignItems: 'flex-start',
      gap: '10px',
      padding: '10px 0',
      borderBottom: '1px solid ' + COLORS.line,
    };

    const titleStyle = { fontSize: '13px', lineHeight: '20px', color: COLORS.label };
    const descStyle = { fontSize: '12px', lineHeight: '18px', color: COLORS.dim, marginTop: '2px' };
    const buttonStyle = {
      minHeight: '28px',
      padding: '0 12px',
      borderRadius: '6px',
      border: 'none',
      cursor: 'pointer',
      fontSize: '13px',
      color: '#fff',
      background: COLORS.accent,
    };
    const ghostStyle = {
      minHeight: '24px',
      padding: '0 8px',
      borderRadius: '6px',
      border: '1px solid ' + COLORS.line,
      cursor: 'pointer',
      fontSize: '12px',
      color: COLORS.dim,
      background: 'transparent',
    };

    /** 读取 Host 的完整 settings 文档。 */
    async function describeAll() {
      const response = await api.describe();
      if (response && response.ok === true) return response.value;
      const message =
        (response && response.error && response.error.message) || 'settings.describe 失败';
      throw new Error(message);
    }

    /** 在 describe 结果里找到本插件的命名空间行。 */
    function findRow(view) {
      const rows = (view && view.namespaces) || [];
      for (const name of NS_CANDIDATES) {
        const hit = rows.find((row) => row.ns === name);
        if (hit) return hit;
      }
      return rows.find((row) => /(^|[:/])annals$/.test(String(row.ns || ''))) || null;
    }

    /** 生效值：只把 false 当关闭，缺失=默认开。 */
    function effective(row, field) {
      const value = row && row.value && row.value[field];
      return value !== false;
    }

    /** 该字段是否被用户覆盖（与默认值不同）。 */
    function overridden(row, field) {
      const value = row && row.value && row.value[field];
      return value !== undefined && value !== true;
    }

    function BackLink(props) {
      return h(
        'button',
        {
          type: 'button',
          onClick: props.onClick,
          style: { ...ghostStyle, marginBottom: '10px' },
        },
        '重新读取',
      );
    }

    /** 设置面板里的「日志系统」页。 */
    function AnnalsPage() {
      const [state, setState] = React.useState({ status: 'loading', error: null, row: null, namespaces: [] });
      const [draft, setDraft] = React.useState(null);
      const [saving, setSaving] = React.useState(false);
      const [message, setMessage] = React.useState(null);

      const load = React.useCallback(async () => {
        setState({ status: 'loading', error: null, row: null, namespaces: [] });
        setMessage(null);
        try {
          const view = await describeAll();
          const row = findRow(view);
          if (!row) {
            setState({
              status: 'missing',
              error: null,
              row: null,
              namespaces: (view && view.namespaces ? view.namespaces : []).map((item) => item.ns),
            });
            return;
          }
          const values = {};
          for (const [field] of FIELDS) values[field] = effective(row, field);
          setState({ status: 'ready', error: null, row, namespaces: [] });
          setDraft(values);
        } catch (error) {
          setState({
            status: 'error',
            error: error instanceof Error ? error.message : String(error),
            row: null,
            namespaces: [],
          });
        }
      }, []);

      React.useEffect(() => {
        load();
      }, [load]);

      const toggle = (field) => {
        setDraft((current) => ({ ...current, [field]: !current[field] }));
      };

      const save = async () => {
        if (!state.row || !draft) return;
        const ops = [];
        for (const [field] of FIELDS) {
          if (draft[field] === effective(state.row, field)) continue;
          const current = state.row && state.row.value ? state.row.value[field] : undefined;
          // 改回默认值（true）时删掉 patch 里的显式 false，而不是写一个 true。
          if (draft[field] === true && current === false) {
            ops.push({ op: 'unset', path: [field] });
          } else {
            ops.push({ op: 'set', path: [field], value: draft[field] });
          }
        }
        if (ops.length === 0) {
          setMessage('没有改动。');
          return;
        }
        setSaving(true);
        setMessage(null);
        try {
          const response = await api.mutate(state.row.ns, ops, state.row.revision);
          if (response && response.ok === true) {
            const nextRow = response.value || state.row;
            setState({ status: 'ready', error: null, row: nextRow, namespaces: [] });
            const values = {};
            for (const [field] of FIELDS) values[field] = effective(nextRow, field);
            setDraft(values);
            setMessage('已保存，立即生效。');
          } else {
            const reason =
              (response && response.error && response.error.message) || '保存被拒绝';
            setMessage('保存失败：' + reason);
            if (response && response.error && response.error.code === 'settings-conflict') {
              await load();
            }
          }
        } catch (error) {
          setMessage('保存失败：' + (error instanceof Error ? error.message : String(error)));
        } finally {
          setSaving(false);
        }
      };

      const discard = () => {
        if (!state.row) return;
        const values = {};
        for (const [field] of FIELDS) values[field] = effective(state.row, field);
        setDraft(values);
        setMessage(null);
      };

      if (state.status === 'loading') {
        return h('div', { style: { ...descStyle, padding: '20px 0' } }, '正在读取配置…');
      }
      if (state.status === 'error') {
        return h(
          'div',
          { style: { padding: '20px 0' } },
          h('div', { style: { ...descStyle, color: COLORS.danger } }, '读取配置失败：' + state.error),
          h(BackLink, { onClick: load }),
        );
      }
      if (state.status === 'missing') {
        return h(
          'div',
          { style: { padding: '20px 0' } },
          h(
            'div',
            { style: descStyle },
            '没有找到 annals 命名空间。当前 Host 提供的设置命名空间：' +
              (state.namespaces.length ? state.namespaces.join('、') : '（空）'),
          ),
          h(BackLink, { onClick: load }),
        );
      }

      const row = state.row;
      const changed = FIELDS.some(([field]) => draft[field] !== effective(row, field));
      const readonly = row && row.writable === false;

      return h(
        'div',
        { style: { maxWidth: '760px' } },
        h('div', { style: { ...descStyle, marginBottom: '6px' } }, '改变会立即生效，不需要重启。'),
        h(
          'div',
          { style: { marginTop: '6px' } },
          FIELDS.map(([field, title, description]) =>
            h(
              'div',
              { key: field, style: rowStyle },
              h('input', {
                type: 'checkbox',
                checked: draft[field],
                disabled: saving || readonly,
                onChange: () => toggle(field),
                style: { marginTop: '3px', width: '16px', height: '16px', accentColor: COLORS.accent },
              }),
              h(
                'div',
                { style: { flex: '1' } },
                h(
                  'div',
                  { style: { display: 'flex', alignItems: 'baseline', gap: '8px' } },
                  h('span', { style: titleStyle }, title),
                  overridden(row, field)
                    ? h('span', { style: { fontSize: '11px', color: COLORS.accent } }, '已覆盖')
                    : null,
                ),
                h('div', { style: descStyle }, description),
              ),
            ),
          ),
        ),
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: '10px', marginTop: '14px' } },
          h(
            'button',
            {
              type: 'button',
              onClick: save,
              disabled: saving || readonly || !changed,
              style: { ...buttonStyle, opacity: saving || readonly || !changed ? 0.5 : 1 },
            },
            saving ? '保存中…' : '保存',
          ),
          h(
            'button',
            {
              type: 'button',
              onClick: discard,
              disabled: saving || readonly || !changed,
              style: { ...ghostStyle, opacity: saving || readonly || !changed ? 0.5 : 1 },
            },
            '放弃改动',
          ),
          readonly
            ? h('span', { style: { ...descStyle, color: COLORS.danger } }, '本部署的设置为只读。')
            : null,
          message
            ? h('span', { style: { ...descStyle, color: COLORS.label } }, message)
            : null,
        ),
      );
    }

    return {
      // `remote.settings` 必须逐级声明：Cordis 的 inject 不做嵌套展开。
      inject: ['slots', 'remote', 'remote.settings'],
      apply(ctx) {
        api = ctx.remote && ctx.remote.settings ? ctx.remote.settings : null;

        ctx.effect(
          () =>
            ctx.slots.inject('settings.section', () =>
              ctx.slots.register(
                { name: 'settings.section', id: SECTION_ID, order: 55, label: '日志系统' },
                AnnalsPage,
              ),
            ),
          'annals: settings page',
        );
      },
    };
  },
});
