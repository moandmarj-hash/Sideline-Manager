import React, { useEffect, useMemo, useRef, useState } from 'react'

const STORAGE_KEY = 'sideline-manager-v4-3-1-mobile-fix'
const DEFAULT_WHITE = ['Ikaia', 'Daniel', 'Hazel', 'Leon', 'Caleb', 'Seb']
const DEFAULT_RED = ['Xavier', 'Marcus', 'Manaia', 'Owen', 'Noah', 'Isaac', 'Andre', 'Te Manawa', 'Ted']
const DEFAULT_STATE = {
  showLanding: true,
  gameDate: new Date().toISOString().slice(0, 10),
  halfMinutes: 25,
  intervalMinutes: 5,
  totalOnField: 9,
  whiteSquadPlayers: DEFAULT_WHITE,
  redSquadPlayers: DEFAULT_RED,
  absentWhite: [], absentRed: [], unavailableWhite: [], unavailableRed: [], returningWhite: [], returningRed: [],
  currentInterval: 0, elapsedSeconds: 0, timerRunning: false, gameHistory: [], overrides: { white: {}, red: {} },
}

function asArray(v, f = []) { return Array.isArray(v) ? v : f }
function asObject(v, f = {}) { return v && typeof v === 'object' && !Array.isArray(v) ? v : f }
function uniq(list) { return Array.from(new Set(asArray(list).filter(Boolean))) }
function todayIso() { return new Date().toISOString().slice(0, 10) }
function nextWeekIso(dateText) { const d = new Date(`${dateText}T12:00:00`); if (Number.isNaN(d.getTime())) return todayIso(); d.setDate(d.getDate()+7); return d.toISOString().slice(0,10) }
function formatTime(seconds) { const s=Math.max(0,Math.floor(Number(seconds)||0)); const m=Math.floor(s/60); return `${String(m).padStart(2,'0')}:${String(s%60).padStart(2,'0')}` }
function halfLabel(h) { return Number(h)===1 ? '1st Half' : '2nd Half' }

function loadState() {
  if (typeof window === 'undefined') return DEFAULT_STATE
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_STATE
    const parsed = JSON.parse(raw)
    const overrides = asObject(parsed.overrides, {})
    return {
      ...DEFAULT_STATE, ...parsed,
      whiteSquadPlayers: uniq(parsed.whiteSquadPlayers || DEFAULT_WHITE),
      redSquadPlayers: uniq(parsed.redSquadPlayers || DEFAULT_RED),
      absentWhite: uniq(parsed.absentWhite), absentRed: uniq(parsed.absentRed), unavailableWhite: uniq(parsed.unavailableWhite), unavailableRed: uniq(parsed.unavailableRed), returningWhite: uniq(parsed.returningWhite), returningRed: uniq(parsed.returningRed),
      gameHistory: asArray(parsed.gameHistory, []), overrides: { white: asObject(overrides.white, {}), red: asObject(overrides.red, {}) },
      currentInterval: Number.isFinite(parsed.currentInterval) ? parsed.currentInterval : 0,
      elapsedSeconds: Number.isFinite(parsed.elapsedSeconds) ? parsed.elapsedSeconds : 0,
      timerRunning: Boolean(parsed.timerRunning), showLanding: typeof parsed.showLanding === 'boolean' ? parsed.showLanding : true,
      gameDate: typeof parsed.gameDate === 'string' && parsed.gameDate ? parsed.gameDate : todayIso(),
    }
  } catch { return DEFAULT_STATE }
}

function previousMinutesMap(record) {
  const out = {}
  asArray(record?.summary).forEach((item) => { if (item && typeof item.name === 'string') out[item.name] = Number(item.minutes) || 0 })
  return out
}
function normalizeOverride(v) { const s=asObject(v,{}); return { forceOn: uniq(s.forceOn), forceOff: uniq(s.forceOff) } }
function mergeOverride(existing, updates) { const c=normalizeOverride(existing), u=normalizeOverride(updates); const next={ forceOn: uniq([...c.forceOn,...u.forceOn]), forceOff: uniq([...c.forceOff,...u.forceOff])}; next.forceOn=next.forceOn.filter((n)=>!next.forceOff.includes(n)); return next }

function chooseDynamicSplit({ totalOnField, whiteCount, redCount, remainingWhiteTarget, remainingRedTarget, remainingBlocks, minWhiteSpots = 0, minRedSpots = 0, maxWhiteSpots = Infinity, maxRedSpots = Infinity }) {
  const all=[]
  for (let w=0; w<=Math.min(totalOnField, whiteCount); w+=1) {
    const r=totalOnField-w
    if (r>=0 && r<=redCount && w>=minWhiteSpots && r>=minRedSpots && w<=maxWhiteSpots && r<=maxRedSpots) all.push({whiteSpots:w, redSpots:r})
  }
  if (!all.length) return { whiteSpots: Math.max(0, Math.min(totalOnField, whiteCount)), redSpots: Math.max(0, Math.min(totalOnField, redCount)) }
  const preferred = all.filter((x)=>x.redSpots>x.whiteSpots)
  const pool = preferred.length ? preferred : all
  const iw = remainingWhiteTarget / Math.max(1, remainingBlocks)
  const ir = remainingRedTarget / Math.max(1, remainingBlocks)
  let best=pool[0], bestScore=null
  pool.forEach((c)=>{
    const score=[Math.abs(c.whiteSpots-iw)+Math.abs(c.redSpots-ir), Math.abs(c.whiteSpots-Math.round(iw)), -(c.redSpots-c.whiteSpots), c.whiteSpots]
    if (!bestScore || score[0] < bestScore[0] || (score[0]===bestScore[0] && (score[1] < bestScore[1] || (score[1]===bestScore[1] && (score[2] < bestScore[2] || (score[2]===bestScore[2] && score[3] < bestScore[3])))))) { best=c; bestScore=score }
  })
  return best
}

function pickPlayers(players, spots, equityScore, currentBlocks, lastPlayed, intervalIndex, cursor, override) {
  const safe=asArray(players)
  if (!safe.length || spots<=0) return { selected: [], nextCursor: 0 }
  const safeOverride=normalizeOverride(override)
  const forceOff=new Set(safeOverride.forceOff.filter((n)=>safe.includes(n)))
  const forceOn=safe.filter((n)=>safeOverride.forceOn.includes(n) && !forceOff.has(n)).slice(0, spots)
  const rest=safe.filter((n)=>!forceOn.includes(n) && !forceOff.has(n)).map((name)=>({ name, idx:safe.indexOf(name), equity:Number(equityScore[name])||0, currentBlocks:Number(currentBlocks[name])||0, last:Number(lastPlayed[name])||-999, ring:(safe.indexOf(name)-cursor+safe.length)%safe.length }))
    .sort((a,b)=> a.equity!==b.equity ? a.equity-b.equity : a.currentBlocks!==b.currentBlocks ? a.currentBlocks-b.currentBlocks : a.last!==b.last ? a.last-b.last : a.ring-b.ring)
    .slice(0, Math.max(0, spots-forceOn.length)).sort((a,b)=>a.idx-b.idx).map((x)=>x.name)
  const selected=[...forceOn,...rest].sort((a,b)=>safe.indexOf(a)-safe.indexOf(b))
  const nextCursor=selected.length ? (safe.indexOf(selected[selected.length-1])+1)%safe.length : cursor
  selected.forEach((name)=>{ equityScore[name]=(Number(equityScore[name])||0)+1; currentBlocks[name]=(Number(currentBlocks[name])||0)+1; lastPlayed[name]=intervalIndex })
  return { selected, nextCursor }
}
function diff(prev, cur) { const a=asArray(prev), b=asArray(cur); if(!a.length) return { incoming:b, outgoing:[], hasPrevious:false }; return { incoming:b.filter((n)=>!a.includes(n)), outgoing:a.filter((n)=>!b.includes(n)), hasPrevious:true } }

function buildSchedule({ whitePlayers, redPlayers, totalOnField, intervals, intervalMinutes, halfMinutes, priorMinutes, overrides, completedIntervals }) {
  const allPlayers=[...asArray(whitePlayers), ...asArray(redPlayers)]
  const totalPlayers=allPlayers.length
  const totalSlots=intervals*totalOnField
  const targetSlotsPerPlayer=totalPlayers ? totalSlots/totalPlayers : 0
  const targetMinutesPerPlayer=targetSlotsPerPlayer*intervalMinutes
  const targetWhiteSlots=targetSlotsPerPlayer*asArray(whitePlayers).length
  const targetRedSlots=targetSlotsPerPlayer*asArray(redPlayers).length
  const equityScore={}, currentBlocks={}, lastPlayed={}
  allPlayers.forEach((name)=>{ equityScore[name]=(Number(priorMinutes[name])||0)/Math.max(1, intervalMinutes); currentBlocks[name]=0; lastPlayed[name]=-999 })
  let assignedWhite=0, assignedRed=0, cursorWhite=0, cursorRed=0, prevWhite=null, prevRed=null
  const rows=[]
  for(let i=0;i<intervals;i+=1){
    const whiteOverride=normalizeOverride(asObject(asObject(overrides).white,{})[String(i)])
    const redOverride=normalizeOverride(asObject(asObject(overrides).red,{})[String(i)])
    const whiteCount=asArray(whitePlayers).length
    const redCount=asArray(redPlayers).length
    const minWhiteSpots=Math.min(whiteCount, whiteOverride.forceOn.length)
    const minRedSpots=Math.min(redCount, redOverride.forceOn.length)
    const maxWhiteSpots=Math.max(0, whiteCount - whiteOverride.forceOff.filter((n)=>asArray(whitePlayers).includes(n)).length)
    const maxRedSpots=Math.max(0, redCount - redOverride.forceOff.filter((n)=>asArray(redPlayers).includes(n)).length)
    const split=chooseDynamicSplit({ totalOnField, whiteCount, redCount, remainingWhiteTarget:Math.max(0,targetWhiteSlots-assignedWhite), remainingRedTarget:Math.max(0,targetRedSlots-assignedRed), remainingBlocks:intervals-i, minWhiteSpots, minRedSpots, maxWhiteSpots, maxRedSpots })
    const start=i*intervalMinutes, end=start+intervalMinutes, half=start<halfMinutes?1:2
    const whitePick=pickPlayers(whitePlayers, split.whiteSpots, equityScore, currentBlocks, lastPlayed, i, cursorWhite, whiteOverride)
    const redPick=pickPlayers(redPlayers, split.redSpots, equityScore, currentBlocks, lastPlayed, i, cursorRed, redOverride)
    cursorWhite=whitePick.nextCursor; cursorRed=redPick.nextCursor; assignedWhite+=split.whiteSpots; assignedRed+=split.redSpots
    const dw=diff(prevWhite, whitePick.selected), dr=diff(prevRed, redPick.selected)
    rows.push({ key:i, intervalIndex:i, label:halfLabel(half), matchLabel:`${start}-${end}`, splitLabel:`${split.whiteSpots}W / ${split.redSpots}R`, whiteSpots:split.whiteSpots, redSpots:split.redSpots, onWhite:whitePick.selected, onRed:redPick.selected, incomingWhite:dw.incoming, outgoingWhite:dw.outgoing, incomingRed:dr.incoming, outgoingRed:dr.outgoing, hasPrevious:dw.hasPrevious||dr.hasPrevious })
    prevWhite=whitePick.selected; prevRed=redPick.selected
  }
  const summary=allPlayers.map((name)=>({ name, intervals:Number(currentBlocks[name])||0, minutes:(Number(currentBlocks[name])||0)*intervalMinutes, group:asArray(whitePlayers).includes(name)?'White squad':'Red squad' }))
  const spreadMinutes=summary.length ? Math.max(...summary.map((x)=>x.minutes)) - Math.min(...summary.map((x)=>x.minutes)) : 0
  return { rows, summary, targetMinutesPerPlayer, spreadMinutes }
}

function BrandMark({ landing=false }) { return <img src="/icon.svg" alt="Sideline Manager icon" className={`brand-mark ${landing ? 'landing-size' : ''}`} /> }
function GrassStrip({ large=false }) { return <img src="/grass.svg" alt="Green grass decoration" className={`grass-strip ${large ? 'large': ''}`} /> }
function Badge({ tone='slate', children }) { return <span className={`badge ${tone}`}>{children}</span> }
function PlayerChip({ name, tone='slate' }) { return <span className={`chip ${tone}`}>{name}</span> }
function ChipRow({ title, names, tone, emptyText='None' }) { const list=asArray(names); return <div><div className="eyebrow">{title}</div><div className="chip-wrap compact">{list.length ? list.map((n)=><PlayerChip key={`${title}-${n}`} name={n} tone={tone} />) : <div className="muted">{emptyText}</div>}</div></div> }
function StatusChip({ status }) { const tone=status==='Unavailable'?'red':status==='Returning'?'green':'slate'; return <Badge tone={tone}>{status}</Badge> }
function Disclosure({ title, children, defaultOpen=false }) { return <details className="disclosure no-print" open={defaultOpen}><summary>{title}</summary><div className="stack mt-sm">{children}</div></details> }

function LandingPage({ onOpenManager }) {
  return <div className="landing-shell"><section className="landing-hero striped-hero"><div className="landing-brand"><div className="hero-icon-shell landing-shell-icon"><div className="hero-icon-tint"><BrandMark landing /></div></div><div className="landing-copy"><div className="title-badge landing"><h1>SIDELINE MANAGER</h1></div><GrassStrip large /><div className="hero-tagline landing-tag">MANAGE. ROTATE. PERFORM.</div></div></div><button type="button" className="btn btn-primary landing-open" onClick={onOpenManager}>Open the manager</button></section></div>
}

function DateBar({ gameDate, setGameDate }) { return <section className="card compact-meta no-print"><label className="date-label solo"><span>Week / game date</span><input type="date" value={gameDate} onChange={(e)=>setGameDate(e.target.value || todayIso())} /></label></section> }

function HeroBanner() {
  return <section className="hero hero-banner no-print striped-hero"><div className="hero-icon-shell"><div className="hero-icon-tint"><BrandMark /></div></div><div className="hero-copy banner-copy"><div className="title-badge app"><h1>SIDELINE MANAGER</h1></div><GrassStrip /><div className="hero-tagline">MANAGE. ROTATE. PERFORM.</div></div></section>
}

function CompactLiveConsole({ row, totalBlocks, currentIndex, elapsedSeconds, totalMatchSeconds, timerRunning, onStartPause, onResetTimer, onNext, onBack, onSync, timerBlockIndex, mismatch }) {
  if (!row) return null
  const atEnd=currentIndex>=totalBlocks-1, atStart=currentIndex<=0, isStart=!row.hasPrevious, remaining=Math.max(0,totalMatchSeconds-elapsedSeconds), progress=totalMatchSeconds?Math.min(100,(elapsedSeconds/totalMatchSeconds)*100):0
  return <section className="card live-console no-print striped-card"><div className="console-top"><div><div className="eyebrow">Current block</div><h1 className="console-block-title">{row.label}</h1><p className="muted small">Match minutes {row.matchLabel} · Split {row.splitLabel}</p></div></div><div className="timer-strip compact-two-col"><div className="timer-left"><div className="timer-badges-inline"><Badge tone={timerRunning?'green':'amber'}>{timerRunning?'Running':'Paused'}</Badge><Badge tone="red">{row.splitLabel}</Badge></div><div className="eyebrow mt-xs">Game time</div><div className="timer-value">{formatTime(elapsedSeconds)}</div><div className="small muted">Remaining {formatTime(remaining)}</div></div><div className="timer-actions-inline vertical-actions"><button type="button" className="btn btn-primary" onClick={onStartPause}>{timerRunning?'Pause':'Start'}</button><button type="button" className="btn btn-ghost" onClick={onResetTimer}>Reset</button></div></div><div className="progress mt-sm"><div style={{width:`${progress}%`}} /></div>{mismatch ? <div className="alert alert-amber mt-sm compact-alert"><strong>Out of sync:</strong> timer says block {timerBlockIndex+1}. <button type="button" className="btn btn-warning mt-xs full" onClick={onSync}>Sync to timer block</button></div> : null}<div className="console-middle"><div className="console-panel"><div className="group-title">White squad</div><ChipRow title="Go on now" names={row.incomingWhite} tone="green" emptyText={isStart?'Starting group':'No changes'} /><ChipRow title="Come off now" names={row.outgoingWhite} tone="red" emptyText={isStart?'Start of game':'No changes'} /></div><div className="console-panel red-panel"><div className="group-title">Red squad</div><ChipRow title="Go on now" names={row.incomingRed} tone="green" emptyText={isStart?'Starting group':'No changes'} /><ChipRow title="Come off now" names={row.outgoingRed} tone="red" emptyText={isStart?'Start of game':'No changes'} /></div></div><div className="console-bottom"><button type="button" className="btn btn-ghost full" onClick={onBack} disabled={atStart}>Previous</button><button type="button" className="btn btn-primary full next-button" onClick={onNext} disabled={atEnd}>{atEnd?'Last block':'Next interval'}</button></div></section>
}

function GameToolsShell({ gameDate, onArchiveAndStartNew, children }) { return <section className="stack"><div className="card discreet-tools"><div className="tool-heading">New game page</div><p className="small muted">Archive this game, then start a fresh page for the next game week.</p><button type="button" className="btn btn-ghost" onClick={()=>onArchiveAndStartNew(nextWeekIso(gameDate))}>Archive game & start next week</button></div>{children}</section> }

export default function App() {
  const saved = useRef(loadState())
  const [showLanding, setShowLanding] = useState(saved.current.showLanding)
  const [gameDate, setGameDate] = useState(saved.current.gameDate)
  const [halfMinutes, setHalfMinutes] = useState(saved.current.halfMinutes)
  const [intervalMinutes, setIntervalMinutes] = useState(saved.current.intervalMinutes)
  const [totalOnField, setTotalOnField] = useState(saved.current.totalOnField)
  const [whiteSquadPlayers, setWhiteSquadPlayers] = useState(saved.current.whiteSquadPlayers)
  const [redSquadPlayers, setRedSquadPlayers] = useState(saved.current.redSquadPlayers)
  const [absentWhite, setAbsentWhite] = useState(saved.current.absentWhite)
  const [absentRed, setAbsentRed] = useState(saved.current.absentRed)
  const [unavailableWhite, setUnavailableWhite] = useState(saved.current.unavailableWhite)
  const [unavailableRed, setUnavailableRed] = useState(saved.current.unavailableRed)
  const [returningWhite, setReturningWhite] = useState(saved.current.returningWhite)
  const [returningRed, setReturningRed] = useState(saved.current.returningRed)
  const [currentInterval, setCurrentInterval] = useState(saved.current.currentInterval)
  const [elapsedSeconds, setElapsedSeconds] = useState(saved.current.elapsedSeconds)
  const [timerRunning, setTimerRunning] = useState(saved.current.timerRunning)
  const [gameHistory, setGameHistory] = useState(saved.current.gameHistory)
  const [overrides, setOverrides] = useState(saved.current.overrides)
  const [futureState, setFutureState] = useState({ squad: 'white', block: '1', player: '' })

  const intervals = Math.floor((halfMinutes*2)/intervalMinutes)
  const totalMatchMinutes = halfMinutes*2
  const totalMatchSeconds = totalMatchMinutes*60
  const blockSeconds = intervalMinutes*60
  const cleanWhite = useMemo(()=>uniq(whiteSquadPlayers), [whiteSquadPlayers])
  const cleanRed = useMemo(()=>uniq(redSquadPlayers), [redSquadPlayers])
  const duplicateNames = cleanWhite.filter((p)=>cleanRed.includes(p))
  const absentSetWhite = useMemo(()=>new Set(asArray(absentWhite).filter((n)=>cleanWhite.includes(n))), [absentWhite, cleanWhite])
  const absentSetRed = useMemo(()=>new Set(asArray(absentRed).filter((n)=>cleanRed.includes(n))), [absentRed, cleanRed])
  const unavailableSetWhite = useMemo(()=>new Set(asArray(unavailableWhite).filter((n)=>cleanWhite.includes(n))), [unavailableWhite, cleanWhite])
  const unavailableSetRed = useMemo(()=>new Set(asArray(unavailableRed).filter((n)=>cleanRed.includes(n))), [unavailableRed, cleanRed])
  const availableWhite = useMemo(()=>cleanWhite.filter((n)=>!absentSetWhite.has(n) && !unavailableSetWhite.has(n)), [cleanWhite, absentSetWhite, unavailableSetWhite])
  const availableRed = useMemo(()=>cleanRed.filter((n)=>!absentSetRed.has(n) && !unavailableSetRed.has(n)), [cleanRed, absentSetRed, unavailableSetRed])
  const availableTotal = availableWhite.length + availableRed.length
  const sortedHistory = useMemo(()=>asArray(gameHistory).slice().sort((a,b)=>String(a?.gameDate||'').localeCompare(String(b?.gameDate||''))), [gameHistory])
  const previousGame = useMemo(()=>{ const earlier=sortedHistory.filter((r)=>String(r?.gameDate||'')<gameDate); return earlier.length ? earlier[earlier.length-1] : null }, [sortedHistory, gameDate])
  const priorMinutes = useMemo(()=>previousMinutesMap(previousGame), [previousGame])
  const schedule = useMemo(()=>buildSchedule({ whitePlayers:availableWhite, redPlayers:availableRed, totalOnField, intervals, intervalMinutes, halfMinutes, priorMinutes, overrides, completedIntervals: currentInterval }), [availableWhite, availableRed, totalOnField, intervals, intervalMinutes, halfMinutes, priorMinutes, overrides, currentInterval])
  const summarySafe = schedule.summary || []
  const maxIntervalIndex = Math.max(0, asArray(schedule.rows).length - 1)
  const timerBlockIndex = asArray(schedule.rows).length ? Math.min(Math.floor(elapsedSeconds / Math.max(1, blockSeconds)), maxIntervalIndex) : 0
  const mismatch = asArray(schedule.rows).length > 0 && currentInterval !== timerBlockIndex
  const liveRow = asArray(schedule.rows)[currentInterval] ?? null

  useEffect(()=>{ if(!timerRunning) return undefined; const timer=window.setInterval(()=>{ setElapsedSeconds((c)=>{ const next=Math.min(c+1,totalMatchSeconds); if(next>=totalMatchSeconds) setTimerRunning(false); return next }) },1000); return ()=>window.clearInterval(timer) }, [timerRunning, totalMatchSeconds])
  useEffect(()=>{ if(typeof window==='undefined') return; const payload={ showLanding, gameDate, halfMinutes, intervalMinutes, totalOnField, whiteSquadPlayers:cleanWhite, redSquadPlayers:cleanRed, absentWhite:Array.from(absentSetWhite), absentRed:Array.from(absentSetRed), unavailableWhite:Array.from(unavailableSetWhite), unavailableRed:Array.from(unavailableSetRed), returningWhite:Array.from(returningWhite), returningRed:Array.from(returningRed), currentInterval, elapsedSeconds, timerRunning, gameHistory, overrides }; window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload)) }, [showLanding, gameDate, halfMinutes, intervalMinutes, totalOnField, cleanWhite, cleanRed, absentSetWhite, absentSetRed, unavailableSetWhite, unavailableSetRed, returningWhite, returningRed, currentInterval, elapsedSeconds, timerRunning, gameHistory, overrides])

  const archiveCurrentGame=(nextDate)=>{ const record={ id:`${gameDate}-${Date.now()}`, gameDate, halfMinutes, intervalMinutes, totalOnField, summary:summarySafe, elapsedSeconds, currentInterval, targetMinutesPerPlayer:schedule.targetMinutesPerPlayer, spreadMinutes:schedule.spreadMinutes }; setGameHistory((current)=>[...asArray(current), record].sort((a,b)=>String(a?.gameDate||'').localeCompare(String(b?.gameDate||'')))); setGameDate(nextDate || nextWeekIso(gameDate)); setAbsentWhite([]); setAbsentRed([]); setUnavailableWhite([]); setUnavailableRed([]); setReturningWhite([]); setReturningRed([]); setCurrentInterval(0); setElapsedSeconds(0); setTimerRunning(false); setOverrides({ white:{}, red:{} }); window.scrollTo({ top:0, behavior:'smooth' }) }

  if (showLanding) return <div className="app-shell"><div className="container"><LandingPage onOpenManager={()=>setShowLanding(false)} /></div></div>

  return <div className="app-shell"><div className="container"><HeroBanner /><DateBar gameDate={gameDate} setGameDate={setGameDate} /><div className="layout mobile-first-layout"><div className="sidebar no-print top-stack"><CompactLiveConsole row={liveRow} totalBlocks={asArray(schedule.rows).length} currentIndex={currentInterval} elapsedSeconds={elapsedSeconds} totalMatchSeconds={totalMatchSeconds} timerRunning={timerRunning} onStartPause={()=>setTimerRunning((v)=>!v)} onResetTimer={()=>{ setTimerRunning(false); setElapsedSeconds(0) }} onNext={()=>setCurrentInterval((v)=>Math.min(v+1,maxIntervalIndex))} onBack={()=>setCurrentInterval((v)=>Math.max(v-1,0))} onSync={()=>setCurrentInterval(timerBlockIndex)} timerBlockIndex={timerBlockIndex} mismatch={mismatch} /><Disclosure title="Game Tools"><GameToolsShell gameDate={gameDate} onArchiveAndStartNew={archiveCurrentGame}><section className="card"><div className="row between center gap wrap"><h2>Match setup</h2><Badge tone="red">Fairness first</Badge></div><div className="grid three mt"><label><span>Minutes per half</span><input type="number" min="1" value={halfMinutes} onChange={(e)=>setHalfMinutes(Number(e.target.value)||0)} /></label><label><span>Sub interval</span><input type="number" min="1" value={intervalMinutes} onChange={(e)=>setIntervalMinutes(Number(e.target.value)||0)} /></label><label className="span-two"><span>Total players on field at one time</span><input type="number" min="1" max={Math.max(1, availableTotal || 1)} value={totalOnField} onChange={(e)=>setTotalOnField(Number(e.target.value)||0)} /></label></div>{intervalMinutes>0 && halfMinutes>0 && halfMinutes % intervalMinutes!==0 ? <div className="alert mt"><strong>Please fix the setup</strong><ul><li>Minutes per half must divide evenly by the sub interval.</li></ul></div> : null}{!intervalMinutes || !halfMinutes || totalOnField>availableTotal || duplicateNames.length || !availableTotal ? <div className="alert mt"><strong>Please fix the setup</strong><ul>{totalOnField>availableTotal ? <li>Total players on field cannot exceed available players.</li> : null}{duplicateNames.length ? <li>Each player name must appear only once across both squads.</li> : null}{!availableTotal ? <li>At least one player must be available.</li> : null}</ul></div> : null}</section></GameToolsShell></Disclosure><Disclosure title="Minutes Summary"><section className="card"><div className="row between center gap wrap"><h2>Minutes summary</h2><div className="minutes-summary-badges"><Badge tone="slate">Available: {availableTotal}</Badge><Badge tone="blue">On field: {totalOnField}</Badge><Badge tone="red">Dynamic whole-game split</Badge><Badge tone="blue">Target: {schedule.targetMinutesPerPlayer.toFixed(1)} mins/player</Badge><Badge tone={schedule.spreadMinutes<=5?'green':'amber'}>Projected spread: {schedule.spreadMinutes} mins</Badge></div></div><div className="small muted">Rotation balancing source: {previousGame ? `Using prior minutes from ${previousGame.gameDate}` : 'No previous saved game yet'}.</div><div className="grid summary-grid mt">{summarySafe.map((player)=><div key={player.name} className={`mini-card minutes-card ${player.group==='Red squad'?'red-squad-tile':'white-squad-tile'}`}><div className="row between start gap"><div><strong>{player.name}</strong><div className="small muted">{player.group}</div></div><Badge tone={player.group==='Red squad'?'red':'slate'}>{player.minutes} mins</Badge></div><div className="progress mt-sm"><div className={player.group==='Red squad'?'progress-red':''} style={{width:`${Math.max(8,totalMatchMinutes ? (player.minutes/totalMatchMinutes)*100 : 0)}%`}} /></div><div className="small muted mt-sm">{player.intervals} × {intervalMinutes}-minute blocks</div></div>)}</div></section></Disclosure><Disclosure title="Rotation Plan"><section className="card"><div className="row between center gap wrap"><div><h2>Rotation plan</h2><p className="muted">Dynamic split mode keeps Red on the field more often where possible while pushing the whole squad toward the same total minutes.</p></div><Badge tone="slate">{schedule.rows.length} blocks</Badge></div><div className="stack mt">{schedule.rows.map((row)=>{ const status=row.intervalIndex<currentInterval?'completed':row.intervalIndex===currentInterval?'current':'upcoming'; const statusLabel=status==='completed'?'Done':status==='current'?'Current':'Up next'; const statusTone=status==='completed'?'slate':status==='current'?'green':'blue'; return <div key={row.key} className={`mini-card block-card ${status}`}><div className="row between start gap wrap"><div><h3>{row.label}</h3><div className="small muted">Match minutes {row.matchLabel}</div></div><div className="column gap-xs align-end"><Badge tone={statusTone}>{statusLabel}</Badge><Badge tone="red">{row.splitLabel}</Badge></div></div></div> })}</div></section></Disclosure></div></div></div></div>
}
