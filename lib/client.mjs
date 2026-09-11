/**
 * dsh-evidence-gate — Client half (web).
 *
 * Served raw as a classic script inside the client-modules batch: it MUST
 * self-register via `window.__ModuleLoader__.load({ id, factory })` — a bare
 * `export default` or `module.exports` never registers, and the whole batch
 * then fails to load (GUI cannot open).
 *
 * Contributes:
 *  1. A shield toggle chip in the composer control row
 *     (slot `conversation.input.right`, session-scoped): it reads the current
 *     SessionSnapshot.sessionId through the standard `useSession` prop and
 *     talks to the host bundle through the same-origin route
 *     `/api/dsh-evidence-gate?session=...` — stats and the on/off switch are
 *     PER-SESSION (tooltip: 本会话 stats only).
 *  2. A full-card toolview for `evidence_gate` (slot `tool.call.toolview`,
 *     key `evidence_gate`) rendering verdict pill + claim + evidence profile
 *     (依据/证据/核验/处理) in a minimal developer-tool card style. NOTE:
 *     Host presentCall/presentResult never reach the web client — owning the
 *     keyed toolview is the only way to control a card's rendering client-side.
 *  3. Bilingual UI (zh/en): language follows the GUI locale service
 *     (`ctx.locale`, optional) → `navigator.language` → zh. Switching the GUI
 *     language re-renders chip and cards live via a tiny subscription store.
 */
window.__ModuleLoader__.load({
  id: '@aaronandwork/dsh-evidence-gate',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    // shared libraries resolve through the runner's module map — React is NOT
    // a global in the client scope; it arrives via this factory require.
    const React = require('react')

    const API = '/api/dsh-evidence-gate'

    /* ------------------------------------------------------------------ *
     * i18n (zh / en)
     * ------------------------------------------------------------------ */

    const STRINGS = {
      zh: {
        verified: '已实证',
        referenced: '已引用',
        unverified: '已拦截',
        invalid: '无效调用',
        off: '门未开启',
        running: '核验中',
        unknown: '未知判定',
        basisLabel: '依据',
        evidenceLabel: '证据',
        checkLabel: '核验',
        actionLabel: '处理',
        unknownBasis: '未知依据',
        tipOn: '实证门已开启 — 点击关闭（仅本会话）',
        tipOff: '实证门已关闭 — 点击开启（仅本会话）',
        loading: '实证 …',
        loadingTitle: '实证门状态加载中',
        chipOn: '实证 ON',
        chipOff: '实证 OFF',
        expand: '点击展开证据档案',
        collapse: '点击收起',
        noEvidence: '（未提供）',
        seeReport: '见判定说明',
        hitCheck: '核验命中',
        weakCheck: '⚠ 弱核验',
        missCheck: '未命中',
        skipCheck: '未做核验',
        renderFail: '详情渲染失败：',
      },
      en: {
        verified: 'Verified',
        referenced: 'Referenced',
        unverified: 'Blocked',
        invalid: 'Invalid call',
        off: 'Gate off',
        running: 'Checking',
        unknown: 'Unknown',
        basisLabel: 'Basis',
        evidenceLabel: 'Evidence',
        checkLabel: 'Check',
        actionLabel: 'Action',
        unknownBasis: 'Unknown basis',
        tipOn: 'Evidence gate ON — click to turn off (this session only)',
        tipOff: 'Evidence gate OFF — click to turn on (this session only)',
        loading: 'Gate …',
        loadingTitle: 'Loading gate status',
        chipOn: 'Gate ON',
        chipOff: 'Gate OFF',
        expand: 'Click to expand the evidence profile',
        collapse: 'Click to collapse',
        noEvidence: '(not provided)',
        seeReport: 'see report',
        hitCheck: 'Cross-checked',
        weakCheck: '⚠ Weak check',
        missCheck: 'No match',
        skipCheck: 'Not checked',
        renderFail: 'Render failed: ',
      },
    }

    const BASIS_LABELS = {
      zh: {
        tested: '实测',
        measured: '测量',
        read_directly: '直接读取',
        prior_verified: '早前验证',
        documented: '文档记载',
        community_practice: '社区共识',
        assumption: '猜测',
      },
      en: {
        tested: 'Tested',
        measured: 'Measured',
        read_directly: 'Read directly',
        prior_verified: 'Prior-verified',
        documented: 'Documented',
        community_practice: 'Community practice',
        assumption: 'Guess',
      },
    }

    const TIER = {
      zh: {
        tested: '第一手 · 亲自运行了命令/测试',
        measured: '第一手 · 亲自量取了数据',
        read_directly: '第一手 · 亲自读取了文件内容',
        prior_verified: '第一手 · 本会话早前已验证',
        documented: '第二手 · 转述自文档资料',
        community_practice: '第二手 · 转述自社区通行做法',
        assumption: '未验证 · 仅为个人假设',
      },
      en: {
        tested: 'First-hand · ran the command/test yourself',
        measured: 'First-hand · took the measurement yourself',
        read_directly: 'First-hand · took the file content in yourself',
        prior_verified: 'First-hand · verified earlier in this session',
        documented: 'Second-hand · reported from documentation',
        community_practice: 'Second-hand · reported community practice',
        assumption: 'Unverified · personal hypothesis only',
      },
    }

    /** 'zh-CN' → 'zh', 'en-US' → 'en', unknown → '' (caller picks the fallback). */
    function resolveLang(raw) {
      const id = String(raw === undefined || raw === null ? '' : raw).toLowerCase()
      if (id.indexOf('zh') === 0) {
        return 'zh'
      }
      if (id.indexOf('en') === 0) {
        return 'en'
      }
      return ''
    }

    function str(lang) {
      return STRINGS[lang === 'en' ? 'en' : 'zh']
    }

    function basisLabel(lang, basis) {
      const table = BASIS_LABELS[lang === 'en' ? 'en' : 'zh']
      return (basis !== '' && table[basis]) || basis
    }

    function tierOf(lang, basis) {
      const table = TIER[lang === 'en' ? 'en' : 'zh']
      return (basis !== '' && table[basis]) || str(lang).unknownBasis
    }

    function tierColorOf(basisFinal) {
      if (basisFinal === 'documented' || basisFinal === 'community_practice') {
        return '#7c3aed'
      }
      if (basisFinal === 'assumption') {
        return '#64748b'
      }
      if (basisFinal !== '') {
        return '#2563eb'
      }
      return '#9ca3af'
    }

    /* language store: apply() seeds it from the locale service and keeps it in
     * sync; components subscribe so a GUI language switch re-renders live. */
    const langStore = {
      lang: 'zh',
      listeners: [],
      get() {
        return this.lang
      },
      set(l) {
        const next = l === 'en' ? 'en' : 'zh'
        if (next === this.lang) {
          return
        }
        this.lang = next
        for (let i = 0; i < this.listeners.length; i++) {
          try {
            this.listeners[i](next)
          } catch (e) {
            // one stale listener must not break the rest
          }
        }
      },
      subscribe(fn) {
        this.listeners.push(fn)
        return () => {
          const i = this.listeners.indexOf(fn)
          if (i >= 0) {
            this.listeners.splice(i, 1)
          }
        }
      },
    }

    function useLang() {
      const state = React.useState(langStore.lang)
      const setLang = state[1]
      React.useEffect(() => {
        return langStore.subscribe((l) => setLang(l))
      }, [])
      return state[0]
    }

    function makePill(react, text, color, sym) {
      return react.createElement(
        'span',
        {
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
            padding: '1px 8px',
            borderRadius: 999,
            fontSize: 11,
            fontWeight: 600,
            lineHeight: '16px',
            background: color + '1a',
            color: color,
            flexShrink: 0,
          },
        },
        sym !== undefined
          ? react.createElement('span', { style: { fontWeight: 700 } }, sym)
          : react.createElement('span', { style: { width: 6, height: 6, borderRadius: '50%', background: color, flexShrink: 0 } }),
        text,
      )
    }

    /* ------------------------------------------------------------------ *
     * 1. composer toggle chip (conversation.input.right)
     * ------------------------------------------------------------------ */

    function ShieldIcon({ active }) {
      return React.createElement(
        'svg',
        { width: 13, height: 13, viewBox: '0 0 24 24', fill: 'none', style: { flexShrink: 0 } },
        React.createElement('path', {
          d: 'M12 2L4 5v6c0 5.25 3.4 9.74 8 11 4.6-1.26 8-5.75 8-11V5l-8-3z',
          fill: active ? 'currentColor' : 'none',
          stroke: 'currentColor',
          strokeWidth: 2,
          strokeLinejoin: 'round',
        }),
        active
          ? React.createElement('path', {
              d: 'M8.5 12.2l2.4 2.4 4.6-4.8',
              stroke: '#ffffff',
              strokeWidth: 2.2,
              strokeLinecap: 'round',
              strokeLinejoin: 'round',
              fill: 'none',
            })
          : React.createElement(
              'g',
              null,
              React.createElement('path', {
                d: 'M12 7v5.5',
                stroke: 'currentColor',
                strokeWidth: 2.2,
                strokeLinecap: 'round',
              }),
              React.createElement('circle', {
                cx: 12,
                cy: 16,
                r: 1.5,
                fill: 'currentColor',
              }),
            ),
      )
    }

    function chipStyle(enabled, pending, hover) {
      return {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '5px',
        border: '1px solid ' + (enabled ? 'rgba(22,163,74,0.5)' : hover ? 'rgba(148,163,184,0.55)' : 'rgba(148,163,184,0.35)'),
        borderRadius: '999px',
        padding: '2px 10px 2px 8px',
        fontSize: '12px',
        lineHeight: '18px',
        fontWeight: enabled ? 600 : 400,
        cursor: pending ? 'wait' : 'pointer',
        opacity: pending ? 0.6 : 1,
        background: enabled ? (hover ? 'rgba(22,163,74,0.16)' : 'rgba(22,163,74,0.09)') : hover ? 'rgba(148,163,184,0.12)' : 'transparent',
        color: enabled ? '#15803d' : 'inherit',
        transition: 'background 0.15s ease, border-color 0.15s ease, color 0.15s ease',
        userSelect: 'none',
        whiteSpace: 'nowrap',
      }
    }

    /** Session-scoped tooltip: 本会话 stats only (no deployment aggregate, no session count). */
    function chipTip(enabled, ledger, lang) {
      const t = str(lang)
      let tip = enabled ? t.tipOn : t.tipOff
      if (ledger) {
        if (lang === 'en') {
          tip =
            tip +
            ' | This session: verified ' + (ledger.verified || 0) +
            ' · cited ' + (ledger.referenced || 0) +
            ' · blocked ' + (ledger.unverified || 0) +
            ' · converted ' + (ledger.converted || 0)
        } else {
          tip =
            tip +
            '｜本会话: 实证 ' + (ledger.verified || 0) +
            ' · 引用 ' + (ledger.referenced || 0) +
            ' · 拦截 ' + (ledger.unverified || 0) +
            ' · 转化 ' + (ledger.converted || 0)
        }
      }
      return tip
    }

    function ToggleChip(props) {
      // session-scoped slot standard prop: selector hook over SessionSnapshot
      const useSession = props && typeof props.useSession === 'function' ? props.useSession : null
      const sessionId = useSession ? useSession((s) => s.sessionId) : undefined
      const lang = useLang()
      const t = str(lang)
      const state = React.useState({ loaded: false, enabled: false, ledger: null, pending: false, hover: false, error: false })
      const value = state[0]
      const setValue = state[1]

      const applyJson = (j) => {
        setValue({
          loaded: true,
          enabled: !!j.enabled,
          ledger: j.ledger || null,
          pending: false,
          hover: value.hover,
          error: false,
        })
      }

      const qs =
        sessionId === undefined || sessionId === null || sessionId === ''
          ? ''
          : '?session=' + encodeURIComponent(String(sessionId))
      const sessionBody =
        sessionId === undefined || sessionId === null || sessionId === '' ? undefined : String(sessionId)
      const sessionKnown = sessionId !== undefined && sessionId !== null && sessionId !== ''

      const refresh = React.useCallback(() => {
        fetch(API + qs)
          .then((r) => {
            if (!r.ok) {
              throw new Error('HTTP ' + r.status)
            }
            return r.json()
          })
          .then(applyJson)
          .catch(() => setValue((s) => Object.assign({}, s, { loaded: true, pending: false, error: true })))
      }, [qs])

      React.useEffect(() => {
        refresh()
        const timer = setInterval(refresh, 30000)
        return () => clearInterval(timer)
      }, [refresh])

      const toggle = () => {
        if (!sessionKnown) {
          return
        }
        setValue((s) => Object.assign({}, s, { pending: true }))
        fetch(API, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: value.enabled ? 'off' : 'on', session: sessionBody }),
        })
          .then((r) => {
            if (!r.ok) {
              throw new Error('HTTP ' + r.status)
            }
            return r.json()
          })
          .then(applyJson)
          .catch(() => setValue((s) => Object.assign({}, s, { pending: false, error: true })))
      }

      const active = value.enabled
      const hover = value.hover === true
      const style = chipStyle(active, value.pending === true, hover)
      const tip =
        chipTip(active, value.ledger, lang) +
        (value.error === true ? (lang === 'en' ? ' | status fetch failed' : '｜状态读取失败') : '')

      if (!value.loaded) {
        return React.createElement(
          'span',
          { style: Object.assign({}, chipStyle(false, true, false), { color: 'inherit' }), title: t.loadingTitle },
          ShieldIcon({ active: false }),
          t.loading,
        )
      }
      if (!sessionKnown) {
        // honest degraded state: this view has no session context — do not show
        // a clickable switch that would silently target nothing
        return React.createElement(
          'span',
          {
            title: lang === 'en' ? 'Evidence gate: no session id available in this view' : '实证门：此视图未取得会话标识',
            style: Object.assign({}, chipStyle(false, false, false), { opacity: 0.55, cursor: 'default' }),
          },
          ShieldIcon({ active: false }),
          t.chipOff,
        )
      }
      return React.createElement(
        'button',
        {
          onClick: toggle,
          title: tip,
          style: style,
          onMouseEnter: () => setValue((s) => Object.assign({}, s, { hover: true })),
          onMouseLeave: () => setValue((s) => Object.assign({}, s, { hover: false })),
        },
        ShieldIcon({ active: active }),
        active ? t.chipOn : t.chipOff,
      )
    }

    /* ------------------------------------------------------------------ *
     * 2. minimal developer-style card for evidence_gate (tool.call.toolview)
     * ------------------------------------------------------------------ */

    const VERDICT_STYLE = {
      verified: { dot: '#16a34a', text: '#15803d', line: 'rgba(22,163,74,0.6)' },
      referenced: { dot: '#2563eb', text: '#1d4ed8', line: 'rgba(37,99,235,0.55)' },
      unverified: { dot: '#d97706', text: '#b45309', line: 'rgba(217,119,6,0.6)' },
      invalid: { dot: '#6b7280', text: '#4b5563', line: 'rgba(107,114,128,0.55)' },
      off: { dot: '#64748b', text: '#475569', line: 'rgba(100,116,139,0.5)' },
      running: { dot: '#94a3b8', text: 'inherit', line: 'rgba(148,163,184,0.45)' },
      unknown: { dot: '#6b7280', text: '#4b5563', line: 'rgba(107,114,128,0.55)' },
    }

    function verdictLabel(lang, verdict) {
      const t = str(lang)
      if (verdict === 'verified') return t.verified
      if (verdict === 'referenced') return t.referenced
      if (verdict === 'unverified') return t.unverified
      if (verdict === 'invalid') return t.invalid
      if (verdict === 'off') return t.off
      if (verdict === 'running') return t.running
      return t.unknown
    }

    function checkPillInfo(lang, check) {
      const t = str(lang)
      if (check === 'hit') return { label: t.hitCheck, color: '#16a34a' }
      if (check === 'weak') return { label: t.weakCheck, color: '#d97706' }
      if (check === 'miss') return { label: t.missCheck, color: '#dc2626' }
      return { label: t.skipCheck, color: '#9ca3af' }
    }

    const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace'

    function Chevron({ open }) {
      return React.createElement('svg', {
        width: 12,
        height: 12,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: '#9ca3af',
        strokeWidth: 2,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        style: { flexShrink: 0, transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s ease' },
      }, React.createElement('path', { d: 'm6 9 6 6 6-6' }))
    }

    function GateCard(props) {
      const openState = React.useState(false)
      const expanded = openState[0]
      const setExpanded = openState[1]
      const hoverState = React.useState(false)
      const hover = hoverState[0]
      const setHover = hoverState[1]
      const lang = useLang()
      const t = str(lang)

      const block = (props && props.block) || {}
      const isRunning = block.kind !== 'tool-result'

      let claim = ''
      let basis = ''
      try {
        const argsRaw = isRunning ? block.argsRaw : block.call && block.call.argsRaw ? block.call.argsRaw : ''
        const a = JSON.parse(argsRaw || '{}')
        claim = typeof a.claim === 'string' ? a.claim : ''
        basis = typeof a.basis === 'string' ? a.basis : ''
      } catch (e) {
        claim = ''
      }

      let verdict = isRunning ? 'running' : 'unknown'
      let metaEvidence = ''
      let metaCheck = ''
      let metaNote = ''
      let metaAction = ''
      let metaActionOk = false
      let metaActionLabel = ''
      let metaActionDetail = ''
      let body = ''
      if (!isRunning) {
        if (block.meta && typeof block.meta === 'object') {
          if (typeof block.meta.verdict === 'string') verdict = block.meta.verdict
          if (typeof block.meta.evidence === 'string') metaEvidence = block.meta.evidence
          if (typeof block.meta.check === 'string') metaCheck = block.meta.check
          if (typeof block.meta.note === 'string') metaNote = block.meta.note
          if (typeof block.meta.action === 'string') metaAction = block.meta.action
          if (typeof block.meta.actionOk === 'boolean') metaActionOk = block.meta.actionOk
          if (typeof block.meta.actionLabel === 'string') metaActionLabel = block.meta.actionLabel
          if (typeof block.meta.actionDetail === 'string') metaActionDetail = block.meta.actionDetail
        }
        body = Array.isArray(block.content) && block.content[0] && typeof block.content[0].text === 'string' ? block.content[0].text : ''
        if (verdict === 'unknown') {
          // host banners are compact-bilingual; match prefixes without the closing bracket
          if (body.indexOf('【已实证') === 0) verdict = 'verified'
          else if (body.indexOf('【已引用') === 0) verdict = 'referenced'
          else if (body.indexOf('【已拦截') === 0) verdict = 'unverified'
          else if (body.indexOf('【无效调用') === 0) verdict = 'invalid'
          else if (body.indexOf('【门未开启') === 0) verdict = 'off'
        }
      }

      const v = VERDICT_STYLE[verdict] || VERDICT_STYLE.unknown
      const tierInfo = tierOf(lang, basis)
      const basisText = basisLabel(lang, basis)

      const pill = React.createElement(
        'span',
        {
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
            padding: '1px 8px',
            borderRadius: 999,
            fontSize: 11,
            fontWeight: 600,
            lineHeight: '16px',
            background: v.dot + '1a',
            color: v.text,
            flexShrink: 0,
          },
        },
        React.createElement('span', { style: { width: 6, height: 6, borderRadius: '50%', background: v.dot, flexShrink: 0 } }),
        verdictLabel(lang, verdict),
      )

      const header = React.createElement(
        'div',
        {
          onClick: () => setExpanded(!expanded),
          style: { display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', userSelect: 'none', minWidth: 0 },
          title: expanded ? t.collapse : t.expand,
        },
        pill,
        basisText !== ''
          ? React.createElement('span', { style: { fontSize: 11, color: '#9ca3af', flexShrink: 0 } }, basisText)
          : null,
        claim !== ''
          ? React.createElement('span', { style: { flex: '1 1 auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: expanded ? 'normal' : 'nowrap', fontSize: 12.5 } }, claim)
          : null,
        Chevron({ open: expanded }),
      )

      const label = (text) =>
        React.createElement(
          'span',
          { style: { fontSize: 11, color: '#9ca3af', userSelect: 'none', flexShrink: 0, minWidth: 36 } },
          text,
        )

      const profileRow = (labelText, valueChildren) =>
        React.createElement(
          'div',
          { style: { display: 'flex', gap: 8, alignItems: 'baseline' } },
          label(labelText),
          React.createElement('span', { style: { flex: 1, minWidth: 0 } }, valueChildren),
        )

      let detail = null
      if (expanded) {
        try {
          const cp = checkPillInfo(lang, metaCheck)
          detail = React.createElement(
            'div',
            {
              style: {
                marginTop: 8,
                paddingTop: 8,
                borderTop: '1px solid rgba(128,128,128,0.16)',
              },
            },
            profileRow(
              t.basisLabel,
              React.createElement(
                'span',
                { style: { display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' } },
                makePill(React, basisText, tierColorOf(basis)),
                React.createElement('span', { style: { fontSize: 11, opacity: 0.7 } }, tierInfo),
              ),
            ),
            profileRow(
              t.evidenceLabel,
              React.createElement('span', { style: { fontSize: 12, fontFamily: MONO, wordBreak: 'break-word' } }, metaEvidence !== '' ? metaEvidence : t.noEvidence),
            ),
            profileRow(
              t.checkLabel,
              React.createElement(
                'span',
                { style: { display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' } },
                makePill(React, cp.label, cp.color),
                metaNote !== ''
                  ? React.createElement('span', { style: { fontSize: 12, fontFamily: MONO, wordBreak: 'break-word' } }, metaNote)
                  : null,
              ),
            ),
            profileRow(
              t.actionLabel,
              React.createElement(
                'span',
                { style: { display: 'inline-flex', alignItems: 'baseline', gap: 6, flexWrap: 'wrap' } },
                makePill(React, metaActionLabel !== '' ? metaActionLabel : t.seeReport, metaActionOk ? '#16a34a' : '#dc2626'),
                metaActionDetail !== ''
                  ? React.createElement('span', { style: { fontSize: 12, opacity: 0.85 } }, metaActionDetail)
                  : (metaAction !== '' ? React.createElement('span', { style: { fontSize: 12, opacity: 0.7 } }, metaAction) : null),
              ),
            ),
          )
        } catch (e) {
          detail = React.createElement(
            'div',
            { style: { marginTop: 6, fontSize: 11, color: '#dc2626' } },
            t.renderFail + String(e && e.message ? e.message : e),
          )
        }
      }

      return React.createElement(
        'div',
        {
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => setHover(false),
          style: {
            border: '1px solid rgba(128,128,128,0.22)',
            borderLeft: '3px solid ' + v.line,
            borderRadius: 10,
            background: hover && !expanded ? 'rgba(128,128,128,0.05)' : 'rgba(128,128,128,0.03)',
            padding: '7px 12px',
            margin: '4px 0',
            transition: 'background 0.15s ease',
          },
        },
        header,
        detail,
      )
    }

    /* ------------------------------------------------------------------ *
     * registration
     * ------------------------------------------------------------------ */

    exports.inject = ['slots']
    exports.__test = { chipTip: chipTip, resolveLang: resolveLang, STRINGS: STRINGS, langStore: langStore }
    exports.apply = function apply(ctx) {
      const slots = ctx.slots
      if (slots === undefined) {
        console.error('[evidence-gate:client] slots service unavailable — UI skipped')
        return
      }

      // seed + follow the GUI locale (optional service): locale → navigator → zh
      try {
        const localeSvc = ctx.get ? ctx.get('locale') : undefined
        const currentLang = () => {
          try {
            if (localeSvc && typeof localeSvc.getLocale === 'function') {
              const snap = localeSvc.getLocale()
              const l = resolveLang(snap && snap.active)
              if (l !== '') {
                return l
              }
            }
          } catch (e) {
            // fall through to navigator
          }
          try {
            if (typeof navigator !== 'undefined' && navigator.language) {
              const l = resolveLang(navigator.language)
              if (l !== '') {
                return l
              }
            }
          } catch (e) {
            // default below
          }
          return 'zh'
        }
        langStore.set(currentLang())
        if (localeSvc && typeof localeSvc.subscribe === 'function') {
          const unsub = localeSvc.subscribe(() => {
            langStore.set(currentLang())
          })
          if (typeof unsub === 'function') {
            ctx.effect(() => unsub)
          }
        }
      } catch (e) {
        console.error('[evidence-gate:client] locale follow failed: ' + String(e))
      }

      slots.inject('conversation.input.right', () =>
        // must return the disposer: slot entries are cleaned with this fiber on
        // unload / client HMR reload; a factory without return leaks the entry
        // and the next apply fails on the duplicate id.
        slots.register(
          { name: 'conversation.input.right', id: 'evidence-gate-toggle', order: 80 },
          ToggleChip,
        ),
      )

      slots.inject('tool.call.toolview', () =>
        slots.register(
          { name: 'tool.call.toolview', key: 'evidence_gate' },
          GateCard,
        ),
      )

      console.log('[evidence-gate:client] toggle chip + evidence_gate toolview registered (zh/en)')
    }

    return module.exports
  },
})
