'use strict'

/**
 * End-to-end smoke test for dsh-evidence-gate v0.2 with a stubbed Cordis context.
 * Run: node scripts/smoke.js
 * Covers: always-on registrations, per-session gate switch + prompt section
 * provider, gate-off no-count branch, cross-check v2 (own-session paths,
 * tested command correlation, recorded OUTPUT keyword correlation, cross-session
 * fallback, search-result URL hit, existence floor pass, floor-blocked fabricated
 * path), v0.1 regressions (short pattern, normalization, basename, whole-word,
 * env-var expansion, short command verbatim), conversion semantics, junk basis,
 * read-only status, session-scoped UI bridge, and ledger PERSISTENCE across a
 * module reload (simulated restart).
 */

const path = require('path')
const os = require('os')
const fs = require('fs')
const { EventEmitter } = require('events')

const STORE = path.join(os.tmpdir(), 'evidence-gate-smoke-' + Date.now() + '-' + process.pid + '.json')
process.env.EVIDENCE_GATE_STORE = STORE

const pluginPath = require.resolve(path.join(__dirname, '..', 'lib', 'index.js'))
const plugin = require(pluginPath)

let failures = 0
function assert(cond, msg) {
  if (!cond) {
    failures = failures + 1
    console.error('FAIL —', msg)
  } else {
    console.log('ok —', msg)
  }
}

function makeCtx() {
  const defs = {}
  const commandDefs = {}
  const commands = []
  const listeners = []
  const routes = []
  const sections = []
  const ctx = {
    get(name) {
      if (name === 'tools') {
        return { register(d) { defs[d.name] = d; return () => {} } }
      }
      if (name === 'commands') {
        return { register(d) { commands.push(d.name); commandDefs[d.name] = d; return () => {} } }
      }
      if (name === 'webServer') {
        return { register(r) { routes.push(r); return () => {} } }
      }
      if (name === 'systemPrompt') {
        return { section(s) { sections.push(s); return () => {} } }
      }
      return undefined
    },
    on(name, fn) {
      listeners.push([name, fn])
      return () => {}
    },
    effect(fn) {
      const d = fn()
      return typeof d === 'function' ? d : undefined
    },
  }
  return { ctx: ctx, defs: defs, commandDefs: commandDefs, commands: commands, listeners: listeners, routes: routes, sections: sections }
}

function fireResult(listeners, exec, result) {
  for (const [n, f] of listeners) {
    if (n === 'tools/result') {
      f(exec, result)
    }
  }
}

function fakeRes() {
  const res = { code: 0, body: '', writeHead(c) { res.code = c }, end(b) { res.body += b || '' } }
  return res
}

function fakeReq(chunks, method, url, headers) {
  const r = new EventEmitter()
  r.method = method || 'GET'
  r.url = url || '/api/dsh-evidence-gate'
  r.headers = headers || {}
  process.nextTick(() => {
    for (const c of chunks) r.emit('data', c)
    r.emit('end')
  })
  return r
}

async function main() {
  if (typeof plugin.apply !== 'function') {
    throw new Error('bad export shape: ' + typeof plugin.apply)
  }

  const t = makeCtx()
  plugin.apply(t.ctx)

  // -- v0.2 registration semantics: everything registers once at apply
  assert(t.defs['evidence_gate_switch'] !== undefined, 'switch tool registered at apply')
  assert(t.defs['evidence_gate'] !== undefined, 'gate tool registered at apply (per-session check inside)')
  assert(t.sections.length === 1 && typeof t.sections[0].text === 'function', 'policy section registered with per-session text provider')
  assert(t.commands.indexOf('evidence-gate') >= 0, '/evidence-gate command registered')
  assert(t.routes.length === 1 && t.routes[0].path === '/api/dsh-evidence-gate', 'UI bridge route registered')
  assert(typeof t.defs['evidence_gate'].output.presentationMeta === 'function', 'gate declares presentationMeta (badge replay)')

  const session = { sessionId: 'smoke-session' }

  // -- gate OFF: per-session default, no counting, empty section text
  const offCall = await t.defs['evidence_gate'].execute(
    { claim: '未开启会话的调用', basis: 'read_directly', evidence: 'E:/whatever.txt' },
    { agent: session },
  )
  assert(offCall.verdict === 'off' && offCall.report.indexOf('【门未开启 Gate off】') === 0, 'gate-off call returns off verdict without counting (bilingual banner)')
  assert(t.sections[0].text({ agent: session }) === '', 'policy section text is empty while the session gate is OFF')

  // -- per-session switch ON
  const on = await t.defs['evidence_gate_switch'].execute({ action: 'on' }, { agent: session })
  assert(on.report.indexOf('已开启 ON（本会话') >= 0, 'switch on enables the gate for THIS session (bilingual)')
  assert(t.sections[0].text({ agent: session }).indexOf('Evidence-first policy') >= 0, 'policy section text active after enabling')
  const freshProbe = await t.defs['evidence_gate_switch'].execute({ action: 'status' }, { agent: { sessionId: 'fresh-session' } })
  assert(freshProbe.report.indexOf('状态 State=关闭 OFF（本会话') >= 0 && freshProbe.report.indexOf('实证0') >= 0,
    'other sessions stay OFF with zeroed stats (read-only status creates no state)')
  assert(t.sections[0].text({ agent: { sessionId: 'fresh-session' } }) === '', 'other session section text stays empty')

  // -- keyOf fallback: identity-less executions land in the shared bucket (warn-once) and still function
  await t.defs['evidence_gate_switch'].execute({ action: 'on' }, {})
  fireResult(t.listeners, { name: 'read', arguments: { file_path: 'E:/noid/file.txt' } }, {})
  const sharedProbe = await t.defs['evidence_gate'].execute(
    { claim: 'shared bucket probe', basis: 'read_directly', evidence: 'E:/noid/file.txt 已读' },
    {},
  )
  assert(sharedProbe.verdict === 'verified', 'identity-less execution falls back to the shared bucket and cross-checks within it')

  // -- v0.2 acceptance: EMPTY index follows the same rules (no early auto-pass)
  const eIdx = { sessionId: 'empty-idx-session' }
  await t.defs['evidence_gate_switch'].execute({ action: 'on' }, { agent: eIdx })
  const emptyTested = await t.defs['evidence_gate'].execute(
    { claim: '刚开启就声称测过', basis: 'tested', evidence: '完整测试套件全部通过，没有任何失败' },
    { agent: eIdx },
  )
  assert(emptyTested.verdict === 'unverified', 'empty index: uncorrelated tested claim is still downgraded (no early auto-pass)')
  const emptyFloor = await t.defs['evidence_gate'].execute(
    { claim: '空索引但路径真实', basis: 'read_directly', evidence: path.join(__dirname, '..', 'package.json') + ' 存在' },
    { agent: eIdx },
  )
  assert(emptyFloor.verdict === 'verified' && emptyFloor.check === 'weak',
    'empty index: existence floor still rescues the honest claim')

  // -- populate the evidence index (arguments + output anchors)
  fireResult(t.listeners, { name: 'read', arguments: { file_path: 'E:/Agent/proj/README.md' }, agent: session }, {})
  fireResult(t.listeners, { name: 'grep', arguments: { pattern: 'index' }, agent: session }, {})
  fireResult(t.listeners, { name: 'pwsh', arguments: { command: 'Get-ChildItem' }, agent: session }, {})

  // -- v0.1 regression: short recorded pattern must NOT satisfy a long claimed path,
  //    and the fabricated path does not exist -> still blocked (existence floor must not rescue it)
  const shortPattern = await t.defs['evidence_gate'].execute(
    { claim: 'read index-page source', basis: 'read_directly', evidence: 'C:/proj/src/index-page.md 全文' },
    { agent: session },
  )
  assert(shortPattern.verdict === 'unverified' && shortPattern.report.indexOf('交叉核验失败') >= 0,
    'fabricated path stays blocked (short-pattern guard + nonexistent file)')

  // -- v0.1 regression: backslash + :line normalization matches the forward-slash read
  const norm = await t.defs['evidence_gate'].execute(
    { claim: 'README exists at project root', basis: 'read_directly', evidence: 'E:\\Agent\\proj\\README.md:12 有标题' },
    { agent: session },
  )
  assert(norm.verdict === 'verified' && norm.report.indexOf('交叉核验✓') >= 0,
    'backslash + :line claim normalized to match the recorded read')

  // -- v0.1 regression: basename fallback for same-file-different-directory
  const base = await t.defs['evidence_gate'].execute(
    { claim: 'README read from another cwd spelling', basis: 'prior_verified', evidence: 'D:/mirror/docs/README.md' },
    { agent: session },
  )
  assert(base.verdict === 'verified', 'basename fallback matches same file across directories')

  // -- v0.2: EXISTENCE FLOOR — real path, never recorded (compaction/restart class) → 采信 pass
  const realPath = path.join(__dirname, '..', 'scripts', 'smoke.js')
  const floorPass = await t.defs['evidence_gate'].execute(
    { claim: 'smoke script exists and was reviewed', basis: 'read_directly', evidence: realPath + ' 的断言已复核' },
    { agent: session },
  )
  assert(floorPass.verdict === 'verified' && floorPass.check === 'weak' && floorPass.report.indexOf('按指针采信') >= 0,
    'unindexed but existing path passes with weak/采信 instead of false-blocking')

  // -- v0.1 regression: uncorrelated "tested" claim (Chinese-only evidence, no anchors) is downgraded
  const weak = await t.defs['evidence_gate'].execute(
    { claim: '完整测试套件全部通过', basis: 'tested', evidence: '完整测试套件全部通过，没有任何失败' },
    { agent: session },
  )
  assert(weak.verdict === 'unverified', 'tested claim with no correlating command is downgraded')

  // -- honest tested claim correlates via recorded command
  fireResult(t.listeners, { name: 'pwsh', arguments: { command: 'pnpm test' }, agent: session }, {})
  const honest = await t.defs['evidence_gate'].execute(
    { claim: '测试套件通过', basis: 'tested', evidence: 'pnpm test → 12 passed' },
    { agent: session },
  )
  assert(honest.verdict === 'verified' && honest.report.indexOf('证据与已记录命令关联') >= 0,
    'honest tested claim correlates with the recorded command')

  // -- v0.2: recorded OUTPUT keyword correlation ("pnpm build → BUNDLE OK")
  fireResult(t.listeners, { name: 'pwsh', arguments: { command: 'node build.js' }, agent: session },
    { content: [{ type: 'text', text: 'BUNDLE OK · 42 modules emitted' }] })
  const outHit = await t.defs['evidence_gate'].execute(
    { claim: '构建产物已生成', basis: 'tested', evidence: '构建成功 BUNDLE OK' },
    { agent: session },
  )
  assert(outHit.verdict === 'verified' && outHit.report.indexOf('命中已记录输出关键词') >= 0,
    'output keyword in evidence hits the recorded tool OUTPUT')

  // -- conversion semantics: referenced closure does NOT count, verified does
  const pendingClaim = 'conv probe claim about widget sizing'
  const blocked = await t.defs['evidence_gate'].execute(
    { claim: pendingClaim, basis: 'assumption', next_verification: 'measure it' },
    { agent: session },
  )
  assert(blocked.verdict === 'unverified' && blocked.report.indexOf('已拦截') >= 0, 'assumption blocked (pending)')
  const refClose = await t.defs['evidence_gate'].execute(
    { claim: pendingClaim, basis: 'documented', source: 'https://example.com/spec' },
    { agent: session },
  )
  assert(refClose.verdict === 'referenced', 'referenced closure accepted')
  const rep1 = await t.defs['evidence_gate_switch'].execute({ action: 'report' }, { agent: session })
  assert(rep1.report.indexOf('转化 converted 0') >= 0, 'referenced closure does NOT count as converted')

  fireResult(t.listeners, { name: 'read', arguments: { file_path: 'C:/fake/never.txt' }, agent: session }, {})
  const conv = await t.defs['evidence_gate'].execute(
    { claim: pendingClaim, basis: 'read_directly', evidence: 'C:/fake/never.txt' },
    { agent: session },
  )
  assert(conv.verdict === 'verified', 're-gate after real verification passes')
  const rep2 = await t.defs['evidence_gate_switch'].execute({ action: 'report' }, { agent: session })
  assert(rep2.report.indexOf('转化 converted 1') >= 0, 'VERIFIED closure counts as converted')
  assert(rep2.report.indexOf('已拦截') >= 0 && rep2.report.indexOf('已实证') >= 0, 'report groups by verdict (bilingual sections)')
  assert(rep2.report.indexOf('采信 floor-passed 1') >= 0, 'report counts the existence-floor pass as 采信')

  // -- v0.2: cross-session fallback (subagent did the read, parent claims it)
  const sSub = { sessionId: 'sub-agent-1' }
  fireResult(t.listeners, { name: 'read', arguments: { file_path: 'E:/Agent/proj/design/notes/plan-file.md' }, agent: sSub }, {})
  const crossHit = await t.defs['evidence_gate'].execute(
    { claim: '子代理已核验计划文件', basis: 'prior_verified', evidence: 'E:/Agent/proj/design/notes/plan-file.md 内容已核对' },
    { agent: session },
  )
  assert(crossHit.verdict === 'verified' && crossHit.report.indexOf('其他会话') >= 0,
    'evidence recorded in ANOTHER session (subagent) corroborates the claim')

  // -- v0.2: URL cited from search RESULTS counts as corroboration
  fireResult(t.listeners, { name: 'web_search', arguments: { queries: ['dsh docs'] }, agent: session },
    { content: [{ type: 'text', text: '1. DSH guide — https://docs.example.com/dsh/guide' }] })
  const urlHit = await t.defs['evidence_gate'].execute(
    { claim: '官方指南说明用法', basis: 'documented', source: 'https://docs.example.com/dsh/guide' },
    { agent: session },
  )
  assert(urlHit.verdict === 'referenced' && urlHit.report.indexOf('搜索/抓取记录') >= 0,
    'cited URL found in recorded search results → corroborated reference')
  const urlWeak = await t.defs['evidence_gate'].execute(
    { claim: '转载某规范', basis: 'community_practice', source: 'https://never-fetched.example.com/x' },
    { agent: session },
  )
  assert(urlWeak.verdict === 'referenced' && urlWeak.check === 'weak', 'unfetched URL stays referable with a weak note (no false kill)')

  // -- junk basis must not pollute the by-basis report
  const junk = await t.defs['evidence_gate'].execute(
    { claim: 'junk basis probe', basis: 'constructor', evidence: 'x' },
    { agent: session },
  )
  assert(junk.verdict === 'invalid' && junk.report.indexOf('【无效调用 Invalid】') === 0, 'junk basis rejected with bilingual invalid banner')
  const rep3 = await t.defs['evidence_gate_switch'].execute({ action: 'report' }, { agent: session })
  assert(rep3.report.indexOf('constructor=') < 0 && rep3.report.indexOf('__proto__') < 0,
    'junk bases do not pollute the by-basis tally')

  // -- second session: isolated switch + its own regressions
  const s2 = { sessionId: 'smoke-session-2' }
  await t.defs['evidence_gate_switch'].execute({ action: 'on' }, { agent: s2 })
  fireResult(t.listeners, { name: 'pwsh', arguments: { command: 'Get-ChildItem "$env:USERPROFILE\\Downloads" -File' }, agent: s2 }, {})
  const envHit = await t.defs['evidence_gate'].execute(
    { claim: 'Downloads folder listed', basis: 'read_directly', evidence: 'C:\\Users\\18702\\Downloads 目录已列出' },
    { agent: s2 },
  )
  assert(envHit.verdict === 'verified' && envHit.report.indexOf('交叉核验✓') >= 0,
    'env-var command path expands to match the cited literal path')

  fireResult(t.listeners, { name: 'pwsh', arguments: { command: 'dir' }, agent: s2 }, {})
  const dirClaim = await t.defs['evidence_gate'].execute(
    { claim: '目录非空确认', basis: 'tested', evidence: '用 dir 列出目录确认非空' },
    { agent: s2 },
  )
  assert(dirClaim.verdict === 'verified' && dirClaim.report.indexOf('证据引用了已记录命令') >= 0,
    'short recorded command cited verbatim in evidence counts as correlation')

  const adv = await t.defs['evidence_gate'].execute(
    { claim: '目录条目已确认', basis: 'tested', evidence: '检查了 directory 列表内容' },
    { agent: s2 },
  )
  assert(adv.verdict === 'unverified', 'whole-word rule: "directory" does not satisfy recorded "dir"')

  // -- session-scoped UI bridge
  const res1 = fakeRes()
  await t.routes[0].handler(fakeReq([], 'GET', '/api/dsh-evidence-gate?session=smoke-session'), res1)
  await new Promise((r) => setTimeout(r, 20))
  const status1 = JSON.parse(res1.body)
  assert(status1.enabled === true && status1.session === 'smoke-session' && typeof status1.ledger === 'object' && status1.ledger.verified >= 3,
    'UI bridge GET ?session= returns that session view')

  const res2 = fakeRes()
  await t.routes[0].handler(fakeReq(['{"action":"off","session":"smoke-session"}'], 'POST', '/api/dsh-evidence-gate', { 'content-type': 'application/json' }), res2)
  await new Promise((r) => setTimeout(r, 20))
  assert(JSON.parse(res2.body).enabled === false, 'UI bridge POST off disables the gate for that session')
  const res3 = fakeRes()
  await t.routes[0].handler(fakeReq(['{"action":"on","session":"smoke-session"}'], 'POST', '/api/dsh-evidence-gate', { 'content-type': 'application/json' }), res3)
  await new Promise((r) => setTimeout(r, 20))
  assert(JSON.parse(res3.body).enabled === true, 'UI bridge POST on re-enables the gate for that session')
  const res4 = fakeRes()
  await t.routes[0].handler(fakeReq(['{"action":"on"}'], 'POST', '/api/dsh-evidence-gate', { 'content-type': 'application/json' }), res4)
  await new Promise((r) => setTimeout(r, 20))
  assert(res4.code === 400, 'UI bridge POST without session is rejected (per-session switch)')
  const res5 = fakeRes()
  await t.routes[0].handler(fakeReq([], 'GET', '/api/dsh-evidence-gate'), res5)
  await new Promise((r) => setTimeout(r, 20))
  const agg = JSON.parse(res5.body)
  assert(agg.aggregate === true && typeof agg.totals === 'object', 'aggregate GET kept for debugging')

  // -- route hardening: bounded, same-origin, JSON-only, read-only status, no leaks
  const resBadCt = fakeRes()
  await t.routes[0].handler(fakeReq(['{"action":"on","session":"smoke-session"}'], 'POST', '/api/dsh-evidence-gate', { 'content-type': 'text/plain' }), resBadCt)
  await new Promise((r) => setTimeout(r, 20))
  assert(resBadCt.code === 415, 'non-JSON content-type rejected (kills the cross-site no-cors vector)')

  const resEvil = fakeRes()
  await t.routes[0].handler(fakeReq(['{"action":"on","session":"smoke-session"}'], 'POST', '/api/dsh-evidence-gate', { 'content-type': 'application/json', origin: 'https://evil.example' }), resEvil)
  await new Promise((r) => setTimeout(r, 20))
  assert(resEvil.code === 403, 'cross-origin POST rejected (Origin host mismatch)')

  const resBig = fakeRes()
  await t.routes[0].handler(fakeReq([JSON.stringify({ action: 'on', session: 'smoke-session', pad: 'x'.repeat(80 * 1024) })], 'POST', '/api/dsh-evidence-gate', { 'content-type': 'application/json' }), resBig)
  await new Promise((r) => setTimeout(r, 20))
  assert(resBig.code === 413, 'oversized body rejected at the 64KB cap (no OOM buffering)')

  const resBadAction = fakeRes()
  await t.routes[0].handler(fakeReq(['{"action":"explode","session":"never-created-probe"}'], 'POST', '/api/dsh-evidence-gate', { 'content-type': 'application/json' }), resBadAction)
  await new Promise((r) => setTimeout(r, 20))
  assert(resBadAction.code === 400, 'invalid action rejected BEFORE state creation')

  const resBadSession = fakeRes()
  await t.routes[0].handler(fakeReq(['{"action":"on","session":"bad key\\n"}'], 'POST', '/api/dsh-evidence-gate', { 'content-type': 'application/json' }), resBadSession)
  await new Promise((r) => setTimeout(r, 20))
  assert(resBadSession.code === 400, 'session key with whitespace/control characters rejected')

  const resLeak = fakeRes()
  await t.routes[0].handler(fakeReq(['{oops'], 'POST', '/api/dsh-evidence-gate', { 'content-type': 'application/json' }), resLeak)
  await new Promise((r) => setTimeout(r, 20))
  assert(resLeak.code === 400 && resLeak.body.indexOf('E:') < 0 && resLeak.body.indexOf(':\\') < 0 && resLeak.body.indexOf('dsh-evidence-gate') < 0,
    'malformed JSON → generic 400 without path leakage')

  const resAbort = fakeRes()
  const abReq = new EventEmitter()
  abReq.method = 'POST'
  abReq.url = '/api/dsh-evidence-gate'
  abReq.headers = { 'content-type': 'application/json' }
  const abDone = t.routes[0].handler(abReq, resAbort)
  abReq.emit('data', '{"action":"on",')
  abReq.emit('aborted')
  await abDone
  await new Promise((r) => setTimeout(r, 20))
  assert(resAbort.code === 0 && resAbort.body === '', 'aborted request writes no response and buffers nothing further')

  const offState = await t.defs['evidence_gate_switch'].execute({ action: 'status' }, { agent: { sessionId: 'fresh-session' } })
  assert(offState.report.indexOf('State=关闭 OFF') >= 0, 'fresh session remains OFF after all main-session activity')

  // -- /evidence-gate command handler (bilingual texts, Chinese aliases)
  const cmdDefs = t.commandDefs
  assert(cmdDefs !== undefined && cmdDefs['evidence-gate'] !== undefined, 'command definition captured by stub')
  const cmdSession = { sessionId: 'cmd-session' }
  const cOn = cmdDefs['evidence-gate'].handler({ agent: cmdSession, rawInput: '开启' })
  assert(cOn.kind === 'success' && cOn.text.indexOf('已开启 ON（本会话') >= 0, 'command on (Chinese alias) enables the session')
  const cStatus = cmdDefs['evidence-gate'].handler({ agent: cmdSession, rawInput: '状态' })
  assert(cStatus.kind === 'success' && cStatus.text.indexOf('State=开启 ON') >= 0, 'command status reflects the session state')
  const cReport = cmdDefs['evidence-gate'].handler({ agent: cmdSession, rawInput: '报告' })
  assert(cReport.kind === 'success' && cReport.text.indexOf('Evidence-gate report') >= 0, 'command report renders the bilingual header')
  const cOff = cmdDefs['evidence-gate'].handler({ agent: cmdSession, rawInput: 'off' })
  assert(cOff.kind === 'success' && cOff.text.indexOf('已关闭 OFF（本会话') >= 0, 'command off disables the session')
  const cBad = cmdDefs['evidence-gate'].handler({ agent: cmdSession, rawInput: 'nonsense' })
  assert(cBad.kind === 'error', 'command rejects unknown input')

  // -- PERSISTENCE: enabled state + ledger survive a module reload (simulated restart)
  const persistAgent = { sessionId: 'persist-session' }
  await t.defs['evidence_gate_switch'].execute({ action: 'on' }, { agent: persistAgent })
  fireResult(t.listeners, { name: 'read', arguments: { file_path: 'E:/persist/data-file.md' }, agent: persistAgent },
    { content: [{ type: 'text', text: 'persist probe output token' }] })
  const pv = await t.defs['evidence_gate'].execute(
    { claim: '持久化探针', basis: 'read_directly', evidence: 'E:/persist/data-file.md 已读取' },
    { agent: persistAgent },
  )
  assert(pv.verdict === 'verified', 'persist-session gate call verified before reload')

  await new Promise((r) => setTimeout(r, 1800)) // let the debounced save fire
  assert(fs.existsSync(STORE), 'store file written after debounce')

  delete require.cache[pluginPath]
  const plugin2 = require(pluginPath)
  const t2 = makeCtx()
  plugin2.apply(t2.ctx)

  const restored = await t2.defs['evidence_gate_switch'].execute({ action: 'status' }, { agent: persistAgent })
  assert(restored.report.indexOf('状态 State=开启 ON（本会话') >= 0, 'per-session ON state restored from store after reload')
  assert(restored.report.indexOf('实证1') >= 0, 'ledger counts restored from store after reload')
  assert(t2.sections[0].text({ agent: persistAgent }).indexOf('Evidence-first policy') >= 0,
    'policy section active for restored session immediately after restart')
  const restoredGate = await t2.defs['evidence_gate'].execute(
    { claim: '持久化探针续', basis: 'read_directly', evidence: 'E:/persist/data-file.md 再次核对' },
    { agent: persistAgent },
  )
  assert(restoredGate.verdict === 'verified' && restoredGate.report.indexOf('交叉核验✓') >= 0,
    'evidence index survives restart (cross-check hits restored entries)')
  const unknown = await t2.defs['evidence_gate_switch'].execute({ action: 'status' }, { agent: { sessionId: 'never-seen' } })
  assert(unknown.report.indexOf('State=关闭 OFF') >= 0, 'unknown session starts OFF after restart')

  try { fs.unlinkSync(STORE) } catch (e) { /* best effort */ }

  console.log(failures > 0 ? 'SMOKE FAILED (' + failures + ')' : 'SMOKE PASSED')
  if (failures > 0) {
    process.exitCode = 1
  }
}

main().catch((e) => {
  console.error('SMOKE ERROR:', (e && e.stack) || e)
  process.exit(1)
})
