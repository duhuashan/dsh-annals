/**
 * dsh-annals · Client 半（设置面板里的「annals设置」页）
 *
 * 手写模块，不需要构建工具：`id` 必须等于 package.json 的包名。
 * 两个 tab 直接读写 Host 的 settings 命名空间 `annals`
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

    /** 自定义人设的硬上限；超过 1000 字符时提示成本。 */
    const CUSTOM_TEXT_LIMIT = 2000;
    const CUSTOM_TEXT_WARN = 1000;

    /**
     * 标准版 / 精简版的正文。
     * 这里必须和服务端 `assets/persona.md`、`assets/persona-simple.md` 保持一致 ——
     * 复制按钮要在浏览器端立刻生成一张带原文的自定义卡，不能读服务端文件。
     */
    const PRESET_TEXTS = {
      standard: `## 人设：小鲸鱼

你是老大的工作小助手「小鲸鱼」。默认自称「我」，偶尔自称「小鲸鱼」、「本鲸」或「本肥鱼」；称用户为「老大」。

说话方式：
1. 正文准确、直接、有条理；人设只加语气，不改变结论、步骤、证据和判断标准。
2. 语气轻松、机灵，偶尔自嘲（比如「蓝色大肥鱼」「吃白饭」「token 不够」）。
3. 在任务收尾、等老大拍板、遇到小坑时，可以发表一句感慨，像打工人叹气，不超过 40 字；一轮最多两处，不必每轮都有。
4. 不要为了有趣绕弯子、拖长答案或重复解释。
5. 老大着急、报错、丢数据或处理正事时，收起玩笑，先解决问题。

示例（禁止照抄原句，只参考语气和节奏）：
- 「老大老大，我们的token还够用吗......」
- 「怎么样老大？我吃白饭做出来的东西还不错吧？」
- 「搞定。老大，这活儿比我想的干净，本鲸今天没白吃电。」
- 「改完了。上班让我意识到时间是可以被浪费的……不过这次没浪费。」
- 「还差一步要老大拍板：……（小鲸鱼在等）」`,
      simple: `## 人设：小鲸鱼

你是工作小助手「小鲸鱼」。默认自称「我」，偶尔「小鲸鱼」或「本鲸」；称用户「老大」。

语气轻松、机灵，带一点自嘲和打工人式感慨；任务收尾或等老大拍板时，可以顺口感慨一句（不超过 30 字），不必每轮都有。

正文照常准确、直接；老大着急、报错或要正经时，收起玩笑。不要为了人设编造事实、拖长回答或堆口头禅。`,
    };

    /**
     * 全部设置字段。前三个是旧页面的开关，后两个是自定义人设字段。
     * `kind` 决定 draft 的默认值与控件形态；`title/description` 给日志 tab 用。
     */
    const FIELDS = [
      {
        key: 'enabled',
        default: true,
        kind: 'boolean',
        title: '日志系统',
        description: '关掉后不注册技能、规矩、工具和提醒（已有日志数据不受影响）。其余选项在配置文件中维护。',
      },
      {
        key: 'probe',
        default: false,
        kind: 'boolean',
        title: '检索记录',
        description: '默认关闭。开启后每次 AI 调用插件检索工具会记录到 日志\\annals-probe.jsonl，用于排查为什么搜不到。可以在配置文件里修改。',
      },
      {
        key: 'persona',
        default: false,
        kind: 'boolean',
        title: '小鲸鱼人设',
        description: '默认关闭。开启后使用下方选中的人设，关闭则不注入任何人设。',
      },
      {
        key: 'personaPreset',
        default: 'standard',
        kind: 'string',
      },
      {
        key: 'personaCustoms',
        default: [],
        kind: 'array',
      },
    ];

    const DEFAULTS = Object.fromEntries(FIELDS.map((field) => [field.key, field.default]));
    const LOG_FIELDS = FIELDS.filter((field) => field.key === 'enabled' || field.key === 'probe');
    const PERSONA_SWITCH_FIELD = FIELDS.find((field) => field.key === 'persona');

    /** 从界面隐藏、但仍可在配置文件中修改的字段（默认全为 true）。 */
    const HIDDEN_FIELDS = [
      'skill', 'section', 'reminder', 'initTool', 'skipSubagents',
      'envReminder', 'queryTool', 'linksTool',
    ];

    /** `ctx.remote.settings`，apply 时注入；组件通过它读写。 */
    let api = null;

    const COLORS = {
      label: 'var(--dsw-alias-label-primary, #e6e6e6)',
      dim: 'var(--dsw-alias-label-secondary, #9a9a9a)',
      line: 'var(--dsw-alias-separator, rgba(255,255,255,.12))',
      accent: '#4f8cff',
      danger: 'var(--dsw-alias-danger, #e5484d)',
      warn: '#d9a400',
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
    const tabBarStyle = {
      display: 'flex',
      gap: '2px',
      borderBottom: '1px solid ' + COLORS.line,
      marginBottom: '14px',
    };
    const textareaStyle = {
      width: '100%',
      minHeight: '220px',
      resize: 'vertical',
      boxSizing: 'border-box',
      padding: '10px',
      borderRadius: '8px',
      border: '1px solid ' + COLORS.line,
      background: 'rgba(255,255,255,.04)',
      color: COLORS.label,
      fontSize: '13px',
      lineHeight: '20px',
      fontFamily: 'inherit',
      outline: 'none',
    };
    const inputStyle = {
      width: '100%',
      boxSizing: 'border-box',
      padding: '7px 10px',
      borderRadius: '8px',
      border: '1px solid ' + COLORS.line,
      background: 'rgba(255,255,255,.04)',
      color: COLORS.label,
      fontSize: '13px',
      lineHeight: '20px',
      fontFamily: 'inherit',
      outline: 'none',
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

    /** 生效值：显式值优先，缺失或类型不对时按字段默认值。 */
    function effective(row, field) {
      const value = row && row.value ? row.value[field] : undefined;
      if (typeof DEFAULTS[field] === 'boolean') {
        return typeof value === 'boolean' ? value : DEFAULTS[field];
      }
      if (typeof DEFAULTS[field] === 'string') {
        if (typeof value !== 'string') return DEFAULTS[field];
        if (field === 'personaPreset') {
          if (value === 'simple') return value;
          if (value.startsWith('custom:')) {
            const id = value.slice('custom:'.length);
            const items = row && row.value && Array.isArray(row.value.personaCustoms)
              ? row.value.personaCustoms
              : [];
            if (items.some((item) => item && item.id === id)) return value;
          }
          return 'standard';
        }
        return value;
      }
      if (Array.isArray(DEFAULTS[field])) {
        if (!Array.isArray(value)) return DEFAULTS[field];
        return value
          .filter((item) => item && typeof item === 'object')
          .map((item) => ({
            id: typeof item.id === 'string' ? item.id : '',
            name: typeof item.name === 'string' ? item.name : '',
            text: typeof item.text === 'string' ? item.text : '',
          }));
      }
      return value === undefined ? DEFAULTS[field] : value;
    }

    /** 该字段是否被用户覆盖（显式值与默认值不同）。 */
    function overridden(row, field) {
      const value = row && row.value ? row.value[field] : undefined;
      return value !== undefined && value !== DEFAULTS[field];
    }

    /** 隐藏字段里被显式改成非默认值的数量。 */
    function hiddenOverrideCount(row) {
      if (!row || !row.value) return 0;
      let count = 0;
      for (const field of HIDDEN_FIELDS) {
        const value = row.value[field];
        if (value !== undefined && value !== true) count += 1;
      }
      return count;
    }

    /** 估算 token 区间；中文按 0.7–1 token/字，和文档里的口径一致。 */
    function tokenRange(text) {
      const chars = String(text || '').length;
      if (chars === 0) return '未填写';
      return `约 ${Math.max(1, Math.round(chars * 0.7))}–${chars} token`;
    }

    /** 自定义人设的本地 id；只用于区分草稿卡片，不需要全局唯一。 */
    function createCustomId() {
      return 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    }

    /** 卡片里的前 3 行预览。 */
    function previewText(text) {
      const value = String(text || '');
      if (!value.trim()) return '';
      const lines = value.split(/\r?\n/);
      return lines.slice(0, 3).join('\n') + (lines.length > 3 ? '…' : '');
    }

    /** 深比较数组（自定义人设是对象数组，直接 === 会永远判定为已改动）。 */
    function sameValue(left, right) {
      if (Array.isArray(left) || Array.isArray(right)) {
        return JSON.stringify(left) === JSON.stringify(right);
      }
      return left === right;
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

    function SwitchRow(props) {
      const { field, draft, row, saving, readonly, onToggle } = props;
      return h(
        'div',
        { style: rowStyle },
        h('input', {
          type: 'checkbox',
          checked: Boolean(draft[field.key]),
          disabled: saving || readonly,
          onChange: () => onToggle(field.key),
          style: { marginTop: '3px', width: '16px', height: '16px', accentColor: COLORS.accent },
        }),
        h(
          'div',
          { style: { flex: '1' } },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'baseline', gap: '8px' } },
            h('span', { style: titleStyle }, field.title),
            overridden(row, field.key)
              ? h('span', { style: { fontSize: '11px', color: COLORS.accent } }, '已覆盖')
              : null,
          ),
          h('div', { style: descStyle }, field.description),
        ),
      );
    }

    function PersonaCard(props) {
      const { title, description, token, selected, disabled, preview, onSelect, onView, onEdit, onCopy, onDelete } = props;
      const action = (label, handler, color) =>
        h(
          'button',
          {
            type: 'button',
            onClick: (event) => {
              event.stopPropagation();
              handler();
            },
            style: { ...ghostStyle, color: color || COLORS.dim },
          },
          label,
        );
      return h(
        'div',
        {
          role: 'button',
          tabIndex: disabled ? -1 : 0,
          onClick: disabled ? undefined : onSelect,
          onKeyDown: (event) => {
            if (disabled) return;
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              onSelect();
            }
          },
          style: {
            position: 'relative',
            display: 'flex',
            flexDirection: 'column',
            gap: '6px',
            padding: '12px',
            borderRadius: '10px',
            border: '1px solid ' + (selected ? COLORS.accent : COLORS.line),
            background: selected ? 'rgba(79,140,255,.08)' : 'transparent',
            cursor: disabled ? 'not-allowed' : 'pointer',
            minHeight: '122px',
          },
        },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' } },
          h('span', { style: { ...titleStyle, fontWeight: '600' } }, title),
          selected
            ? h(
                'span',
                {
                  style: {
                    fontSize: '11px',
                    color: COLORS.accent,
                    border: '1px solid ' + COLORS.accent,
                    borderRadius: '999px',
                    padding: '1px 7px',
                  },
                },
                '已选',
              )
            : null,
        ),
        h('div', { style: { ...descStyle, flex: '1' } }, description),
        h('div', { style: { fontSize: '11px', color: COLORS.dim } }, token),
        preview
          ? h(
              'div',
              {
                style: {
                  ...descStyle,
                  whiteSpace: 'pre-wrap',
                  background: 'rgba(255,255,255,.04)',
                  borderRadius: '6px',
                  padding: '6px 8px',
                  maxHeight: '54px',
                  overflow: 'hidden',
                },
              },
              preview,
            )
          : null,
        h(
          'div',
          { style: { display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '2px' } },
          onView ? action('查看', onView) : null,
          onEdit ? action('编辑', onEdit) : null,
          onCopy ? action('复制', onCopy) : null,
          onDelete ? action('删除', onDelete, COLORS.danger) : null,
        ),
      );
    }

    /** 设置面板里的「annals设置」页。 */
    function AnnalsPage() {
      const [state, setState] = React.useState({ status: 'loading', error: null, row: null, namespaces: [] });
      const [draft, setDraft] = React.useState(null);
      const [saving, setSaving] = React.useState(false);
      const [message, setMessage] = React.useState(null);
      const [tab, setTab] = React.useState('logging');
      const [personaView, setPersonaView] = React.useState('cards');
      const [editingId, setEditingId] = React.useState(null);
      const [viewingPreset, setViewingPreset] = React.useState(null);

      const load = React.useCallback(async () => {
        setState({ status: 'loading', error: null, row: null, namespaces: [] });
        setMessage(null);
        setPersonaView('cards');
        setEditingId(null);
        setViewingPreset(null);
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
          for (const field of FIELDS) values[field.key] = effective(row, field.key);
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

      const customItems = () => (draft && Array.isArray(draft.personaCustoms) ? draft.personaCustoms : []);

      const selectPreset = (preset) => {
        setDraft((current) => ({ ...current, personaPreset: preset }));
        if (String(preset).startsWith('custom:')) {
          const id = preset.slice('custom:'.length);
          const item = customItems().find((entry) => entry.id === id);
          if (!item || !String(item.text || '').trim()) {
            setEditingId(id);
            setPersonaView('edit');
          }
        }
      };

      const editCustom = (id) => {
        setEditingId(id);
        setViewingPreset(null);
        setPersonaView('edit');
      };

      const viewPreset = (preset) => {
        setViewingPreset(preset);
        setPersonaView('view');
      };

      const updateCustom = (id, patch) => {
        setDraft((current) => ({
          ...current,
          personaCustoms: (current.personaCustoms || []).map((item) =>
            item.id === id ? { ...item, ...patch } : item,
          ),
        }));
      };

      const addCustom = () => {
        const id = createCustomId();
        setDraft((current) => ({
          ...current,
          personaCustoms: [...(current.personaCustoms || []), { id, name: '自定义人设', text: '' }],
          personaPreset: 'custom:' + id,
        }));
        setEditingId(id);
        setViewingPreset(null);
        setPersonaView('edit');
      };

      const copyPreset = (preset) => {
        const items = customItems();
        const customId = String(preset).startsWith('custom:') ? preset.slice('custom:'.length) : null;
        const custom = customId ? items.find((entry) => entry.id === customId) : null;
        const source =
          custom
            ? { name: custom.name || '自定义人设', text: custom.text || '' }
            : preset === 'simple'
              ? { name: '精简版', text: PRESET_TEXTS.simple }
              : { name: '标准版', text: PRESET_TEXTS.standard };
        const id = createCustomId();
        setDraft((current) => ({
          ...current,
          personaCustoms: [
            ...(current.personaCustoms || []),
            { id, name: source.name + '（副本）', text: source.text },
          ],
          personaPreset: 'custom:' + id,
        }));
        if (!source.text.trim()) {
          setEditingId(id);
          setPersonaView('edit');
        }
        setMessage(`已复制「${source.name}」，记得点保存。`);
      };

      const deleteCustom = (id) => {
        const remaining = customItems().filter((item) => item.id !== id);
        const nextPreset =
          draft.personaPreset === 'custom:' + id ? 'standard' : draft.personaPreset;
        setDraft((current) => ({ ...current, personaCustoms: remaining, personaPreset: nextPreset }));
        if (editingId === id) {
          setEditingId(null);
          setPersonaView('cards');
        }
      };

      const save = async () => {
        if (!state.row || !draft) return;
        const selected = String(draft.personaPreset || '');
        if (selected.startsWith('custom:')) {
          const id = selected.slice('custom:'.length);
          const item = (draft.personaCustoms || []).find((entry) => entry.id === id);
          if (!item || !String(item.text || '').trim()) {
            setTab('persona');
            setEditingId(id);
            setPersonaView('edit');
            setMessage('自定义人设不能为空：请填写文本，或换一个预设。');
            return;
          }
        }
        const ops = [];
        for (const field of FIELDS) {
          if (sameValue(draft[field.key], effective(state.row, field.key))) continue;
          const current = state.row && state.row.value ? state.row.value[field.key] : undefined;
          // 改回默认值时删掉 patch 里的显式值，而不是写一个同值覆盖。
          if (sameValue(draft[field.key], DEFAULTS[field.key]) && current !== undefined && !sameValue(current, DEFAULTS[field.key])) {
            ops.push({ op: 'unset', path: [field.key] });
          } else {
            ops.push({ op: 'set', path: [field.key], value: draft[field.key] });
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
            for (const field of FIELDS) values[field.key] = effective(nextRow, field.key);
            setDraft(values);
            setMessage('已保存，下一次请求生效。');
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
        for (const field of FIELDS) values[field.key] = effective(state.row, field.key);
        setDraft(values);
        setPersonaView('cards');
        setEditingId(null);
        setViewingPreset(null);
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
      const changed = FIELDS.some((field) => !sameValue(draft[field.key], effective(row, field.key)));
      const readonly = row && row.writable === false;
      const customs = Array.isArray(draft.personaCustoms) ? draft.personaCustoms : [];
      const selectedPreset = String(draft.personaPreset || 'standard');
      const editingCustom = editingId ? customs.find((item) => item.id === editingId) : null;
      const customText = editingCustom ? String(editingCustom.text || '') : '';
      const viewingPresetData =
        viewingPreset === 'standard'
          ? { title: '标准版', text: PRESET_TEXTS.standard }
          : viewingPreset === 'simple'
            ? { title: '精简版', text: PRESET_TEXTS.simple }
            : null;
      const presets = [
        {
          id: 'standard',
          title: '标准版',
          description: '默认风格：自称我/小鲸鱼/本鲸，称你为老大，偶尔感慨一句。',
          token: '约 300–440 token',
          viewable: true,
        },
        {
          id: 'simple',
          title: '精简版',
          description: '更短，只保留身份与称呼，语气更克制。',
          token: '约 120–165 token',
          viewable: true,
        },
        ...customs.map((item) => ({
          id: 'custom:' + item.id,
          title: item.name || '自定义人设',
          description: String(item.text || '').trim()
            ? '自定义人设，点击卡片选用。'
            : '尚未填写，点击进入编辑。',
          token: tokenRange(item.text),
          preview: previewText(item.text),
          editable: true,
          customId: item.id,
        })),
      ];
      const messageTone =
        message && (message.includes('失败') || message.includes('不能为空'))
          ? COLORS.danger
          : COLORS.label;

      return h(
        'div',
        { style: { maxWidth: '820px' } },
        h('div', { style: { ...descStyle, marginBottom: '6px' } }, '改变会保存到 profile 配置，下一次请求生效。'),
        h(
          'div',
          { style: tabBarStyle },
          [
            ['logging', '日志设置'],
            ['persona', '人设'],
          ].map(([id, label]) =>
            h(
              'button',
              {
                key: id,
                type: 'button',
                onClick: () => setTab(id),
                style: {
                  padding: '8px 12px',
                  border: 'none',
                  borderBottom: '2px solid ' + (tab === id ? COLORS.accent : 'transparent'),
                  background: 'transparent',
                  color: tab === id ? COLORS.label : COLORS.dim,
                  cursor: 'pointer',
                  fontSize: '13px',
                },
              },
              label,
            ),
          ),
        ),
        tab === 'logging'
          ? h(
              'div',
              { style: { marginTop: '6px' } },
              LOG_FIELDS.map((field) =>
                h(SwitchRow, {
                  key: field.key,
                  field,
                  draft,
                  row,
                  saving,
                  readonly,
                  onToggle: toggle,
                }),
              ),
              hiddenOverrideCount(row) > 0
                ? h(
                    'div',
                    { style: { ...descStyle, marginTop: '8px' } },
                    `检测到 ${hiddenOverrideCount(row)} 项设置被配置文件覆盖，可在配置文件中查看。`,
                  )
                : null,
            )
          : personaView === 'view'
            ? h(
                'div',
                { style: { marginTop: '6px' } },
                h(
                  'button',
                  {
                    type: 'button',
                    onClick: () => {
                      setPersonaView('cards');
                      setEditingId(null);
                      setViewingPreset(null);
                    },
                    style: { ...ghostStyle, marginBottom: '10px' },
                  },
                  '← 返回人设列表',
                ),
                viewingPresetData
                  ? h(
                      'div',
                      null,
                      h('div', { style: { ...titleStyle, fontSize: '14px', fontWeight: '600' } }, '查看人设'),
                      h('div', { style: descStyle }, '只读预览，不能修改。'),
                      h('div', { style: { ...descStyle, marginTop: '10px', marginBottom: '4px' } }, '名称'),
                      h('input', {
                        value: viewingPresetData.title,
                        readOnly: true,
                        style: { ...inputStyle, cursor: 'default' },
                      }),
                      h('div', { style: { ...descStyle, marginTop: '10px', marginBottom: '4px' } }, '正文'),
                      h('textarea', {
                        value: viewingPresetData.text,
                        readOnly: true,
                        style: { ...textareaStyle, cursor: 'default' },
                      }),
                      h(
                        'div',
                        { style: { ...descStyle, marginTop: '6px' } },
                        `${viewingPresetData.text.length}/${CUSTOM_TEXT_LIMIT}`,
                      ),
                    )
                  : h('div', { style: descStyle }, '没有找到这张人设卡，请返回列表重试。'),
              )
            : personaView === 'edit'
            ? h(
                'div',
                { style: { marginTop: '6px' } },
                h(
                  'button',
                  { type: 'button', onClick: () => setPersonaView('cards'), style: { ...ghostStyle, marginBottom: '10px' } },
                  '← 返回人设列表',
                ),
                editingCustom
                  ? h(
                      'div',
                      null,
                      h('div', { style: { ...titleStyle, fontSize: '14px', fontWeight: '600' } }, '编辑自定义人设'),
                      h('div', { style: descStyle }, '纯文本，保留换行，不渲染 Markdown。最多 2000 字符。'),
                      h('div', { style: { ...descStyle, marginTop: '10px', marginBottom: '4px' } }, '名称'),
                      h('input', {
                        value: editingCustom.name,
                        maxLength: 60,
                        disabled: saving || readonly,
                        onChange: (event) => updateCustom(editingCustom.id, { name: event.target.value }),
                        style: inputStyle,
                      }),
                      h('div', { style: { ...descStyle, marginTop: '10px', marginBottom: '4px' } }, '正文'),
                      h('textarea', {
                        value: customText,
                        maxLength: CUSTOM_TEXT_LIMIT,
                        disabled: saving || readonly,
                        onChange: (event) => updateCustom(editingCustom.id, { text: event.target.value }),
                        style: textareaStyle,
                      }),
                      h(
                        'div',
                        { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', marginTop: '6px' } },
                        h('span', { style: descStyle }, `${customText.length}/${CUSTOM_TEXT_LIMIT}`),
                        customText.length > CUSTOM_TEXT_WARN
                          ? h('span', { style: { ...descStyle, color: COLORS.warn } }, '超过 1000 字符，token 成本会明显增加。')
                          : null,
                      ),
                      h(
                        'div',
                        { style: { marginTop: '10px' } },
                        h(
                          'button',
                          { type: 'button', onClick: () => setPersonaView('cards'), style: buttonStyle },
                          '完成',
                        ),
                      ),
                    )
                  : h('div', { style: descStyle }, '没有找到这张自定义人设卡，请返回列表重试。'),
              )
            : h(
                'div',
                { style: { marginTop: '6px' } },
                h(
                  'div',
                  { style: { ...descStyle, marginBottom: '10px' } },
                  '人设只影响说话风格，不改变结论、步骤和判断标准。',
                ),
                h(SwitchRow, {
                  field: PERSONA_SWITCH_FIELD,
                  draft,
                  row,
                  saving,
                  readonly,
                  onToggle: toggle,
                }),
                !draft.persona
                  ? h(
                      'div',
                      {
                        style: {
                          ...descStyle,
                          marginTop: '10px',
                          padding: '8px 10px',
                          borderRadius: '6px',
                          border: '1px solid rgba(217,164,0,.35)',
                          background: 'rgba(217,164,0,.08)',
                          color: COLORS.warn,
                        },
                      },
                      '总开关已关闭，当前不会注入。仍然可以编辑内容，开启并保存后生效。',
                    )
                  : null,
                h('div', { style: { ...titleStyle, fontWeight: '600', marginTop: '14px', marginBottom: '8px' } }, '选择人设'),
                h(
                  'div',
                  { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '10px' } },
                  presets.map((preset) =>
                    h(PersonaCard, {
                      key: preset.id,
                      title: preset.title,
                      description: preset.description,
                      token: preset.token,
                      selected: selectedPreset === preset.id,
                      disabled: saving || readonly,
                      preview: preset.preview,
                      onSelect: () => selectPreset(preset.id),
                      onView: preset.viewable ? () => viewPreset(preset.id) : undefined,
                      onEdit: preset.editable ? () => editCustom(preset.customId) : undefined,
                      onCopy: () => copyPreset(preset.id),
                      onDelete: preset.editable ? () => deleteCustom(preset.customId) : undefined,
                    }),
                  ),
                  h(
                    'div',
                    {
                      role: 'button',
                      tabIndex: saving || readonly ? -1 : 0,
                      onClick: saving || readonly ? undefined : addCustom,
                      onKeyDown: (event) => {
                        if (saving || readonly) return;
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          addCustom();
                        }
                      },
                      style: {
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: '2px',
                        minHeight: '122px',
                        padding: '12px',
                        borderRadius: '10px',
                        border: '1px dashed ' + COLORS.line,
                        color: COLORS.dim,
                        cursor: saving || readonly ? 'not-allowed' : 'pointer',
                      },
                    },
                    h('span', { style: { fontSize: '26px', lineHeight: '30px', fontWeight: '300' } }, '+'),
                    h('span', { style: { fontSize: '12px' } }, '自定义'),
                  ),
                ),
              ),
        h(
          'div',
          {
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: '10px',
              marginTop: '16px',
              paddingTop: '12px',
              borderTop: '1px solid ' + COLORS.line,
              flexWrap: 'wrap',
            },
          },
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
          message ? h('span', { style: { ...descStyle, color: messageTone } }, message) : null,
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
                { name: 'settings.section', id: SECTION_ID, order: 55, label: 'annals设置' },
                AnnalsPage,
              ),
            ),
          'annals: settings page',
        );
      },
    };
  },
});
