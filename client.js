/**
 * Entropy Guard — Client half.
 *
 * Plain browser JavaScript: the module table supplies React, and nothing else is
 * imported. Styling uses only `--dsw-alias-*` theme tokens so the panel follows
 * light/dark with the rest of the application, and every value is fetched from
 * the Host's read-only `/entropy/state` route, which the page already talks to
 * on its own origin.
 *
 * Registration is defensive by design: a Client component that throws blanks its
 * whole slot entry, so every value read here is guarded and a failed fetch
 * degrades to a "not connected" state instead of an exception.
 */
window.__ModuleLoader__.load({
  id: '@cyd-prc/dsh-entropy-guard',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** Poll interval for the live badge, in milliseconds. */
    const POLL_MS = 2000;

    const GEARS = ['Observe', 'Suggest', 'Plan', 'Execute', 'Integrate'];
    const REPORTS = {
      en: {
        title: 'Entropy Guard',
        subtitle: 'Gear-based autonomy governor (entropy-sdk)',
        fleet: 'fleet min',
        session: 'this session',
        gear: 'Gear',
        sigma: 'sigma',
        streak: 'clean streak',
        rejected: 'consecutive rejections',
        suspended: 'SUSPENDED — awaiting human review. Only read-only tools run until /entropy resume.',
        observe: 'Observe mode: nothing is denied, decisions are measured only.',
        acceptance: 'Gate acceptance',
        decisions: 'decisions',
        denied: 'denied',
        wouldDeny: 'would-deny',
        transitions: 'Gear transitions',
        perTool: 'Per-tool decisions',
        tool: 'tool',
        admitted: 'admitted',
        cycle: 'cycle',
        from: 'from',
        to: 'to',
        agents: 'governed agents',
        unavailable: 'Entropy guard: state unavailable',
      },
      zh: {
        title: '熵守卫',
        subtitle: '基于档位的自主权治理（entropy-sdk）',
        fleet: '集群最低档',
        session: '本会话',
        gear: '档位',
        sigma: 'σ 不稳定度',
        streak: '连续干净周期',
        rejected: '连续拒绝',
        suspended: '已挂起 —— 等待人工复核。在 /entropy resume 之前只放行只读工具。',
        observe: '观测模式：不拒绝任何调用，只记录判定。',
        acceptance: '门接受率',
        decisions: '判定数',
        denied: '拒绝数',
        wouldDeny: '本会拒绝',
        transitions: '档位迁移',
        perTool: '分工具判定',
        tool: '工具',
        admitted: '放行',
        cycle: '周期',
        from: '从',
        to: '到',
        agents: '受治 agent',
        unavailable: '熵守卫：状态不可用',
      },
    };

    /**
     * Pick the dictionary for the active locale, defaulting to English.
     * @param localeId - the locale id reported by the Client locale service.
     * @returns the dictionary.
     */
    function dictionary(localeId) {
      return String(localeId ?? '').toLowerCase().startsWith('zh') ? REPORTS.zh : REPORTS.en;
    }

    /**
     * Poll the Host's entropy state endpoint.
     * @param pollMs - interval in milliseconds; `0` fetches once.
     * @returns `{ state, error }`, both null while the first fetch is in flight.
     */
    function useEntropyState(pollMs) {
      const [state, setState] = React.useState(null);
      const [error, setError] = React.useState(null);
      React.useEffect(() => {
        let cancelled = false;
        const load = () => {
          fetch('/entropy/state', { headers: { accept: 'application/json' } })
            .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))))
            .then((body) => {
              if (cancelled) return;
              setState(body);
              setError(null);
            })
            .catch((failure) => {
              if (cancelled) return;
              setState(null);
              setError(failure?.message ?? 'unavailable');
            });
        };
        load();
        if (!pollMs) return () => { cancelled = true; };
        const timer = setInterval(load, pollMs);
        return () => {
          cancelled = true;
          clearInterval(timer);
        };
      }, [pollMs]);
      return { state, error };
    }

    const colors = {
      text: 'var(--dsw-alias-label-primary)',
      muted: 'var(--dsw-alias-label-secondary)',
      border: 'var(--dsw-alias-border-l1)',
      surface: 'var(--dsw-alias-bg-layer-2)',
      ok: 'var(--dsw-alias-state-success-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
      error: 'var(--dsw-alias-state-error-primary)',
      idle: 'var(--dsw-alias-state-idle-primary)',
      brand: 'var(--dsw-alias-brand-primary)',
    };

    /**
     * The five-level gear ladder as a segmented bar.
     * @param props - `{ gear }`.
     * @returns the ladder element.
     */
    function GearLadder({ gear }) {
      const active = Number.isInteger(gear) ? gear : -1;
      return h(
        'div',
        { style: { display: 'flex', gap: 4, alignItems: 'center' } },
        GEARS.map((label, level) => h(
          'div',
          {
            key: label,
            title: `G${level} ${label}`,
            style: {
              padding: '1px 6px',
              borderRadius: 4,
              fontSize: 11,
              lineHeight: '16px',
              border: `1px solid ${level <= active ? colors.brand : colors.border}`,
              background: level === active ? colors.brand : 'transparent',
              color: level === active ? 'var(--dsw-alias-bg-base)' : (level < active ? colors.text : colors.muted),
            },
          },
          `G${level}`,
        )),
      );
    }

    /**
     * A small labelled value.
     * @param props - `{ label, value, tone }`.
     * @returns the element.
     */
    function Metric({ label, value, tone }) {
      return h(
        'span',
        { style: { display: 'inline-flex', gap: 4, alignItems: 'baseline' } },
        h('span', { style: { color: colors.muted, fontSize: 11 } }, label),
        h('span', { style: { color: tone ?? colors.text, fontSize: 12, fontVariantNumeric: 'tabular-nums' } }, String(value)),
      );
    }

    /**
     * The compact badge rendered above the composer. It follows the current
     * session when the slot identifies one, and otherwise reports the fleet's
     * weakest gear — the level the composition can actually be trusted at.
     * @param props - slot props.
     * @returns the element, or null before the first successful fetch.
     */
    function GuardBadge(props) {
      const { state } = useEntropyState(POLL_MS);
      const dict = dictionary(props?.locale?.id);
      if (!state) return null;

      const sessionId = props?.session?.id ?? props?.agent?.id ?? null;
      const own = sessionId === null
        ? null
        : (state.agents ?? []).find((agent) => agent.agentId === sessionId) ?? null;
      const subject = own ?? {
        gear: state.weakestGear,
        gearLabel: state.weakestGearLabel,
        sigma: (state.agents ?? [])[0]?.sigma ?? 0,
        cleanStreak: (state.agents ?? [])[0]?.cleanStreak ?? 0,
        suspended: state.suspended > 0,
      };
      const tone = subject.suspended ? colors.error : (subject.gear <= 1 ? colors.warn : colors.ok);

      return h(
        'div',
        {
          style: {
            display: 'flex',
            flexWrap: 'wrap',
            gap: 10,
            alignItems: 'center',
            padding: '4px 10px',
            margin: '0 0 4px',
            borderRadius: 6,
            border: `1px solid ${colors.border}`,
            background: colors.surface,
            color: colors.text,
            font: 'inherit',
          },
        },
        h('span', { style: { color: colors.muted, fontSize: 11 } }, own ? dict.session : dict.fleet),
        h(GearLadder, { gear: subject.gear }),
        h(Metric, { label: dict.sigma, value: Number(subject.sigma ?? 0).toFixed(2), tone }),
        h(Metric, { label: dict.streak, value: subject.cleanStreak ?? 0 }),
        h(Metric, {
          label: dict.acceptance,
          value: state.acceptance === null || state.acceptance === undefined
            ? 'n/a'
            : `${Math.round(state.acceptance * 100)}%`,
        }),
        state.enforcement === 'observe' && h('span', { style: { color: colors.warn, fontSize: 11 } }, dict.observe),
        subject.suspended && h('span', { style: { color: colors.error, fontSize: 11 } }, dict.suspended),
      );
    }

    /**
     * The full settings page: ladder, live control quantities, fleet table, gear
     * transition history and per-tool decisions.
     * @param props - slot props.
     * @returns the element.
     */
    function GuardPanel(props) {
      const { state, error } = useEntropyState(POLL_MS);
      const dict = dictionary(props?.locale?.id);
      const box = {
        border: `1px solid ${colors.border}`,
        borderRadius: 8,
        padding: 12,
        background: colors.surface,
        color: colors.text,
        fontSize: 13,
      };
      const table = { width: '100%', borderCollapse: 'collapse', fontSize: 12 };
      const cell = { textAlign: 'left', padding: '3px 8px', borderBottom: `1px solid ${colors.border}` };

      const header = h(
        'div',
        { style: { marginBottom: 10 } },
        h('div', { style: { fontSize: 15, fontWeight: 600 } }, dict.title),
        h('div', { style: { color: colors.muted, fontSize: 12 } }, dict.subtitle),
      );

      if (!state) {
        return h('div', { style: box }, header, h('div', { style: { color: colors.muted } }, `${dict.unavailable}${error ? ` (${error})` : ''}`));
      }

      const agents = state.agents ?? [];
      const transitions = agents.flatMap(() => []).concat(state.transitions ?? []);
      return h(
        'div',
        { style: { display: 'grid', gap: 12 } },
        h('div', { style: box }, header, h(GearLadder, { gear: state.weakestGear }), h('div', {
          style: { display: 'flex', flexWrap: 'wrap', gap: 14, marginTop: 10 },
        }, [
          h(Metric, { key: 'g', label: dict.fleet, value: state.weakestGearLabel ?? 'n/a' }),
          h(Metric, { key: 'a', label: dict.agents, value: state.count }),
          h(Metric, { key: 's', label: dict.suspended, value: state.suspended, tone: state.suspended ? colors.error : colors.ok }),
          h(Metric, { key: 'd', label: dict.decisions, value: state.decisions }),
          h(Metric, { key: 'n', label: dict.denied, value: state.denied }),
          h(Metric, { key: 'w', label: dict.wouldDeny, value: state.wouldDeny }),
          h(Metric, {
            key: 'r',
            label: dict.acceptance,
            value: state.acceptance === null || state.acceptance === undefined ? 'n/a' : state.acceptance.toFixed(4),
          }),
        ]), state.enforcement === 'observe' && h('div', {
          style: { color: colors.warn, fontSize: 12, marginTop: 8 },
        }, dict.observe)),

        h('div', { style: box },
          h('div', { style: { fontWeight: 600, marginBottom: 6 } }, dict.agents),
          h('table', { style: table },
            h('thead', null, h('tr', null, ['', dict.gear, dict.sigma, dict.streak, dict.rejected, dict.decisions, dict.denied]
              .map((label, index) => h('th', { key: index, style: { ...cell, color: colors.muted } }, label)))),
            h('tbody', null, agents.map((agent) => h('tr', { key: agent.label },
              h('td', { style: cell }, agent.label),
              h('td', { style: cell }, `G${agent.gear}`),
              h('td', { style: cell }, Number(agent.sigma ?? 0).toFixed(2)),
              h('td', { style: cell }, String(agent.cleanStreak ?? 0)),
              h('td', { style: { ...cell, color: agent.suspended ? colors.error : colors.text } }, agent.suspended ? 'yes' : 'no'),
              h('td', { style: cell }, String(agent.decisions ?? 0)),
              h('td', { style: cell }, String(agent.denied ?? 0))))))),

        (state.perTool && Object.keys(state.perTool).length > 0) && h('div', { style: box },
          h('div', { style: { fontWeight: 600, marginBottom: 6 } }, dict.perTool),
          h('table', { style: table },
            h('thead', null, h('tr', null, [dict.tool, dict.decisions, dict.admitted, dict.denied]
              .map((label, index) => h('th', { key: index, style: { ...cell, color: colors.muted } }, label)))),
            h('tbody', null, Object.entries(state.perTool)
              .sort((a, b) => b[1].decisions - a[1].decisions)
              .slice(0, 20)
              .map(([tool, bucket]) => h('tr', { key: tool },
                h('td', { style: cell }, tool),
                h('td', { style: cell }, String(bucket.decisions)),
                h('td', { style: cell }, String(bucket.admitted)),
                h('td', { style: { ...cell, color: bucket.denied > 0 ? colors.warn : colors.text } }, String(bucket.denied))))))),

        transitions.length > 0 && h('div', { style: box },
          h('div', { style: { fontWeight: 600, marginBottom: 6 } }, dict.transitions),
          h('table', { style: table },
            h('thead', null, h('tr', null, [dict.cycle, dict.from, dict.to, dict.sigma]
              .map((label, index) => h('th', { key: index, style: { ...cell, color: colors.muted } }, label)))),
            h('tbody', null, transitions.slice(-25).map((transition, index) => h('tr', { key: `${transition.cycle}-${index}` },
              h('td', { style: cell }, String(transition.cycle ?? '')),
              h('td', { style: cell }, `G${transition.from}`),
              h('td', { style: cell }, `G${transition.to}`),
              h('td', { style: cell }, String(transition.sigma ?? ''))))))),
      );
    }

    return {
      inject: ['slots'],
      /**
       * Register both contributions through `ctx.slots.inject`, so each is
       * installed when its owning declaration exists and removed when it
       * collapses.
       * @param ctx - the Client plugin context.
       */
      apply(ctx) {
        ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
          name: 'conversation.input.dock',
          id: 'entropy-guard-badge',
          order: 40,
        }, GuardBadge));
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'entropy-guard',
          order: 60,
          label: 'Entropy Guard',
        }, GuardPanel));
      },
    };
  },
});
