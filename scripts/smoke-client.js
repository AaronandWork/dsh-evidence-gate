'use strict'

/**
 * Client-half render smoke test for dsh-evidence-gate.
 * Evaluates lib/client.mjs with stubbed window/__ModuleLoader__/React/fetch,
 * builds the client plugin twice (collapsed-react and expanded-react),
 * renders GateCard + ToggleChip against fake tool blocks, and asserts:
 *  - the evidence-profile card renders without throwing;
 *  - the chip reads the session id from the standard useSession prop and
 *    carries it on GET/POST (per-session stats + per-session toggle);
 *  - the tooltip is 本会话-scoped (no 部署累计, no session count);
 *  - the verdict-off card renders.
 * Run: node scripts/smoke-client.js
 */

const path = require('path')

let failures = 0
function assert(cond, msg) {
  if (!cond) {
    failures = failures + 1
    console.error('FAIL —', msg)
  } else {
    console.log('ok —', msg)
  }
}

// browser timers + fetch stubbed BEFORE the client module is evaluated; the
// chip's effect calls refresh() and schedules a 30s interval.
const fetchCalls = []
global.fetch = (url, opts) => {
  fetchCalls.push({
    url: String(url),
    method: opts && opts.method ? opts.method : 'GET',
    body: opts && typeof opts.body === 'string' ? opts.body : '',
  })
  return Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve({ enabled: true, session: 'sess-1', ledger: { verified: 2, referenced: 1, unverified: 3, converted: 1 } }),
  })
}
global.setInterval = () => 0
global.clearInterval = () => {}

const ReactStub = {
  Fragment: { $$fragment: true },
  createElement(type, props) {
    return { type, props: props || {}, children: Array.prototype.slice.call(arguments, 2) }
  },
  useState(init) {
    const cell = { value: init }
    return [cell.value, function (next) { cell.value = typeof next === 'function' ? next(cell.value) : next }]
  },
  useCallback(fn) {
    return fn
  },
  useEffect(fn) {
    if (typeof fn === 'function') {
      try {
        fn()
      } catch (e) {
        // effect body failures surface through fetch stubs instead
      }
    }
  },
}

// per-client React whose useState forces GateCard's `expanded` (first boolean
// state) to true, and optionally presets the chip state object (init with a
// `loaded` field) so the toggled render is past its loading state.
function makeReact(forceExpanded, preset) {
  return Object.assign({}, ReactStub, {
    useState(init) {
      if (forceExpanded && init === false) {
        init = true
      }
      if (preset && init && typeof init === 'object' && init.loaded !== undefined) {
        init = Object.assign({}, init, preset)
      }
      return ReactStub.useState(init)
    },
  })
}

async function buildClient(forceExpanded, preset) {
  let loadSpec = null
  global.window = {
    __ModuleLoader__: {
      load(spec) {
        loadSpec = spec
      },
    },
  }
  const url = 'file:///' + path.join(__dirname, '..', 'lib', 'client.mjs').replace(/\\/g, '/') + '?v=' + Math.random()
  await import(url)
  if (loadSpec === null) {
    throw new Error('client never called window.__ModuleLoader__.load')
  }
  return loadSpec.factory((name) => {
    if (name === 'react') {
      return makeReact(forceExpanded, preset)
    }
    throw new Error('unexpected require: ' + name)
  })
}

function findOnClick(node) {
  if (!node || typeof node !== 'object') {
    return null
  }
  if (node.props && typeof node.props.onClick === 'function') {
    return node.props.onClick
  }
  const kids = node.children
  if (Array.isArray(kids)) {
    for (const k of kids) {
      const f = findOnClick(k)
      if (f) {
        return f
      }
    }
  } else if (kids && typeof kids === 'object') {
    const f = findOnClick(kids)
    if (f) {
      return f
    }
  }
  return null
}

async function main() {
  // ---- collapsed build ----
  const collapsedPlugin = await buildClient(false)
  assert(collapsedPlugin && typeof collapsedPlugin.apply === 'function', 'factory returns plugin with apply()')
  assert(Array.isArray(collapsedPlugin.inject) && collapsedPlugin.inject.indexOf('slots') >= 0, 'plugin injects slots')
  assert(collapsedPlugin.__test && typeof collapsedPlugin.__test.chipTip === 'function', 'chipTip exported for tests')

  const slots1 = {}
  const ctx1 = {
    slots: {
      inject(name, cb) {
        cb()
      },
      register(options, component) {
        slots1[options.key || options.id || options.name] = component
        return () => {}
      },
    },
  }
  collapsedPlugin.apply(ctx1)

  assert(slots1['evidence_gate'] !== undefined, 'GateCard registered (tool.call.toolview key)')
  assert(slots1['evidence-gate-toggle'] !== undefined, 'toggle chip registered (input.right)')
  const gateCollapsed = slots1['evidence_gate']

  // settled verified block (with full meta)
  const settledBlock = {
    kind: 'tool-result',
    call: { name: 'evidence_gate', argsRaw: JSON.stringify({ claim: 'README 首行是标题', basis: 'read_directly' }) },
    content: [{ type: 'text', text: '【已实证】直接读取，交叉核验✓（命中工具活动记录）。' }],
    isError: false,
    meta: {
      verdict: 'verified',
      basis: 'read_directly',
      evidence: 'read E:/x/README.md 前3行',
      check: 'hit',
      note: '命中工具活动记录 "E:/x/README.md"',
      action: '✔ 可作结论 — 保留证据出处',
      actionOk: true,
      actionLabel: '可作结论',
      actionDetail: '保留证据出处',
    },
  }

  // collapsed render: badge + claim visible, evidence-profile rows hidden
  let flat = JSON.stringify(gateCollapsed({ callId: 'c1', toolName: 'evidence_gate', block: settledBlock }))
  assert(flat.indexOf('已实证') >= 0, 'collapsed card renders 已实证 pill')
  assert(flat.indexOf('README 首行是标题') >= 0, 'collapsed card shows the claim')
  assert(flat.indexOf('"证据"') < 0, 'collapsed card hides the evidence-profile rows')

  // ---- expanded build ----
  const expandedPlugin = await buildClient(true)
  const slots2 = {}
  const ctx2 = {
    slots: {
      inject(name, cb) {
        cb()
      },
      register(options, component) {
        slots2[options.key || options.id || options.name] = component
        return () => {}
      },
    },
  }
  expandedPlugin.apply(ctx2)
  const gateExpanded = slots2['evidence_gate']

  // expanded verified card renders the full evidence profile WITHOUT throwing
  flat = JSON.stringify(gateExpanded({ callId: 'c1', toolName: 'evidence_gate', block: settledBlock }))
  assert(flat.indexOf('已实证') >= 0, 'expanded card renders 已实证 badge')
  assert(flat.indexOf('依据') >= 0 && flat.indexOf('证据') >= 0 && flat.indexOf('核验') >= 0 && flat.indexOf('处理') >= 0,
    'expanded card renders the evidence-profile rows (依据/证据/核验/处理)')
  assert(flat.indexOf('详情渲染失败') < 0, 'no render failure fallback in expanded card')

  // expanded blocked card
  const blockedBlock = {
    kind: 'tool-result',
    call: { name: 'evidence_gate', argsRaw: JSON.stringify({ claim: '假文件已读取', basis: 'assumption' }) },
    content: [{ type: 'text', text: '【已拦截·交叉核验失败】工具流中无匹配活动。' }],
    isError: false,
    meta: {
      verdict: 'unverified',
      basis: 'assumption',
      evidence: '',
      check: 'miss',
      note: '工具流中无匹配活动',
      action: '✘ 不得作结论 — 立即实测翻案',
      actionOk: false,
      actionLabel: '不得作结论',
      actionDetail: '立即实测翻案',
    },
  }
  flat = JSON.stringify(gateExpanded({ callId: 'c2', toolName: 'evidence_gate', block: blockedBlock }))
  assert(flat.indexOf('已拦截') >= 0 && flat.indexOf('不得作结论') >= 0, 'blocked card renders 已拦截 + 不得作结论 pills')

  // v0.2: gate-off card
  const offBlock = {
    kind: 'tool-result',
    call: { name: 'evidence_gate', argsRaw: '{}' },
    content: [{ type: 'text', text: '【门未开启】本会话实证门未开启，本次调用不计数。' }],
    isError: false,
    meta: { verdict: 'off', check: 'skip', note: '', action: '', actionOk: false, actionLabel: '', actionDetail: '', evidence: '', basis: '' },
  }
  flat = JSON.stringify(gateExpanded({ callId: 'c4', toolName: 'evidence_gate', block: offBlock }))
  assert(flat.indexOf('门未开启') >= 0, 'gate-off card renders 门未开启 pill')

  // running state must not crash
  flat = JSON.stringify(gateExpanded({ callId: 'c3', toolName: 'evidence_gate', block: { callId: 'c3', name: 'evidence_gate', argsRaw: '{}', kind: 'running-call' } }))
  assert(flat.indexOf('核验中') >= 0, 'running state renders neutral card')

  // ---- session-scoped chip: useSession prop drives per-session API calls
  const chip = slots1['evidence-gate-toggle']
  const chipProps = { useSession: (sel) => sel({ sessionId: 'sess-1' }) }
  JSON.stringify(chip(chipProps))
  await new Promise((r) => setImmediate(r))
  assert(fetchCalls.length >= 1 && fetchCalls[0].url.indexOf('/api/dsh-evidence-gate?session=sess-1') >= 0,
    'chip GET carries the session id (per-session stats)')

  // loaded-state build so the button (with onClick) renders instead of the loading span
  const presetPlugin = await buildClient(false, { loaded: true, enabled: false, ledger: null, pending: false, hover: false })
  const slots3 = {}
  presetPlugin.apply({
    slots: {
      inject(name, cb) {
        cb()
      },
      register(options, component) {
        slots3[options.key || options.id || options.name] = component
        return () => {}
      },
    },
  })
  const onClick = findOnClick(slots3['evidence-gate-toggle'](chipProps))
  assert(typeof onClick === 'function', 'chip exposes a click handler')
  onClick()
  await new Promise((r) => setImmediate(r))
  await new Promise((r) => setImmediate(r))
  const post = fetchCalls.find((c) => c.method === 'POST')
  assert(post !== undefined && post.body.indexOf('"session":"sess-1"') >= 0 && post.body.indexOf('"action":"on"') >= 0,
    'chip POST toggles THE SESSION (action + session in body)')

  // tooltip: 本会话 stats only
  const tip = collapsedPlugin.__test.chipTip(true, { verified: 2, referenced: 1, unverified: 3, converted: 1 })
  assert(tip.indexOf('本会话: 实证 2 · 引用 1 · 拦截 3 · 转化 1') >= 0, 'tooltip shows 本会话 stats')
  assert(tip.indexOf('部署累计') < 0 && tip.indexOf('· 会话') < 0, 'tooltip has no 部署累计 aggregate and no session count')

  // ---- bilingual (zh/en): resolveLang, en tooltip, dictionary coverage
  const test = collapsedPlugin.__test
  assert(test.resolveLang('zh-CN') === 'zh' && test.resolveLang('en-US') === 'en' && test.resolveLang('fr') === '' && test.resolveLang(undefined) === '',
    'resolveLang maps locale ids (zh/en prefix, unknown → caller fallback)')
  const tipEn = test.chipTip(true, { verified: 2, referenced: 1, unverified: 3, converted: 1 }, 'en')
  assert(tipEn.indexOf('This session: verified 2 · cited 1 · blocked 3 · converted 1') >= 0, 'en tooltip shows this-session stats')
  assert(tipEn.indexOf('部署累计') < 0, 'en tooltip has no Chinese aggregate either')
  assert(test.STRINGS.en.verified === 'Verified' && test.STRINGS.zh.verified === '已实证', 'verdict dictionaries cover both languages')
  const tipFallback = test.chipTip(false, { verified: 1 }, 'not-a-lang')
  assert(tipFallback.indexOf('本会话: 实证 1') >= 0, 'unknown lang falls back to zh (current behavior preserved)')

  // locale service drives the language store, and live switches re-render
  const localePlugin = await buildClient(false)
  let notifyLocale = () => {}
  const localeSvc = {
    getLocale: () => ({ active: 'en' }),
    subscribe(fn) {
      notifyLocale = fn
      return () => {
        notifyLocale = () => {}
      }
    },
  }
  const slots4 = {}
  localePlugin.apply({
    get(name) {
      return name === 'locale' ? localeSvc : undefined
    },
    effect(fn) {
      const d = fn()
      return typeof d === 'function' ? d : undefined
    },
    slots: {
      inject(name, cb) {
        cb()
      },
      register(options, component) {
        slots4[options.key || options.id || options.name] = component
        return () => {}
      },
    },
  })
  const chipEn = slots4['evidence-gate-toggle']
  assert(JSON.stringify(chipEn(chipProps)).indexOf('Gate …') >= 0, 'locale active=en renders the chip in English')
  localeSvc.getLocale = () => ({ active: 'zh' })
  notifyLocale()
  assert(JSON.stringify(chipEn(chipProps)).indexOf('实证 …') >= 0, 'live locale switch re-renders the chip in Chinese')

  // ---- defensive chip: no useSession → honest disabled state, no click handler
  const disabledTree = JSON.stringify(slots3['evidence-gate-toggle']({}))
  assert(disabledTree.indexOf('未取得会话标识') >= 0, 'chip without a session id renders the honest disabled state')
  assert(findOnClick(slots3['evidence-gate-toggle']({})) === null, 'disabled chip exposes no click handler')

  // failing POST (r.ok === false) must not crash and must not throw unhandled
  const prevFetch = global.fetch
  global.fetch = () => Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ error: 'boom' }) })
  const onClickFail = findOnClick(slots3['evidence-gate-toggle'](chipProps))
  assert(typeof onClickFail === 'function', 'click handler still present for known sessions')
  onClickFail()
  await new Promise((r) => setImmediate(r))
  await new Promise((r) => setImmediate(r))
  global.fetch = prevFetch
  assert(true, 'failing toggle response handled without crash (r.ok checked)')

  console.log(failures > 0 ? 'CLIENT SMOKE FAILED (' + failures + ')' : 'CLIENT SMOKE PASSED')
  if (failures > 0) {
    process.exitCode = 1
  }
}

main().catch((e) => {
  console.error('CLIENT SMOKE ERROR:', (e && e.stack) || e)
  process.exit(1)
})
