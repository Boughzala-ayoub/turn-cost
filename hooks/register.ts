import type { EngineInterface, On, RenderElement, TurnUsage } from 'claude-code'

// One finished turn's tally. Keyed by durationMs because that is the one
// value the TurnDuration line and the turn.complete event share.
type Turn = { usd: number; h5: number; inp: number; cache: number; out: number; agents: Set<string>; drawn?: boolean; rough?: boolean }

const K = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : `${n}`)
const dur = (ms: number) => {
  const s = Math.round(ms / 1000)
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
}
const add = (t: Turn, u: TurnUsage | undefined) => {
  if (!u) return
  t.inp += u.input_tokens + u.cache_creation_input_tokens // fresh input + cache writes
  t.cache += u.cache_read_input_tokens
  t.out += u.output_tokens
}

// The five-hour % is account-wide: a raw start/end delta also charges this turn with
// every other session's spend, and with whatever ran since the last API reply (the
// reading turn.start sees). So the turn is charged its own dollars times k, the
// account's five-hour % per dollar, measured over this window. Every session running
// this mod keeps its cumulative spend in <TEMP>/claude-turn-cost/<id>.json; the sum
// is the account's spend.
// ponytail: usage outside Claude Code (claude.ai) or in sessions without this mod
// inflates k; files are never pruned (the fs API has no delete), clear the dir by hand
// if it ever grows large.
let k: number | undefined // five-hour % per dollar
let kPoints = 0 // how many five-hour points k was measured over
let base: { p: number; resetsAt?: string; spend: Record<string, number> } | null = null
async function sample($: EngineInterface) {
  const u = await $.session.usage()
  const w = u.rateLimits.find(r => r.kind === 'five_hour')
  if (!w) return
  const dir = `${(await $.env.get('TEMP')) ?? (await $.env.get('TMPDIR')) ?? '/tmp'}/claude-turn-cost`
  await $.fs.write(`${dir}/${await $.session.id()}.json`, JSON.stringify(u.cost?.usd ?? 0))
  const spend: Record<string, number> = {}
  for (const f of await $.fs.list(dir)) {
    try { spend[f.name] = Number(JSON.parse(await $.fs.read(`${dir}/${f.name}`))) || 0 } catch {} // mid-write: skip
  }
  const moved = (a?: string, b?: string) => Math.abs(Date.parse(a ?? '') - Date.parse(b ?? '')) > 60_000
  if (!base || w.percentUsed < base.p || moved(w.resetsAt, base.resetsAt)) { base = { p: w.percentUsed, resetsAt: w.resetsAt, spend }; return }
  const dp = w.percentUsed - base.p
  let dAll = 0
  for (const [s, v] of Object.entries(spend)) dAll += v - (base.spend[s] ?? 0)
  // ponytail: percentUsed moves in whole points, so k from under 5 of them is rough (shown
  // with ~) and only stands in until one measured over more; from 5 on (±20%) it is kept
  // for the next window, and sharpens as this one fills
  if (dAll > 0 && dp >= 1 && (dp >= 5 || dp >= kPoints)) {
    k = dp / dAll; kPoints = dp
    if (dp >= 5) await $.store.set('k', k)
  }
}

export function register(on: On) {
  let cur: Turn | null = null // the main-loop turn now running
  let last: Turn | null = null // the one that finished most recently
  let usdAtStart = 0
  let h5AtStart = 0 // five_hour window percentUsed when the turn began
  const fiveHour = (u: { rateLimits: { kind: string; percentUsed: number }[] }) => u.rateLimits.find(r => r.kind === 'five_hour')?.percentUsed ?? 0
  const byDuration = new Map<number, Turn>()

  // After every model reply (main loop and subagents): the reading is fresh then.
  on('turn.step', async function* ($, e, next) {
    const r = yield* next(e)
    sample($).catch(() => {})
    return r
  })

  on('turn.start', async ($, e, next) => {
    cur = { usd: 0, h5: 0, inp: 0, cache: 0, out: 0, agents: new Set() }
    const u = await $.session.usage()
    usdAtStart = u.cost?.usd ?? 0
    h5AtStart = fiveHour(u)
    if (k === undefined) { const s = await $.store.get('k'); if (typeof s === 'number') { k = s; kPoints = 5 } }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId) {
      // a subagent's run: fold it into the main turn it belongs to, or the last
      // one if it finished after its parent (background agents do)
      const t = cur ?? last
      if (t) { add(t, e.usage); t.agents.add(e.agentId); $.ui.invalidate('ui.render') }
      return next(e)
    }
    const t = cur ?? { usd: 0, h5: 0, inp: 0, cache: 0, out: 0, agents: new Set<string>() }
    add(t, e.usage)
    const u = await $.session.usage()
    t.usd = Math.max(0, (u.cost?.usd ?? 0) - usdAtStart)
    // no k yet (first window ever): the raw account-wide delta, negative only if the window reset mid-turn
    t.h5 = k === undefined ? fiveHour(u) - h5AtStart : t.usd * k
    t.rough = kPoints < 5
    byDuration.set(e.durationMs, t)
    if (byDuration.size > 50) byDuration.delete(byDuration.keys().next().value!)
    last = t; cur = null
    $.ui.invalidate('ui.render') // the closing line may have drawn before this ran
    return next(e)
  })

  // The transcript line that closes a turn (`Baked for 41s`): redraw it with the
  // tally appended, dim like the original. Anything unknown falls through.
  on('ui.render', { component: 'TurnDuration' }, ($, e, next) => {
    if (e.surface !== 'terminal') return next(e)
    // The line's duration can disagree with turn.complete's (seen on the turn a finished
    // background agent's notification starts: the line said 3m 3s, the event did not), so a
    // miss falls back to the newest tally no line has claimed yet, and keys it for redraws.
    let t = byDuration.get(e.props.durationMs)
    if (!t && last && !last.drawn) { t = last; byDuration.set(e.props.durationMs, t) }
    if (!t) return next(e)
    t.drawn = true
    const { Text } = $.ui.resolve(e)
    const bits = [`$${t.usd.toFixed(2)}`, `in ${K(t.inp)} out ${K(t.out)} cache ${K(t.cache)}`, `5h ${t.rough ? '~' : ''}+${Number.isInteger(t.h5) ? t.h5 : t.h5.toFixed(t.h5 < 1 ? 2 : 1)}%`]
    if (t.agents.size) bits.push(`${t.agents.size} agent${t.agents.size > 1 ? 's' : ''}`)
    return h(Text, { dimColor: true }, `${e.props.word} for ${dur(e.props.durationMs)} · ${bits.join(' · ')}`) as RenderElement
  })
}
