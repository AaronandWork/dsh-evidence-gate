'use strict'

/**
 * dsh-evidence-gate — Evidence-first conclusion gate for DeepSeek Harness (DSH).
 *
 * Contributes:
 *  1. A system-prompt section (order 550) establishing the evidence hierarchy.
 *     The section text is a per-session provider: sessions that have the gate
 *     OFF assemble an empty string, so the policy only reaches opted-in sessions.
 *  2. A model tool `evidence_gate`: verdicts 已实证 / 已引用 / 已拦截 per claim
 *     cluster (verdict `off` when the current session has the gate disabled).
 *     First-hand claims are CROSS-CHECKED against a durable per-session evidence
 *     index built from the tools/result stream — both tool ARGUMENTS and tool
 *     OUTPUT text (paths / URLs / distinctive output words). Misses fall through:
 *     other sessions (subagents), then an existence floor for cited paths that
 *     really exist on disk — honest claims pass, fabricated ones still block.
 *  3. A per-session switch + report: `/evidence-gate on|off|status|report` and
 *     the `evidence_gate_switch` model tool. Ledger and switch state are
 *     PER-SESSION (keyed by `exec.agent.sessionId`) and PERSISTED across
 *     restarts (JSON store under DSH_HOME, debounced atomic writes; override
 *     the path with the EVIDENCE_GATE_STORE env var).
 *  4. A UI bridge route `/api/dsh-evidence-gate` (session-scoped GET/POST) for
 *     the composer toggle chip (client half).
 *
 * Scope semantics (v0.2):
 *  - The on/off switch is PER-SESSION and persisted. The prompt section, the
 *    gate tool, and the switch tool are singleton registrations; the section
 *    text provider consults the calling agent's session state at assembly time.
 *  - The evidence index survives context compaction and process restarts, which
 *    removes the systematic false-kills of honest "早前验证" claims.
 *  - Known limits: path-level corroboration (not content truth), multi-profile
 *    deployments sharing one DSH_HOME share the store file (last write wins).
 */

const path = require('path')
let FS = null
try {
  FS = require('fs')
} catch (e) {
  FS = null
}
const FS_OK = FS !== null

// Startup breadcrumbs (store restore + registered components) are SILENT by
// default so mounting the bundle adds no noise to the host console. Set
// EVIDENCE_GATE_DEBUG=1 to print them when diagnosing a mount problem.
// Error/warning diagnostics are never gated.
const DEBUG = process.env.EVIDENCE_GATE_DEBUG === '1'
function debugLog(message) {
  if (DEBUG) console.log(message)
}

const POLICY_TEXT = [
  '## Evidence-first policy (active)',
  'When drawing any conclusion about code, files, system state, external services, or data:',
  '1. Prefer direct verification in this session: run the command, read the file, execute the test, fetch the data — before asserting it.',
  '2. You may reference documented or community-practice conclusions (official docs, changelogs, issue threads, prior verified results) — but name the source and phrase it as reported knowledge, not first-hand observation.',
  '3. Never present an unverified guess as a conclusion. A guess may appear only as an explicitly labeled hypothesis (e.g. 「推测，未验证」) together with its concrete next verification step.',
  'Before a final answer that rests on load-bearing factual claims about the system, code, or data, call the `evidence_gate` tool once per claim cluster with its basis and evidence, and follow its verdict: 已拦截 (UNVERIFIED) means verify now or downgrade the claim to a labeled hypothesis in your answer.',
  "Claims of direct observation (read/tested) are cross-checked against this session's recorded tool activity — claim only what was actually done.",
].join('\n')

const VERIFIED_BASES = { tested: true, measured: true, read_directly: true, prior_verified: true }
const REFERENCED_BASES = { documented: true, community_practice: true }
const VALID_BASES = {
  tested: true,
  measured: true,
  read_directly: true,
  prior_verified: true,
  documented: true,
  community_practice: true,
  assumption: true,
}
const BASIS_ZH = {
  tested: '实测',
  measured: '测量',
  read_directly: '直接读取',
  prior_verified: '早前验证',
  documented: '文档记载',
  community_practice: '社区共识',
  assumption: '猜测',
}
const ALL_BASES = 'tested/measured/read_directly/prior_verified | documented/community_practice | assumption'
const SHELL_TOOLS = { bash: true, pwsh: true }
const WEB_TOOLS = { web_search: true, web_fetch: true }

const INDEX_CAP = 400
const PENDING_CAP = 20
const RECENT_CAP = 12
const CONTAIN_MIN_DIGEST = 8
const BASENAME_MIN = 6
const WORD_MIN = 5
const CROSS_SESSION_SCAN_CAP = 30
const CROSS_SESSION_ENTRY_CAP = 100
const PERSIST_SESSION_CAP = 50
const SAVE_DEBOUNCE_MS = 1500

const sessions = new Map()

/* ------------------------------------------------------------------------ *
 * persistence (v0.2)
 * ------------------------------------------------------------------------ */

const STORE_FILE = (() => {
  const custom = (typeof process !== 'undefined' && process.env && process.env.EVIDENCE_GATE_STORE) || ''
  if (custom !== '') {
    return String(custom)
  }
  const home =
    (typeof process !== 'undefined' && process.env && (process.env.DSH_HOME || process.env.USERPROFILE || process.env.HOME)) || ''
  if (home === '') {
    return ''
  }
  return path.join(home, 'evidence-gate', 'store.json')
})()

const PERSIST_OK = FS_OK && STORE_FILE !== ''

let saveTimer = null
let exitHookInstalled = false

function blankState() {
  return {
    enabled: false,
    updatedAt: 0,
    ledger: {
      verified: 0,
      referenced: 0,
      unverified: 0,
      invalid: 0,
      seq: 0,
      converted: 0,
      crossChecked: 0,
      charity: 0,
      basis: new Map(),
      recent: [],
    },
    pending: [],
    activity: [],
  }
}

function num(v) {
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0
}

function loadStore() {
  if (!PERSIST_OK) {
    return
  }
  try {
    const raw = FS.readFileSync(STORE_FILE, 'utf8')
    const data = JSON.parse(raw)
    if (!data || data.v !== 2 || !data.sessions || typeof data.sessions !== 'object') {
      return
    }
    const keys = Object.keys(data.sessions)
    for (let k = 0; k < keys.length; k++) {
      const key = keys[k]
      const s = data.sessions[key]
      if (!s || typeof s !== 'object') {
        continue
      }
      const st = blankState()
      st.enabled = s.enabled === true
      st.updatedAt = num(s.updatedAt)
      const l = s.ledger || {}
      st.ledger.verified = num(l.verified)
      st.ledger.referenced = num(l.referenced)
      st.ledger.unverified = num(l.unverified)
      st.ledger.invalid = num(l.invalid)
      st.ledger.seq = num(l.seq)
      st.ledger.converted = num(l.converted)
      st.ledger.crossChecked = num(l.crossChecked)
      st.ledger.charity = num(l.charity)
      if (l.basis && typeof l.basis === 'object') {
        const bks = Object.keys(l.basis)
        for (let b = 0; b < bks.length; b++) {
          const bk = bks[b]
          if (bk === '__proto__' || bk === 'constructor' || bk === 'prototype') {
            continue
          }
          st.ledger.basis.set(bk, num(l.basis[bk]))
        }
      }
      if (Array.isArray(l.recent)) {
        for (let r = 0; r < l.recent.length && st.ledger.recent.length < RECENT_CAP; r++) {
          const e = l.recent[r]
          if (e && typeof e.claim === 'string' && typeof e.verdict === 'string') {
            st.ledger.recent.push({
              seq: num(e.seq),
              verdict: e.verdict,
              basis: typeof e.basis === 'string' ? e.basis : '',
              claim: e.claim,
              reason: typeof e.reason === 'string' ? e.reason : '',
            })
          }
        }
      }
      if (Array.isArray(s.pending)) {
        for (let p = 0; p < s.pending.length && st.pending.length < PENDING_CAP; p++) {
          const e = s.pending[p]
          if (e && typeof e.head === 'string') {
            st.pending.push({ head: e.head })
          }
        }
      }
      if (Array.isArray(s.index)) {
        for (let i = 0; i < s.index.length && st.activity.length < INDEX_CAP; i++) {
          const e = s.index[i]
          if (e && typeof e.tool === 'string') {
            st.activity.push({
              tool: e.tool,
              digest: typeof e.digest === 'string' ? e.digest : '',
              out: e.out && typeof e.out === 'object' ? e.out : null,
            })
          }
        }
      }
      sessions.set(String(key), st)
    }
    debugLog('[evidence-gate] ledger restored from store: ' + keys.length + ' session(s)')
  } catch (e) {
    // first boot or unreadable store — start fresh
  }
}

function serializeState(st) {
  const basis = {}
  for (const [k, n] of st.ledger.basis) {
    basis[k] = n
  }
  return {
    enabled: st.enabled === true,
    updatedAt: st.updatedAt,
    ledger: {
      verified: st.ledger.verified,
      referenced: st.ledger.referenced,
      unverified: st.ledger.unverified,
      invalid: st.ledger.invalid,
      seq: st.ledger.seq,
      converted: st.ledger.converted,
      crossChecked: st.ledger.crossChecked,
      charity: st.ledger.charity,
      basis: basis,
      recent: st.ledger.recent,
    },
    pending: st.pending,
    index: st.activity,
  }
}

function saveNow() {
  if (!PERSIST_OK) {
    return
  }
  try {
    const picked = []
    for (const [key, st] of sessions) {
      if (st.enabled === true || st.ledger.seq > 0 || st.activity.length > 0) {
        picked.push([key, st])
      }
    }
    picked.sort((a, b) => (b[1].updatedAt || 0) - (a[1].updatedAt || 0))
    const out = { v: 2, savedAt: new Date().toISOString(), sessions: {} }
    const cap = Math.min(picked.length, PERSIST_SESSION_CAP)
    for (let i = 0; i < cap; i++) {
      out.sessions[picked[i][0]] = serializeState(picked[i][1])
    }
    FS.mkdirSync(path.dirname(STORE_FILE), { recursive: true })
    // pid-suffixed tmp: two processes must never race on the same temp name
    const tmp = STORE_FILE + '.' + process.pid + '.tmp'
    FS.writeFileSync(tmp, JSON.stringify(out))
    FS.renameSync(tmp, STORE_FILE)
  } catch (e) {
    console.error('[evidence-gate] persist failed: ' + String(e))
  }
}

function scheduleSave() {
  if (!PERSIST_OK || saveTimer !== null) {
    return
  }
  saveTimer = setTimeout(() => {
    saveTimer = null
    saveNow()
  }, SAVE_DEBOUNCE_MS)
  if (typeof saveTimer.unref === 'function') {
    saveTimer.unref()
  }
}

function markDirty(st) {
  st.updatedAt = Date.now()
  scheduleSave()
}

function installExitHook() {
  if (exitHookInstalled || !PERSIST_OK) {
    return
  }
  exitHookInstalled = true
  process.on('exit', () => {
    if (saveTimer !== null) {
      clearTimeout(saveTimer)
      saveTimer = null
    }
    saveNow()
  })
}

/* ------------------------------------------------------------------------ *
 * session state
 * ------------------------------------------------------------------------ */

function keyOf(source) {
  const agent = source && source.agent
  // identity sources, best first: agent.sessionId, then a bare sessionId on the
  // event itself (defensive — an emitter may pass the agent/session object
  // directly), then agent.id (an Agent handle that hides its sessionId)
  const id = (agent && agent.sessionId) || (source && source.sessionId) || (agent && agent.id) || null
  if (id) {
    return String(id)
  }
  if (!sharedWarned) {
    sharedWarned = true
    const what = source && source.name ? ' (tool: ' + source.name + ')' : ''
    console.warn(
      '[evidence-gate] session identity unavailable' + what +
      " — falling back to the shared bucket. With multiple main sessions this state is shared across them; please report which action produced it.",
    )
  }
  return 'shared'
}
let sharedWarned = false

function stateFor(key) {
  let st = sessions.get(key)
  if (st === undefined) {
    st = blankState()
    sessions.set(key, st)
  }
  return st
}

function peekState(key) {
  return sessions.get(key)
}

/* ------------------------------------------------------------------------ *
 * evidence index (tools/result stream → arguments + output anchors)
 * ------------------------------------------------------------------------ */

function truncate(text, max) {
  const s = String(text)
  return s.length > max ? s.slice(0, max) + '…' : s
}

function ledgerLine(st) {
  return '实证' + st.ledger.verified + '·引用' + st.ledger.referenced + '·拦截' + st.ledger.unverified + '·转化' + st.ledger.converted
}

function zeroLedgerLine() {
  return '实证0·引用0·拦截0·转化0'
}

function record(st, claim, basis, verdict, reason) {
  st.ledger.seq = st.ledger.seq + 1
  if (verdict === 'verified') {
    st.ledger.verified = st.ledger.verified + 1
  } else if (verdict === 'referenced') {
    st.ledger.referenced = st.ledger.referenced + 1
  } else if (verdict === 'invalid') {
    st.ledger.invalid = st.ledger.invalid + 1
  } else {
    st.ledger.unverified = st.ledger.unverified + 1
  }
  if (basis && VALID_BASES[basis] === true) {
    st.ledger.basis.set(basis, (st.ledger.basis.get(basis) || 0) + 1)
  }
  st.ledger.recent.unshift({
    seq: st.ledger.seq,
    verdict: verdict,
    basis: basis,
    claim: truncate(claim, 60),
    reason: truncate(reason || '', 80),
  })
  if (st.ledger.recent.length > RECENT_CAP) {
    st.ledger.recent.length = RECENT_CAP
  }
  markDirty(st)
}

function digestOf(args) {
  if (!args || typeof args !== 'object') {
    return ''
  }
  const keys = ['file_path', 'path', 'pattern', 'command', 'url', 'query', 'queries', 'provider', 'method']
  for (let i = 0; i < keys.length; i++) {
    const v = args[keys[i]]
    if (typeof v === 'string' && v.length > 0) {
      return truncate(v, 160)
    }
    if (Array.isArray(v) && v.length > 0 && typeof v[0] === 'string') {
      return truncate(v[0], 160)
    }
  }
  return ''
}

function resultTextOf(result) {
  if (typeof result === 'string') {
    return result
  }
  if (result && typeof result === 'object') {
    if (Array.isArray(result.content)) {
      const parts = []
      for (let i = 0; i < result.content.length && i < 3; i++) {
        const c = result.content[i]
        if (c && typeof c.text === 'string') {
          parts.push(c.text)
        }
      }
      return parts.join('\n')
    }
    if (typeof result.text === 'string') {
      return result.text
    }
  }
  return ''
}

function outWords(text) {
  const seen = {}
  const out = []
  const parts = String(text || '').toLowerCase().split(/[^a-z0-9_\-]+/)
  for (let i = 0; i < parts.length && out.length < 20; i++) {
    const w = parts[i]
    if (w.length >= WORD_MIN && seen[w] !== true) {
      seen[w] = true
      out.push(w)
    }
  }
  return out
}

/** Extract corroboration anchors (urls / paths / distinctive words) from one tool output. */
function outAnchors(result) {
  const text = String(resultTextOf(result) || '').slice(0, 1200)
  if (text === '') {
    return null
  }
  const urls = []
  const re = /https?:\/\/[^\s"'<>）】》]+/g
  let m = re.exec(text)
  while (m !== null && urls.length < 3) {
    urls.push(m[0])
    m = re.exec(text)
  }
  const paths = pathTokens(text)
  const words = outWords(text)
  if (urls.length === 0 && paths.length === 0 && words.length === 0) {
    return null
  }
  return { urls: urls, paths: paths, words: words }
}

function noteActivity(st, exec, result) {
  if (!exec || typeof exec.name !== 'string') {
    return
  }
  if (exec.name.indexOf('evidence_gate') === 0) {
    return
  }
  const entry = { tool: exec.name, digest: digestOf(exec.arguments) }
  const out = outAnchors(result)
  if (out !== null) {
    entry.out = out
  }
  st.activity.unshift(entry)
  if (st.activity.length > INDEX_CAP) {
    st.activity.length = INDEX_CAP
  }
  markDirty(st)
}

/** Process home, for expanding $env:USERPROFILE / %USERPROFILE% / ~ in recorded commands and cited paths. */
const HOME = (() => {
  const h = (typeof process !== 'undefined' && process.env && (process.env.USERPROFILE || process.env.HOME)) || ''
  return String(h).replace(/\\/g, '/').replace(/\/$/, '')
})()

/**
 * Normalize a path-like string for matching:
 *  1. expand $env:NAME / %NAME% / ~ to actual paths
 *  2. backslashes to slashes
 *  3. strip trailing :line[:col]
 *  4. lowercase
 */
function normalizePathish(s) {
  let out = String(s || '')
  if (HOME !== '' && /\$env:|%/i.test(out)) {
    out = out.replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)/gi, (m, name) => {
      const v = process.env[name]
      return v === undefined ? m : String(v).replace(/\\/g, '/')
    })
    out = out.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (m, name) => {
      const v = process.env[name]
      return v === undefined ? m : String(v).replace(/\\/g, '/')
    })
  }
  if (HOME !== '') {
    out = out.replace(/~(?=\/|\\|\s|$)/g, HOME)
  }
  return out
    .replace(/\\/g, '/')
    .replace(/:\d+(?::\d+)?$/, '')
    .toLowerCase()
}

function baseOf(normalized) {
  const i = normalized.lastIndexOf('/')
  return i >= 0 ? normalized.slice(i + 1) : normalized
}

/** Whole-word containment, so a recorded "dir" matches "用 dir 列出" but not "directory". */
function containsWholeWord(hay, needle) {
  let i = hay.indexOf(needle)
  while (i >= 0) {
    const before = i === 0 ? ' ' : hay.charAt(i - 1)
    const after = hay.charAt(i + needle.length) || ' '
    if (!/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after)) {
      return true
    }
    i = hay.indexOf(needle, i + 1)
  }
  return false
}

function normalizeUrl(u) {
  let s = String(u || '').toLowerCase().trim()
  const cut = s.indexOf('#')
  if (cut >= 0) {
    s = s.slice(0, cut)
  }
  while (s.length > 0 && s.charAt(s.length - 1) === '/') {
    s = s.slice(0, -1)
  }
  return s
}

/**
 * Does one index entry corroborate a claimed path-like token?
 * Same rules as v0.1 (two-way normalized containment with the short-pattern
 * guard, plus the >= BASENAME_MIN basename fallback), extended to the output
 * anchors a tool result contributed.
 */
function entryMatches(a, t, tb) {
  const cands = [a.digest]
  if (a.out && Array.isArray(a.out.paths)) {
    for (let i = 0; i < a.out.paths.length; i++) {
      cands.push(a.out.paths[i])
    }
  }
  for (let i = 0; i < cands.length; i++) {
    const d = normalizePathish(cands[i])
    if (d.length === 0) {
      continue
    }
    if (t === '') {
      return true
    }
    if (d.indexOf(t) >= 0) {
      return true
    }
    if (d.length >= CONTAIN_MIN_DIGEST && t.indexOf(d) >= 0) {
      return true
    }
    if (tb.length >= BASENAME_MIN && baseOf(d) === tb) {
      return true
    }
  }
  return false
}

function findEntry(st, token) {
  const t = normalizePathish(token)
  const tb = baseOf(t)
  for (let i = 0; i < st.activity.length; i++) {
    if (entryMatches(st.activity[i], t, tb)) {
      return st.activity[i]
    }
  }
  return null
}

/** Path corroboration across sessions (subagent did the work, parent claims it). */
function findPathAny(st, key, token) {
  if (findEntry(st, token) !== null) {
    return { cross: false }
  }
  const t = normalizePathish(token)
  const tb = baseOf(t)
  let scanned = 0
  for (const [k2, st2] of sessions) {
    if (k2 === key || st2.activity.length === 0) {
      continue
    }
    scanned = scanned + 1
    if (scanned > CROSS_SESSION_SCAN_CAP) {
      break
    }
    const lim = Math.min(st2.activity.length, CROSS_SESSION_ENTRY_CAP)
    for (let i = 0; i < lim; i++) {
      if (entryMatches(st2.activity[i], t, tb)) {
        return { cross: true }
      }
    }
  }
  return null
}

function urlMatch(a, u) {
  const un = normalizeUrl(u)
  if (un === '') {
    return false
  }
  if (WEB_TOOLS[a.tool] === true) {
    const d = normalizePathish(a.digest)
    if (d !== '' && (d.indexOf(un) >= 0 || (un.indexOf(d) >= 0 && d.length >= CONTAIN_MIN_DIGEST))) {
      return true
    }
  }
  if (a.out && Array.isArray(a.out.urls)) {
    for (let i = 0; i < a.out.urls.length; i++) {
      const x = normalizeUrl(a.out.urls[i])
      if (x === '') {
        continue
      }
      if (x === un || x.indexOf(un) >= 0 || un.indexOf(x) >= 0) {
        return true
      }
    }
  }
  return false
}

function findWebAny(key, url) {
  // own session first (no cap), then other sessions bounded like the path scan
  const own = peekState(key)
  if (own !== undefined) {
    for (let i = 0; i < own.activity.length; i++) {
      if (urlMatch(own.activity[i], url)) {
        return { cross: false }
      }
    }
  }
  let scanned = 0
  for (const [k2, st2] of sessions) {
    if (k2 === key || st2.activity.length === 0) {
      continue
    }
    scanned = scanned + 1
    if (scanned > CROSS_SESSION_SCAN_CAP) {
      break
    }
    const lim = Math.min(st2.activity.length, CROSS_SESSION_ENTRY_CAP)
    for (let i = 0; i < lim; i++) {
      if (urlMatch(st2.activity[i], url)) {
        return { cross: true }
      }
    }
  }
  return null
}

function pathTokens(text) {
  const out = []
  const parts = String(text || '').split(/[\s,;()（）'"「」【】]+/)
  for (let i = 0; i < parts.length; i++) {
    const t = parts[i].trim()
    if (t.length >= 4 && (t.indexOf('/') >= 0 || t.indexOf('\\') >= 0) && t.indexOf('http') < 0) {
      out.push(t)
    }
    if (out.length >= 6) {
      break
    }
  }
  return out
}

/** Distinctive ASCII words (>= WORD_MIN chars) usable to correlate evidence with recorded commands/outputs. */
function evidenceWords(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9_\-./\\]+/)
    .filter((w) => w.length >= WORD_MIN)
    .slice(0, 8)
}

/** First cited path token that really exists on disk (existence floor for unindexed honest claims). */
function existingPathToken(evidence) {
  if (!FS_OK) {
    return null
  }
  const tokens = pathTokens(evidence)
  for (let i = 0; i < tokens.length; i++) {
    const p = normalizePathish(tokens[i])
    if (!/^[a-z]:\//.test(p) && p.indexOf('//') !== 0) {
      continue
    }
    try {
      const stat = FS.statSync(p.replace(/\/$/, ''))
      if (stat) {
        return tokens[i]
      }
    } catch (e) {
      // not present — keep looking
    }
  }
  return null
}

/**
 * Cross-check a first-hand/referenced claim against the durable evidence index.
 * Order: own-session paths → tested command correlation → recorded OUTPUT
 * keywords → other sessions → existence floor → miss.
 */
function crossCheck(st, key, basis, evidence, source) {
  // Uniform logic for empty AND populated indexes: own-session lookups no-op on
  // an empty index while cross-session hits, the existence floor, and the
  // referenced-URL path still work — no early "window just opened" auto-pass.
  if (VERIFIED_BASES[basis] === true) {
    const tokens = pathTokens(evidence)
    if (tokens.length > 0) {
      for (let i = 0; i < tokens.length; i++) {
        const found = findPathAny(st, key, tokens[i])
        if (found !== null) {
          st.ledger.crossChecked = st.ledger.crossChecked + 1
          return {
            mode: 'hit',
            note: (found.cross ? '命中其他会话工具活动（子代理/早前会话） "' : '命中工具活动记录 "') + truncate(tokens[i], 60) + '"',
          }
        }
      }
      const floor = existingPathToken(evidence)
      if (floor !== null) {
        st.ledger.charity = st.ledger.charity + 1
        return { mode: 'weak', note: '索引未命中，但证据路径真实存在——按指针采信（如未实测请自行复核）' }
      }
      return { mode: 'miss', note: '证据索引中无与 "' + truncate(tokens[0], 60) + '" 匹配的活动' }
    }
    if (basis === 'tested' || basis === 'measured') {
      const head = normalizePathish(truncate(evidence, 24))
      const words = evidenceWords(evidence)
      for (let i = 0; i < st.activity.length; i++) {
        const a = st.activity[i]
        if (!SHELL_TOOLS[a.tool]) {
          continue
        }
        const d = normalizePathish(a.digest)
        if (d.length === 0) {
          continue
        }
        if (head.length >= CONTAIN_MIN_DIGEST && (d.indexOf(head) >= 0 || (head.indexOf(d) >= 0 && d.length >= CONTAIN_MIN_DIGEST))) {
          st.ledger.crossChecked = st.ledger.crossChecked + 1
          return { mode: 'hit', note: '证据与已记录命令关联' }
        }
        if (d.length >= 3 && containsWholeWord(evidence.toLowerCase(), d)) {
          st.ledger.crossChecked = st.ledger.crossChecked + 1
          return { mode: 'hit', note: '证据引用了已记录命令 "' + truncate(a.digest, 40) + '"' }
        }
        for (let w = 0; w < words.length; w++) {
          if (d.indexOf(words[w]) >= 0) {
            st.ledger.crossChecked = st.ledger.crossChecked + 1
            return { mode: 'hit', note: '已记录命令包含证据关键词 "' + words[w] + '"' }
          }
        }
      }
      // recorded tool OUTPUT contains an evidence keyword ("pnpm test → SMOKE PASSED")
      for (let i = 0; i < st.activity.length; i++) {
        const a = st.activity[i]
        if (!a.out || !Array.isArray(a.out.words) || a.out.words.length === 0) {
          continue
        }
        for (let w = 0; w < words.length; w++) {
          if (a.out.words.indexOf(words[w]) >= 0) {
            st.ledger.crossChecked = st.ledger.crossChecked + 1
            return { mode: 'hit', note: '命中已记录输出关键词 "' + words[w] + '"（' + a.tool + '）' }
          }
        }
      }
      return { mode: 'miss', note: '证据索引中没有与该「实测」关联的命令或输出——请在 evidence 中引用确切命令与输出' }
    }
    return { mode: 'skip', note: '无可核验的路径' }
  }
  if (REFERENCED_BASES[basis] === true) {
    const src = source !== '' ? source : evidence
    if (src.indexOf('http') === 0) {
      const hit = findWebAny(key, src)
      if (hit !== null) {
        st.ledger.crossChecked = st.ledger.crossChecked + 1
        return {
          mode: 'hit',
          note: hit.cross ? '该来源出现在其他会话的搜索/抓取记录中' : '该来源已出现在本会话的搜索/抓取记录中',
        }
      }
      return { mode: 'weak', note: '该 URL 本会话未抓取——引用时须谨慎' }
    }
    return { mode: 'skip', note: '' }
  }
  return { mode: 'skip', note: '' }
}

function gateReport(key, args) {
  const st = stateFor(key)
  const a = (args && typeof args === 'object') ? args : {}
  const claim = typeof a.claim === 'string' ? a.claim.trim() : ''
  const basis = typeof a.basis === 'string' ? a.basis.trim() : ''
  const evidence = typeof a.evidence === 'string' ? a.evidence.trim() : ''
  const source = typeof a.source === 'string' ? a.source.trim() : ''
  const nextVerification = typeof a.next_verification === 'string' ? a.next_verification.trim() : ''
  const basisZh = BASIS_ZH[basis] || basis

  if (claim === '' || VALID_BASES[basis] !== true) {
    record(st, claim, basis, 'invalid', '调用无效')
    return {
      verdict: 'invalid',
      ledger: snapshot(st),
      report: '【无效调用 Invalid】claim 必填；basis 须为：' + ALL_BASES + '。' + ledgerLine(st),
    }
  }

  let verdict
  let message
  let reason
  let action = ''
  let actionOk = false
  let actionLabel = ''
  let actionDetail = ''
  let checkMode = 'skip'
  let checkNote = ''
  const evidenceOut = truncate(evidence, 160)
  if (VERIFIED_BASES[basis] === true) {
    if (evidence !== '') {
      const cc = crossCheck(st, key, basis, evidence, source)
      checkMode = cc.mode
      checkNote = cc.note
      if (cc.mode === 'miss') {
        verdict = 'unverified'
        reason = '交叉核验失败：' + cc.note
        actionOk = false
        actionLabel = '不得作结论 No'
        actionDetail = '重新实测后翻案，或标注「推测，未验证」'
        message = '【已拦截 Blocked·交叉核验失败 Cross-check failed】' + cc.note + '。二选一：① 重新实测（运行/读取）后以实际证据再次过门；② 在回答中降级为「推测，未验证」。'
      } else {
        verdict = 'verified'
        reason = cc.mode === 'hit' ? '交叉核验✓ ' + cc.note : cc.mode === 'weak' ? '采信：' + cc.note : '无可核验路径（按声明采信）'
        actionOk = true
        actionLabel = cc.mode === 'weak' ? '可引用 Cite' : '可作结论 OK'
        actionDetail = cc.mode === 'hit' ? '保留证据出处' : cc.mode === 'weak' ? '表述须谨慎' : '建议保留出处'
        action = (actionOk ? '✔ ' : '✘ ') + actionLabel + (actionDetail !== '' ? ' — ' + actionDetail : '')
        message =
          '【已实证 Verified】' + basisZh + '，' + (cc.mode === 'hit' ? '交叉核验✓（' + cc.note + '）' : cc.mode === 'weak' ? cc.note : '无可核验路径，按声明采信') +
          '。可在回答中陈述该结论，证据出处：' + truncate(evidence, 120)
      }
    } else {
      verdict = 'unverified'
      reason = '声称' + basisZh + '但未提供证据'
      actionOk = false
      actionLabel = '不得作结论'
      actionDetail = '先取证再过门，或标注「推测，未验证」'
      action = (actionOk ? '✔ ' : '✘ ') + actionLabel + ' — ' + actionDetail
      message = '【已拦截 Blocked】声称「' + basisZh + '」但未提供任何证据。请先取证再过门，或在回答中降级为「推测，未验证」。'
    }
  } else if (REFERENCED_BASES[basis] === true) {
    if (source !== '' || evidence !== '') {
      const cc = crossCheck(st, key, basis, evidence, source)
      checkMode = cc.mode
      checkNote = cc.note
      verdict = 'referenced'
      reason = '已注明来源' + (cc.note !== '' ? '（' + cc.note + '）' : '')
      actionOk = true
      actionLabel = '可引用 Cite'
      actionDetail = '必须注明来源，并表述为转述'
      action = '✔ 可引用 — 必须注明来源，并表述为转述'
      message =
        '【已引用 Referenced】' + basisZh + '支撑。回答中必须注明来源（' + truncate(source !== '' ? source : evidence, 100) + '），并表述为「据记载」而非亲测' +
        (cc.note !== '' ? '——' + cc.note : '') + '。'
    } else {
      verdict = 'unverified'
      reason = '引用未注明来源'
      actionOk = false
      actionLabel = '不得作结论'
      actionDetail = '先注明来源再过门，或标注「推测，未验证」'
      action = (actionOk ? '✔ ' : '✘ ') + actionLabel + ' — ' + actionDetail
      message = '【已拦截 Blocked】引用类结论必须注明来源。请先查到出处（web_search / 读取文档）再过门，或在回答中降级为「推测，未验证」。'
    }
  } else {
    verdict = 'unverified'
    reason = '未实测的假设'
    actionOk = false
    actionLabel = '不得作结论'
    actionDetail = '立即实测翻案，或标注「推测，未验证」'
    action = (actionOk ? '✔ ' : '✘ ') + actionLabel + ' — ' + actionDetail
    message =
      '【已拦截 Blocked】未实测的假设不得作为结论。二选一：① 立即实测（运行/读取/搜索）后以升级 basis 重新过门；② 仅以「推测，未验证」标注' +
      (nextVerification !== '' ? '，下一步验证：' + truncate(nextVerification, 120) : '（传入 next_verification）') + '。'
  }

  record(st, claim, basis, verdict, reason)
  if (verdict === 'unverified') {
    st.pending.unshift({ head: claim.toLowerCase().slice(0, 40) })
    if (st.pending.length > PENDING_CAP) {
      st.pending.length = PENDING_CAP
    }
  } else if (verdict === 'verified') {
    const head = claim.toLowerCase().slice(0, 40)
    for (let i = 0; i < st.pending.length; i++) {
      const p = st.pending[i].head
      if (p === head || (p.length > 8 && head.indexOf(p) >= 0) || (head.length > 8 && p.indexOf(head) >= 0)) {
        st.pending.splice(i, 1)
        st.ledger.converted = st.ledger.converted + 1
        break
      }
    }
  }

  return {
    verdict: verdict,
    reason: reason,
    action: action,
    actionOk: actionOk,
    actionLabel: actionLabel,
    actionDetail: actionDetail,
    basis: basis,
    evidence: evidenceOut,
    check: checkMode,
    note: checkNote,
    ledger: snapshot(st),
    report: message + '（' + ledgerLine(st) + '）',
  }
}

function snapshot(st) {
  return {
    verified: st.ledger.verified,
    referenced: st.ledger.referenced,
    unverified: st.ledger.unverified,
    converted: st.ledger.converted,
    recent: st.ledger.recent.slice(),
  }
}

function reportText(key) {
  const st = peekState(key)
  const on = st !== undefined && st.enabled === true
  if (st === undefined) {
    return [
      '[evidence-gate] 实证门报告 Evidence-gate report（' + key + '）— 门 Gate 关闭 OFF（本会话 this session）',
      '统计 Stats: 实证 verified 0 · 引用 cited 0 · 拦截 blocked 0 · 转化 converted 0 · 核验命中 cross-checked 0 · 采信 floor-passed 0（索引 index 0）',
      '【已拦截（需实测或降级为推测）Blocked (verify or downgrade)】',
      '  （无 none）',
      '【已实证 Verified】',
      '  （无 none）',
      '【已引用 Referenced】',
      '  （无 none）',
    ].join('\n')
  }
  const blocked = []
  const verified = []
  const referenced = []
  for (const r of st.ledger.recent) {
    const line = '#' + r.seq + ' ' + r.claim + (r.reason !== '' ? '（' + r.reason + '）' : '')
    if (r.verdict === 'unverified') {
      blocked.push('  ' + line)
    } else if (r.verdict === 'verified') {
      verified.push('  ' + line)
    } else if (r.verdict === 'referenced') {
      referenced.push('  ' + line)
    }
  }
  const parts = []
  for (const [k, n] of st.ledger.basis) {
    parts.push((BASIS_ZH[k] || k) + '=' + n)
  }
  return [
    '[evidence-gate] 实证门报告 Evidence-gate report（' + key + '）— 门 Gate ' + (on ? '开启 ON' : '关闭 OFF') + '（本会话 this session，跨重启 persists）',
    '统计 Stats: 实证 verified ' + st.ledger.verified + ' · 引用 cited ' + st.ledger.referenced + ' · 拦截 blocked ' + st.ledger.unverified + ' · 无效 invalid ' + st.ledger.invalid + ' · 转化 converted ' + st.ledger.converted + ' · 核验命中 cross-checked ' + st.ledger.crossChecked + ' · 采信 floor-passed ' + st.ledger.charity + '（索引 index ' + st.activity.length + '）',
    '【已拦截（需实测或降级为推测）Blocked (verify or downgrade)】',
    blocked.length > 0 ? blocked.join('\n') : '  （无 none）',
    '【已实证 Verified】',
    verified.length > 0 ? verified.join('\n') : '  （无 none）',
    '【已引用 Referenced】',
    referenced.length > 0 ? referenced.join('\n') : '  （无 none）',
    '按 basis By basis：' + (parts.length > 0 ? parts.join('，') : '无'),
  ].join('\n')
}

function statusText(key) {
  const st = peekState(key)
  const on = st !== undefined && st.enabled === true
  if (st === undefined) {
    return '状态 State=关闭 OFF（本会话 this session） | ' + zeroLedgerLine() + ' | 核验命中 cross-checked 0 | 索引 index 0'
  }
  return (
    '状态 State=' + (on ? '开启 ON' : '关闭 OFF') + '（本会话 this session） | ' + ledgerLine(st) +
    ' | 核验命中 cross-checked ' + st.ledger.crossChecked + ' · 采信 floor-passed ' + st.ledger.charity + ' | 索引 index ' + st.activity.length
  )
}

/* ------------------------------------------------------------------------ *
 * UI bridge (session-scoped)
 * ------------------------------------------------------------------------ */

function sessionView(key) {
  const st = peekState(key)
  if (st === undefined) {
    return {
      session: key,
      enabled: false,
      ledger: { verified: 0, referenced: 0, unverified: 0, converted: 0, crossChecked: 0, charity: 0 },
    }
  }
  return {
    session: key,
    enabled: st.enabled === true,
    ledger: {
      verified: st.ledger.verified,
      referenced: st.ledger.referenced,
      unverified: st.ledger.unverified,
      converted: st.ledger.converted,
      crossChecked: st.ledger.crossChecked,
      charity: st.ledger.charity,
    },
  }
}

function aggregateView() {
  const totals = { verified: 0, referenced: 0, unverified: 0, converted: 0 }
  let sessionCount = 0
  for (const st of sessions.values()) {
    sessionCount = sessionCount + 1
    totals.verified = totals.verified + st.ledger.verified
    totals.referenced = totals.referenced + st.ledger.referenced
    totals.unverified = totals.unverified + st.ledger.unverified
    totals.converted = totals.converted + st.ledger.converted
  }
  return { aggregate: true, sessionCount: sessionCount, totals: totals }
}

function queryOf(rawUrl) {
  const s = String(rawUrl || '')
  const qi = s.indexOf('?')
  const qs = qi >= 0 ? s.slice(qi + 1) : ''
  try {
    return new URLSearchParams(qs)
  } catch (e) {
    return new URLSearchParams('')
  }
}

/** The route is unauthenticated and loopback-bound; keep every input bounded. */
const POST_BODY_LIMIT = 64 * 1024

/** Session keys come from agent sessionIds — generous charset, hard length cap, no control chars. */
function validSessionKey(s) {
  return typeof s === 'string' && s.length >= 1 && s.length <= 200 && !/[\s\u0000-\u001f\u007f]/.test(s)
}

async function routeApi(ctx, req, res) {
  const send = (code, payload) => {
    if (res.writableEnded || res.destroyed) {
      return
    }
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(payload))
  }
  try {
    if (req.method === 'GET') {
      const session = queryOf(req.url).get('session')
      if (session !== null && session !== '' && validSessionKey(String(session))) {
        send(200, sessionView(String(session)))
      } else {
        send(200, aggregateView())
      }
      return
    }
    if (req.method === 'POST') {
      // Same-origin gate: the web GUI is the only legitimate caller. Blocks the
      // cross-site no-cors form POST (its Origin never matches this host).
      const origin = req.headers.origin
      if (origin !== undefined && origin !== '') {
        let originHost = '?'
        try {
          originHost = new URL(String(origin)).host
        } catch (e) {
          originHost = '?'
        }
        if (originHost !== String(req.headers.host || '')) {
          send(403, { error: 'cross-origin request rejected' })
          return
        }
      }
      // Requiring application/json also kills the cross-site no-cors vector:
      // such requests cannot set this content type (no preflight possible).
      const ct = String(req.headers['content-type'] || '').toLowerCase()
      if (ct.indexOf('application/json') !== 0) {
        send(415, { error: 'content-type must be application/json' })
        return
      }
      let body = ''
      let overflow = false
      let settled = false
      req.on('data', (chunk) => {
        if (settled || overflow) {
          return // drain without buffering
        }
        body = body + chunk
        if (body.length > POST_BODY_LIMIT) {
          overflow = true
          body = ''
          settled = true
          send(413, { error: 'request body too large' })
        }
      })
      req.on('end', () => {
        if (settled || overflow) {
          return
        }
        settled = true
        try {
          const a = body ? JSON.parse(body) : {}
          const action = typeof a.action === 'string' ? a.action.trim().toLowerCase() : ''
          const session = typeof a.session === 'string' ? a.session.trim() : ''
          // validate EVERYTHING before touching stateFor — no state creation on
          // invalid input, and no unbounded in-memory session growth
          if (action !== 'on' && action !== 'off' && action !== 'toggle' && action !== 'status') {
            send(400, { error: 'action must be on | off | toggle | status' })
            return
          }
          if (!validSessionKey(session)) {
            send(400, { error: 'invalid session key' })
            return
          }
          if (action === 'status') {
            send(200, sessionView(session)) // read-only: never creates state
            return
          }
          const st = stateFor(session)
          if (action === 'on') {
            st.enabled = true
          } else if (action === 'off') {
            st.enabled = false
          } else {
            st.enabled = !(st.enabled === true)
          }
          markDirty(st)
          send(200, sessionView(session))
        } catch (e) {
          // no detail in the response (fs/path strings must not reach the page)
          console.error('[evidence-gate] api request failed: ' + String(e && e.message ? e.message : e))
          send(400, { error: 'invalid request body' })
        }
      })
      req.on('aborted', () => {
        settled = true
      })
      req.on('error', () => {
        settled = true
      })
      return
    }
    send(405, { error: 'method not allowed' })
  } catch (e) {
    console.error('[evidence-gate] api internal error: ' + String(e && e.message ? e.message : e))
    send(500, { error: 'internal error' })
  }
}

/* ------------------------------------------------------------------------ *
 * plugin
 * ------------------------------------------------------------------------ */

module.exports = {
  name: 'evidence-gate',
  inject: ['tools', 'webServer'],
  apply(ctx) {
    loadStore()
    installExitHook()

    ctx.on('tools/result', function (exec, result) {
      try {
        // record always (durable bounded index): honest actions taken while the
        // gate was OFF must still be cross-checkable after the user turns it ON.
        noteActivity(stateFor(keyOf(exec)), exec, result)
      } catch (e) {
        console.error('[evidence-gate] activity note failed: ' + String(e))
      }
    })
    debugLog('[evidence-gate] tools/result listener attached (arguments + output anchors)')

    const systemPrompt = ctx.get('systemPrompt')
    if (systemPrompt !== undefined) {
      ctx.effect(() =>
        systemPrompt.section({
          name: 'evidence_gate_policy',
          order: 550,
          text(context) {
            const key = keyOf(context)
            const st = peekState(key)
            return st !== undefined && st.enabled === true ? POLICY_TEXT : ''
          },
        }),
      )
      debugLog('[evidence-gate] per-session policy section registered')
    } else {
      console.error('[evidence-gate] systemPrompt service unavailable — section skipped')
    }

    const commands = ctx.get('commands')
    if (commands !== undefined) {
      ctx.effect(() =>
        commands.register({
          name: 'evidence-gate',
          description: '实证门（本会话）：on 开 / off 关 / status 状态 / report 报告',
          input: { hint: 'on | off | status | report' },
          handler(invocation) {
            const key = keyOf(invocation)
            const raw = String((invocation && invocation.rawInput) || '').trim().toLowerCase()
            if (raw === 'on' || raw === '开启') {
              const st = stateFor(key)
              const changed = st.enabled !== true
              st.enabled = true
              markDirty(st)
              return { kind: 'success', text: (changed ? '已开启 ON（本会话 this session），下一个模型步生效 next model step。' : '本就处于开启状态 already ON。') + ' ' + statusText(key) }
            }
            if (raw === 'off' || raw === '关闭' || raw === 'disable') {
              const st = stateFor(key)
              const changed = st.enabled === true
              st.enabled = false
              markDirty(st)
              return { kind: 'success', text: (changed ? '已关闭 OFF（本会话 this session）。' : '本就处于关闭状态 already OFF。') + ' ' + statusText(key) }
            }
            if (raw === 'report' || raw === '报告') {
              return { kind: 'success', text: reportText(key) }
            }
            if (raw === '' || raw === 'status' || raw === '状态') {
              return { kind: 'success', text: statusText(key) + ' | 用法: /evidence-gate on|off|status|report' }
            }
            return { kind: 'error', text: '用法: /evidence-gate on|off|status|report' }
          },
        }),
      )
      debugLog('[evidence-gate] /evidence-gate command registered')
    } else {
      console.error('[evidence-gate] commands service unavailable — slash command skipped')
    }

    ctx.effect(() =>
      ctx.get('tools').register({
        name: 'evidence_gate_switch',
        description:
          'Session switch + report for the evidence gate (PER-SESSION state, persisted across restarts). ' +
          'action: on | off | status | report. Toggle on/off only on explicit user request. Takes effect next model step.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            action: { type: 'string', enum: ['on', 'off', 'status', 'report'], description: 'Switch action' },
          },
          required: ['action'],
        },
        output: {
          schema: { type: 'object', additionalProperties: true },
          render(_args, value) {
            const text = value && typeof value.report === 'string' ? value.report : 'switch result unavailable'
            return [{ type: 'text', text: text }]
          },
        },
        execute(args, exec) {
          const key = keyOf(exec)
          const a = (args && typeof args === 'object') ? args : {}
          const action = typeof a.action === 'string' ? a.action.trim().toLowerCase() : ''
          let changed = false
          let text = ''
          if (action === 'on' || action === '开启') {
            const st = stateFor(key)
            changed = st.enabled !== true
            st.enabled = true
            markDirty(st)
            text = (changed ? '已开启 ON（本会话 this session）' : '本就开启 already ON') + ' — ' + statusText(key)
          } else if (action === 'off' || action === '关闭' || action === 'disable') {
            const st = stateFor(key)
            changed = st.enabled === true
            st.enabled = false
            markDirty(st)
            text = (changed ? '已关闭 OFF（本会话 this session）' : '本就关闭 already OFF') + ' — ' + statusText(key)
          } else if (action === 'report' || action === '报告') {
            text = reportText(key)
          } else if (action === '' || action === 'status' || action === '状态') {
            text = '状态 — ' + statusText(key)
          } else {
            text = "无效 action '" + String(action) + "'. 可用: on | off | status | report."
          }
          const st2 = peekState(key)
          return { enabled: st2 !== undefined && st2.enabled === true, report: text + (changed ? ' | 下一个模型步生效' : '') }
        },
      }),
    )
    debugLog('[evidence-gate] evidence_gate_switch registered (per-session, default OFF)')

    const tools = ctx.get('tools')
    if (tools !== undefined) {
      ctx.effect(() =>
        tools.register({
          name: 'evidence_gate',
          description:
            'Gate for load-bearing conclusions — call once per claim cluster before the final answer. ' +
            'basis: tested/measured/read_directly/prior_verified require evidence (command+output, file+line, measurement); ' +
            'documented/community_practice require source (must be cited); assumption = unverified. ' +
            'First-hand claims are cross-checked against the durable session evidence index. ' +
            'Verdict: 已实证 | 已引用 | 已拦截 (verdict "off" when this session has the gate disabled).',
          parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
              claim: { type: 'string', description: 'The load-bearing claim/conclusion to gate' },
              basis: {
                type: 'string',
                enum: ['tested', 'measured', 'read_directly', 'prior_verified', 'documented', 'community_practice', 'assumption'],
                description: 'Evidence basis of the claim',
              },
              evidence: { type: 'string', description: 'Concrete observation: command + key output, file path + line, measurement' },
              source: { type: 'string', description: 'Named source (URL/doc) for documented/community_practice' },
              next_verification: { type: 'string', description: 'Next verification step (required for assumption)' },
            },
            required: ['claim', 'basis'],
          },
          output: {
            schema: { type: 'object', additionalProperties: true },
            render(_args, value) {
              const text = value && typeof value.report === 'string' ? value.report : 'evidence_gate result unavailable'
              return [{ type: 'text', text: text }]
            },
            presentationMeta(_args, value) {
              return {
                verdict: value && typeof value.verdict === 'string' ? value.verdict : 'unknown',
                reason: value && typeof value.reason === 'string' ? value.reason : '',
                action: value && typeof value.action === 'string' ? value.action : '',
                actionOk: !!(value && value.actionOk),
                actionLabel: value && typeof value.actionLabel === 'string' ? value.actionLabel : '',
                actionDetail: value && typeof value.actionDetail === 'string' ? value.actionDetail : '',
                basis: value && typeof value.basis === 'string' ? value.basis : '',
                evidence: value && typeof value.evidence === 'string' ? value.evidence : '',
                check: value && typeof value.check === 'string' ? value.check : 'skip',
                note: value && typeof value.note === 'string' ? value.note : '',
              }
            },
          },
          presentCall(args) {
            const a = (args && typeof args === 'object') ? args : {}
            const c = typeof a.claim === 'string' ? a.claim : ''
            return {
              card: 'generic',
              title: '🛡 实证门 — ' + (c !== '' ? truncate(c, 60) : '核验结论中'),
              rawInput: { basis: a.basis },
            }
          },
          presentResult(args, result) {
            let verdict = 'unknown'
            if (result && result.meta && typeof result.meta.verdict === 'string') {
              verdict = result.meta.verdict
            } else if (
              result && Array.isArray(result.content) && result.content.length > 0 &&
              result.content[0] && typeof result.content[0].text === 'string'
            ) {
              const t = result.content[0].text
              if (t.indexOf('【已实证') === 0) {
                verdict = 'verified'
              } else if (t.indexOf('【已引用') === 0) {
                verdict = 'referenced'
              } else if (t.indexOf('【已拦截') === 0) {
                verdict = 'unverified'
              } else if (t.indexOf('【无效') === 0) {
                verdict = 'invalid'
              } else if (t.indexOf('【门未开启') === 0) {
                verdict = 'off'
              }
            }
            const a = (args && typeof args === 'object') ? args : {}
            const c = typeof a.claim === 'string' ? truncate(a.claim, 56) : ''
            const badge =
              verdict === 'verified' ? '🟢 已实证' :
              verdict === 'referenced' ? '🔵 已引用' :
              verdict === 'unverified' ? '🟠 已拦截' :
              verdict === 'off' ? '⚪ 门未开启' :
              '⚠ ' + verdict
            return { card: 'generic', title: badge + ' · ' + c }
          },
          execute(args, exec) {
            const key = keyOf(exec)
            const st = stateFor(key)
            if (st.enabled !== true) {
              return {
                verdict: 'off',
                ledger: snapshot(st),
                report: '【门未开启 Gate off】本会话实证门未开启，本次调用不计数。开启方式：/evidence-gate on，或输入框旁的盾形开关（shield toggle）。',
              }
            }
            return gateReport(key, args)
          },
        }),
      )
      debugLog('[evidence-gate] evidence_gate tool registered (per-session gate check inside)')
    } else {
      console.error('[evidence-gate] tools service unavailable — gate tool skipped')
    }

    const webServer = ctx.get('webServer')
    if (webServer !== undefined) {
      ctx.effect(() =>
        webServer.register({
          kind: 'exact',
          path: '/api/dsh-evidence-gate',
          handler(req, res) {
            return routeApi(ctx, req, res)
          },
        }),
      )
      debugLog('[evidence-gate] /api/dsh-evidence-gate route registered (session-scoped)')
    } else {
      console.error('[evidence-gate] webServer service unavailable — UI bridge skipped')
    }

    ctx.effect(() => {
      return () => {
        if (saveTimer !== null) {
          clearTimeout(saveTimer)
          saveTimer = null
        }
        saveNow()
      }
    }, 'evidence-gate-teardown')
  },
}
