import React, { useEffect, useMemo, useRef, useState } from 'react'

const STORAGE_KEY = 'sideline-manager-v4-3-2-rollback-mobile-polish'
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

function BrandMark({ landing=false }) { return <img src="/icon.png?v=1" alt="Sideline Manager icon" className={`brand-mark ${landing ? 'landing-size' : ''}`} /> }
function TitleLockup({ landing=false }) { return <img src="/Title.png?v=1" alt="Sideline Manager title" className={landing ? 'landing-title-lockup' : 'title-lockup'} /> }
function Badge({ tone='slate', children }) { return <span className={`badge ${tone}`}>{children}</span> }
function PlayerChip({ name, tone='slate' }) { return <span className={`chip ${tone}`}>{name}</span> }
function ChipRow({ title, names, tone, emptyText='None' }) { const list=asArray(names); return <div className="chip-row-block"><div className="eyebrow">{title}</div><div className="chip-wrap compact">{list.length ? list.map((n)=><PlayerChip key={`${title}-${n}`} name={n} tone={tone} />) : <div className="muted">{emptyText}</div>}</div></div> }
function StatusChip({ status }) { const tone=status==='Unavailable'?'red':status==='Returning'?'green':'slate'; return <Badge tone={tone}>{status}</Badge> }
function Disclosure({ title, children, defaultOpen=false }) { return <details className="disclosure no-print" open={defaultOpen}><summary>{title}</summary><div className="stack mt-sm">{children}</div></details> }

function LandingPage({ onOpenManager, domainIdeas }) {
  return <div className="landing-shell"><section className="landing-hero striped-hero"><div className="landing-brand"><div className="hero-icon-shell landing-shell-icon"><div className="hero-icon-tint"><BrandMark landing /></div></div><div className="landing-copy plain-banner-copy"><h1 className="banner-title-text landing-banner-title">SIDELINE MANAGER</h1><GrassStrip large /><div className="hero-tagline landing-tag">MANAGE. ROTATE. PERFORM.</div></div></div><div className="landing-cta-group"><button type="button" className="btn btn-primary" onClick={onOpenManager}>Open the manager</button><div className="small muted light">Dynamic fairness, smart split selection, live sideline recovery, and projected minutes that rebuild after changes.</div></div></section><section className="landing-grid"><div className="card landing-card"><h2>What this build focuses on</h2><ul><li>Whole-game fairness target across all available players</li><li>Dynamic White / Red split by block</li><li>Cross-squad quick swap capability as a sideline fallback</li><li>Projected minutes update as the remaining game is rebuilt after changes</li></ul></div><div className="card landing-card"><h2>Shareable domain ideas</h2><ul>{domainIdeas.map((idea)=><li key={idea}><strong>{idea}</strong></li>)}</ul><p className="small muted">My pick: <strong>sidelinemanager.app</strong></p></div></section></div>
}

function DateBar({ gameDate, setGameDate }) { return <section className="card compact-meta no-print"><label className="date-label solo"><span>Week / game date</span><input type="date" value={gameDate} onChange={(e)=>setGameDate(e.target.value || todayIso())} /></label></section> }

function HeroBanner() {
  return <section className="hero hero-banner no-print striped-hero"><div className="hero-icon-shell"><div className="hero-icon-tint"><BrandMark /></div></div><div className="hero-copy banner-copy"><TitleLockup /></div></section>
}

function intersection(a, b) {
  return asArray(a).filter((name) => asArray(b).includes(name))
}

function upcomingDiff(current, next) {
  const currentList = asArray(current)
  const nextList = asArray(next)

  return {
    stayingOn: intersection(currentList, nextList),
    comingOff: currentList.filter((name) => !nextList.includes(name)),
    goingOn: nextList.filter((name) => !currentList.includes(name)),
  }
}

function CompactLiveConsole({ row, nextRow, totalBlocks, currentIndex, elapsedSeconds, totalMatchSeconds, timerRunning, onStartPause, onResetTimer, onNext, onBack, onSync, timerBlockIndex, mismatch }) {
  if (!row) return null
  const atEnd=currentIndex>=totalBlocks-1, atStart=currentIndex<=0, isStart=!row.hasPrevious, remaining=Math.max(0,totalMatchSeconds-elapsedSeconds), progress=totalMatchSeconds?Math.min(100,(elapsedSeconds/totalMatchSeconds)*100):0
  const whiteUpcoming = nextRow
  ? upcomingDiff(row.onWhite, nextRow.onWhite)
  : { stayingOn: row.onWhite, comingOff: [], goingOn: [] }
const redUpcoming = nextRow
  ? upcomingDiff(row.onRed, nextRow.onRed)
  : { stayingOn: row.onRed, comingOff: [], goingOn: [] }
  return <section className="card live-console no-print striped-card"><div className="console-top"><div><div className="eyebrow">Current block</div><h1 className="console-block-title">{row.label}</h1><p className="muted small">Match minutes {row.matchLabel} · Split {row.splitLabel}</p></div></div><div className="timer-strip compact-two-col"><div className="timer-left"><div className="timer-badges-inline"><Badge tone={timerRunning?'green':'amber'}>{timerRunning?'Running':'Paused'}</Badge><Badge tone="amber">{row.splitLabel}</Badge></div><div className="eyebrow mt-xs">Game time</div><div className="timer-value">{formatTime(elapsedSeconds)}</div><div className="small muted">Remaining {formatTime(remaining)}</div></div><div className="timer-actions-inline vertical-actions"><button type="button" className="btn btn-primary" onClick={onStartPause}>{timerRunning?'Pause':'Start'}</button><button type="button" className="btn btn-ghost" onClick={onResetTimer}>Reset</button></div></div><div className="progress mt-sm"><div style={{width:`${progress}%`}} /></div>{mismatch ? <div className="alert alert-amber mt-sm compact-alert"><strong>Out of sync:</strong> timer says block {timerBlockIndex+1}. <button type="button" className="btn btn-warning mt-xs full" onClick={onSync}>Sync to timer block</button></div> : null}<div className="on-field-section"><div className="group-title">On field now</div><div className="console-middle"><div className="console-panel"><div className="group-title">White squad</div><ChipRow title="Currently on field" names={row.onWhite} tone="blue" emptyText="None" /><ChipRow title="Staying on next block" names={whiteUpcoming.stayingOn} tone="slate" emptyText={nextRow ? 'None' : 'Last block'} /></div><div className="console-panel red-panel"><div className="group-title">Red squad</div><ChipRow title="Currently on field" names={row.onRed} tone="blue" emptyText="None" /><ChipRow title="Staying on next block" names={redUpcoming.stayingOn} tone="slate" emptyText={nextRow ? 'None' : 'Last block'} /></div></div></div><div className="upcoming-section"><div className="group-title">Upcoming changes</div><div className="console-middle"><div className="console-panel"><div className="group-title">White squad</div><ChipRow title="Going on next" names={whiteUpcoming.goingOn} tone="green" emptyText={nextRow ? 'No changes' : 'Last block'} /><ChipRow title="Coming off next" names={whiteUpcoming.comingOff} tone="red" emptyText={nextRow ? 'No changes' : 'Last block'} /></div><div className="console-panel red-panel"><div className="group-title">Red squad</div><ChipRow title="Going on next" names={redUpcoming.goingOn} tone="green" emptyText={nextRow ? 'No changes' : 'Last block'} /><ChipRow title="Coming off next" names={redUpcoming.comingOff} tone="red" emptyText={nextRow ? 'No changes' : 'Last block'} /></div></div></div><div className="console-bottom"><button type="button" className="btn btn-ghost full" onClick={onBack} disabled={atStart}>Previous</button><button type="button" className="btn btn-primary full next-button" onClick={onNext} disabled={atEnd}>{atEnd?'Last block':'Next interval'}</button></div></section>
}

function QuickSwapSection({ swapState, setSwapState, currentRow, whiteBench, redBench, onApplyQuickSwap }) {
  const outgoingSquad = swapState.outgoingSquad || 'white'
  const incomingSquad = swapState.incomingSquad || 'white'
  const outgoingPlayers = outgoingSquad === 'white' ? asArray(currentRow?.onWhite) : asArray(currentRow?.onRed)
  const incomingBench = incomingSquad === 'white' ? asArray(whiteBench) : asArray(redBench)
  return <section className="card discreet-tools"><div className="tool-heading">Quick current block swap</div><p className="small muted">Swap off and swap on can come from different squads. Players removed by quick swap are withdrawn from the next rotation, and replacement players are protected into the next block.</p><div className="stack mt-sm"><div><div className="eyebrow">Player coming off now</div><div className="grid two-up"><label><span>Squad</span><select value={swapState.outgoingSquad} onChange={(e)=>setSwapState((c)=>({...c, outgoingSquad:e.target.value, outgoingPlayer:''}))}><option value="white">White squad</option><option value="red">Red squad</option></select></label><label><span>Player</span><select value={swapState.outgoingPlayer} onChange={(e)=>setSwapState((c)=>({...c, outgoingPlayer:e.target.value}))}><option value="">Choose player</option>{outgoingPlayers.map((n)=><option key={n} value={n}>{n}</option>)}</select></label></div></div><div><div className="eyebrow">Player going on now</div><div className="grid two-up"><label><span>Squad</span><select value={swapState.incomingSquad} onChange={(e)=>setSwapState((c)=>({...c, incomingSquad:e.target.value, incomingPlayer:''}))}><option value="white">White squad</option><option value="red">Red squad</option></select></label><label><span>Player</span><select value={swapState.incomingPlayer} onChange={(e)=>setSwapState((c)=>({...c, incomingPlayer:e.target.value}))}><option value="">Choose player</option>{incomingBench.map((n)=><option key={n} value={n}>{n}</option>)}</select></label></div></div></div><button type="button" className="btn btn-ghost mt-sm" onClick={onApplyQuickSwap}>Apply quick swap</button></section>
}

function ReEnterSection({ futureState, setFutureState, currentRow, whiteBench, redBench, totalBlocks, onApplyFutureReturn }) {
  const squad=futureState.squad||'white', options=squad==='white'?uniq([...asArray(currentRow?.onWhite),...asArray(whiteBench)]):uniq([...asArray(currentRow?.onRed),...asArray(redBench)])
  return <section className="card discreet-tools"><div className="tool-heading">Re-enter a player into an upcoming block</div><p className="small muted">Force a player back into a selected future block if that player is okay to return later.</p><div className="grid two-up mt-sm"><label><span>Squad</span><select value={futureState.squad} onChange={(e)=>setFutureState((c)=>({...c,squad:e.target.value,player:''}))}><option value="white">White squad</option><option value="red">Red squad</option></select></label><label><span>Upcoming block</span><select value={futureState.block} onChange={(e)=>setFutureState((c)=>({...c,block:e.target.value}))}>{Array.from({length:Math.max(totalBlocks,0)},(_,i)=>i).filter((i)=>i>0).map((i)=><option key={i} value={String(i)}>{`Block ${i+1}`}</option>)}</select></label><label className="span-two"><span>Player to force back in</span><select value={futureState.player} onChange={(e)=>setFutureState((c)=>({...c,player:e.target.value}))}><option value="">Choose player</option>{options.map((n)=><option key={n} value={n}>{n}</option>)}</select></label></div><button type="button" className="btn btn-ghost mt-sm" onClick={onApplyFutureReturn}>Add returning player</button></section>
}

function SquadStatusPanel({ squadLabel, players, unavailableSet, returningSet, markUnavailable, markAvailableAgain, resetStatuses }) {
  return <section className="card"><div className="row between center gap wrap"><div><h2>{squadLabel} status</h2><div className="small muted">Mark players out for the rest of the game or bring them back into the pool.</div></div><button type="button" className="btn btn-ghost small-btn" onClick={resetStatuses}>Reset section</button></div><div className="stack mt-sm">{asArray(players).map((name)=>{ const status=unavailableSet.has(name)?'Unavailable':returningSet.has(name)?'Returning':'Available'; return <div key={`${squadLabel}-${name}`} className="status-row"><div className="status-left"><strong>{name}</strong><StatusChip status={status} /></div><div className="status-actions"><button type="button" className="btn btn-ghost small-btn" onClick={()=>markUnavailable(name)}>Unavailable for rest of game</button><button type="button" className="btn btn-ghost small-btn" onClick={()=>markAvailableAgain(name)}>Available again</button></div></div> })}</div></section>
}

function AvailabilityPanel({ title, players, absentSet, toggleAbsent, markAllPresent }) { return <section className="card"><div className="row between start gap wrap"><div><h2>{title}</h2><p className="muted">Tap a player to mark them absent or present for this game.</p></div><button type="button" className="btn btn-ghost" onClick={markAllPresent}>Reset</button></div><div className="chip-wrap mt">{asArray(players).map((player)=>{ const absent=absentSet.has(player); return <button key={player} type="button" className={`presence ${absent?'absent':'present'}`} onClick={()=>toggleAbsent(player)}>{player} · {absent?'Absent':'Present'}</button> })}</div></section> }
function NameEditor({ title, names, setNames }) { return <section className="card"><div className="row between center gap"><h2>{title}</h2><Badge tone="blue">{asArray(names).length} listed</Badge></div><textarea className="textarea mt" value={asArray(names).join('\n')} onChange={(e)=>setNames(e.target.value.split('\n').map((v)=>v.trim()).filter(Boolean))} /><p className="small muted">One player per line.</p></section> }

function MinutesSummary({ summary, totalMatchMinutes, intervalMinutes, targetMinutesPerPlayer, spreadMinutes, availableCount, totalOnField, previousGameDate }) {
  return <section className="card no-print"><div className="row between center gap wrap"><h2>Minutes summary</h2><div className="minutes-summary-badges"><Badge tone="slate">Available: {availableCount}</Badge><Badge tone="blue">On field: {totalOnField}</Badge><Badge tone="red">Dynamic whole-game split</Badge><Badge tone="blue">Target: {targetMinutesPerPlayer.toFixed(1)} mins/player</Badge><Badge tone={spreadMinutes<=5?'green':'amber'}>Projected spread: {spreadMinutes} mins</Badge></div></div><div className="small muted">Rotation balancing source: {previousGameDate ? `Using prior minutes from ${previousGameDate}` : 'No previous saved game yet'} · Projected minutes update as injuries, re-entry choices, and manual changes rebalance the remaining blocks.</div><div className="grid summary-grid mt">{asArray(summary).map((player)=>{ const isRed=player.group==='Red squad'; const delta=player.minutes-targetMinutesPerPlayer; return <div key={player.name} className={`mini-card minutes-card ${isRed?'red-squad-tile':'white-squad-tile'}`}><div className="row between start gap"><div><strong>{player.name}</strong><div className="small muted">{player.group}</div></div><Badge tone={isRed?'red':'slate'}>{player.minutes} mins</Badge></div><div className="progress mt-sm"><div className={isRed?'progress-red':''} style={{width:`${Math.max(8,totalMatchMinutes ? (player.minutes/totalMatchMinutes)*100 : 0)}%`}} /></div><div className="small muted mt-sm">{player.intervals} × {intervalMinutes}-minute blocks · {delta===0 ? 'On target' : `${delta>0?'+':''}${delta.toFixed(1)} mins vs target`}</div></div> })}</div></section>
}

function RotationPlan({ rows, currentInterval }) {
  return <section className="card no-print"><div className="row between center gap wrap"><div><h2>Rotation plan</h2><p className="muted">Dynamic split mode keeps Red on the field more often where possible while pushing the whole squad toward the same total minutes.</p></div><Badge tone="slate">{asArray(rows).length} blocks</Badge></div><div className="stack mt">{asArray(rows).map((row)=>{ const status=row.intervalIndex<currentInterval?'completed':row.intervalIndex===currentInterval?'current':'upcoming'; const statusLabel=status==='completed'?'Done':status==='current'?'Current':'Up next'; const statusTone=status==='completed'?'slate':status==='current'?'green':'blue'; return <div key={row.key} className={`mini-card block-card ${status}`}><div className="row between start gap wrap"><div><h3>{row.label}</h3><div className="small muted">Match minutes {row.matchLabel}</div></div><div className="column gap-xs align-end"><Badge tone={statusTone}>{statusLabel}</Badge><Badge tone="red">{row.splitLabel}</Badge></div></div><div className="stack mt-sm"><div className="subcard"><h3>White squad</h3><ChipRow title={!row.hasPrevious?'Starting on':'On now'} names={row.onWhite} tone="blue" emptyText="None" /></div><div className="subcard red-subcard"><h3>Red squad</h3><ChipRow title={!row.hasPrevious?'Starting on':'On now'} names={row.onRed} tone="blue" emptyText="None" /></div></div></div> })}</div></section>
}

function HistoryPanel({ history, onLoadGame }) { return <section className="card"><div className="small muted">Saved previous games: {asArray(history).length}</div><div className="stack mt-sm">{asArray(history).length ? asArray(history).map((record)=><div key={record.id} className="mini-card history-card"><div className="row between start gap wrap"><div><strong>{record.gameDate}</strong><div className="small muted">Target {record.targetMinutesPerPlayer?.toFixed?.(1) ?? '0'} mins · Projected spread {record.spreadMinutes ?? 0} mins</div></div><button type="button" className="btn btn-ghost small-btn" onClick={()=>onLoadGame(record.id)}>Load</button></div></div>) : <div className="small muted">No previous games saved yet.</div>}</div></section> }

function GameTools({ gameDate, historyCount, onArchiveAndStartNew, overrideItems, onClearOverride, onClearAllOverrides, children }) {
  return <section className="stack"><div className="card discreet-tools"><div className="tool-heading">New game page</div><p className="small muted">Archive this game, then start a fresh page for the next game week.</p><button type="button" className="btn btn-ghost" onClick={()=>onArchiveAndStartNew(nextWeekIso(gameDate))}>Archive game & start next week</button><div className="small muted mt-sm">Saved previous games: {historyCount}</div></div><div className="card discreet-tools"><div className="row between center gap wrap"><div><div className="tool-heading">Manual changes</div><div className="small muted">These changes are kept and the remaining blocks rebalance around them.</div></div><button type="button" className="btn btn-ghost small-btn" onClick={onClearAllOverrides}>Clear all</button></div><div className="stack mt-sm">{asArray(overrideItems).length ? asArray(overrideItems).map((item)=><div key={item.key} className="mini-card history-card"><div className="row between start gap wrap"><div><strong>{item.squadLabel} · {item.blockLabel}</strong><div className="small muted">On: {item.forceOn.join(', ') || 'None'} · Off: {item.forceOff.join(', ') || 'None'}</div></div><button type="button" className="btn btn-ghost small-btn" onClick={()=>onClearOverride(item.squadLabel==='White squad'?'white':'red', item.blockIndex)}>Remove</button></div></div>) : <div className="small muted">No manual changes saved yet.</div>}</div></div>{children}</section>
}

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
  const [swapState, setSwapState] = useState({ outgoingSquad: 'white', outgoingPlayer: '', incomingSquad: 'white', incomingPlayer: '' })
  const [availabilityPrompts, setAvailabilityPrompts] = useState([])
  const autoArchiveDoneRef = useRef(false)
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
  const returningSetWhite = useMemo(()=>new Set(asArray(returningWhite).filter((n)=>cleanWhite.includes(n))), [returningWhite, cleanWhite])
  const returningSetRed = useMemo(()=>new Set(asArray(returningRed).filter((n)=>cleanRed.includes(n))), [returningRed, cleanRed])
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
  const nextRow = asArray(schedule.rows)[currentInterval + 1] ?? null
  const whiteBench = liveRow ? availableWhite.filter((n)=>!asArray(liveRow.onWhite).includes(n)) : availableWhite
  const redBench = liveRow ? availableRed.filter((n)=>!asArray(liveRow.onRed).includes(n)) : availableRed
  const overrideItems = useMemo(()=>{ const items=[]; ['white','red'].forEach((squadKey)=>{ const blockMap=asObject(asObject(overrides)[squadKey],{}); Object.entries(blockMap).forEach(([blockText, override])=>{ const blockIndex=Number(blockText); const row=asArray(schedule.rows)[blockIndex]; if(!row) return; const safe=normalizeOverride(override); if(!safe.forceOn.length && !safe.forceOff.length) return; items.push({ key:`${squadKey}-${blockIndex}`, squadLabel:squadKey==='white'?'White squad':'Red squad', blockIndex, blockLabel:row.label, forceOn:safe.forceOn, forceOff:safe.forceOff }) }) }); return items.sort((a,b)=>a.blockIndex-b.blockIndex || a.squadLabel.localeCompare(b.squadLabel)) }, [overrides, schedule.rows])
  const domainIdeas = ['sidelinemanager.app', 'sidelinemanager.co.nz', 'playsidelinemanager.com', 'sidelineinterchange.com']

  useEffect(()=>{ if(!timerRunning) return undefined; const timer=window.setInterval(()=>{ setElapsedSeconds((c)=>{ const next=Math.min(c+1,totalMatchSeconds); if(next>=totalMatchSeconds) setTimerRunning(false); return next }) },1000); return ()=>window.clearInterval(timer) }, [timerRunning, totalMatchSeconds])
  useEffect(()=>{ if(typeof window==='undefined') return; const payload={ showLanding, gameDate, halfMinutes, intervalMinutes, totalOnField, whiteSquadPlayers:cleanWhite, redSquadPlayers:cleanRed, absentWhite:Array.from(absentSetWhite), absentRed:Array.from(absentSetRed), unavailableWhite:Array.from(unavailableSetWhite), unavailableRed:Array.from(unavailableSetRed), returningWhite:Array.from(returningSetWhite), returningRed:Array.from(returningSetRed), currentInterval, elapsedSeconds, timerRunning, gameHistory, overrides }; window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload)) }, [showLanding, gameDate, halfMinutes, intervalMinutes, totalOnField, cleanWhite, cleanRed, absentSetWhite, absentSetRed, unavailableSetWhite, unavailableSetRed, returningSetWhite, returningSetRed, currentInterval, elapsedSeconds, timerRunning, gameHistory, overrides])
  useEffect(()=>{ setFutureState((c)=>({ ...c, block: String(Math.min(Math.max(currentInterval+1,1), Math.max(maxIntervalIndex,1))) })) }, [currentInterval, maxIntervalIndex])

  const canGenerate = intervalMinutes>0 && halfMinutes>0 && halfMinutes % intervalMinutes===0 && totalOnField<=availableTotal && !duplicateNames.length && availableTotal>0

  const applyOverrideUpdate=(squadKey, blockIndex, updates)=>{ setOverrides((current)=>{ const safe=asObject(current,{white:{},red:{}}); const next={...safe, [squadKey]: { ...asObject(safe[squadKey],{}) }}; const key=String(blockIndex); const merged=mergeOverride(next[squadKey][key], updates); if(!merged.forceOn.length && !merged.forceOff.length) delete next[squadKey][key]; else next[squadKey][key]=merged; return next }) }
  const clearOverride=(squadKey, blockIndex)=>setOverrides((current)=>{ const safe=asObject(current,{white:{},red:{}}); const next={...safe, [squadKey]: { ...asObject(safe[squadKey],{}) }}; delete next[squadKey][String(blockIndex)]; return next })
  const clearAllOverrides=()=>setOverrides({ white:{}, red:{} })
  const promptToMakeAvailableAgain = (completedBlockIndex) => {
  const duePrompts = availabilityPrompts.filter((item) => item.promptAfterBlock <= completedBlockIndex)

  if (!duePrompts.length) return

  duePrompts.forEach((item) => {
    const shouldReturn = window.confirm(`${item.player} was removed after a quick swap. Make them available again?`)

    if (shouldReturn) {
      if (item.squad === 'white') {
        setUnavailableWhite((current) => asArray(current).filter((name) => name !== item.player))
        setReturningWhite((current) => uniq([...asArray(current), item.player]))
      } else {
        setUnavailableRed((current) => asArray(current).filter((name) => name !== item.player))
        setReturningRed((current) => uniq([...asArray(current), item.player]))
      }
    }
  })

  setAvailabilityPrompts((current) =>
    asArray(current).filter((item) => item.promptAfterBlock > completedBlockIndex)
  )
}
 const onApplyQuickSwap = () => {
  if (!swapState.outgoingPlayer || !swapState.incomingPlayer) return

  const nextBlockIndex = currentInterval + 1
  const promptAfterBlock = currentInterval + 1

  // Current block: remove outgoing player and bring replacement on now.
  applyOverrideUpdate(swapState.outgoingSquad, currentInterval, {
    forceOff: [swapState.outgoingPlayer],
  })

  applyOverrideUpdate(swapState.incomingSquad, currentInterval, {
    forceOn: [swapState.incomingPlayer],
  })

  // Immediately withdraw the player who came off from future availability.
  if (swapState.outgoingSquad === 'white') {
    setUnavailableWhite((current) => uniq([...asArray(current), swapState.outgoingPlayer]))
    setReturningWhite((current) => asArray(current).filter((name) => name !== swapState.outgoingPlayer))
  } else {
    setUnavailableRed((current) => uniq([...asArray(current), swapState.outgoingPlayer]))
    setReturningRed((current) => asArray(current).filter((name) => name !== swapState.outgoingPlayer))
  }

  // Next block: keep replacement player on so they are not immediately subbed back off.
  if (nextBlockIndex <= maxIntervalIndex) {
    applyOverrideUpdate(swapState.incomingSquad, nextBlockIndex, {
      forceOn: [swapState.incomingPlayer],
    })

    applyOverrideUpdate(swapState.outgoingSquad, nextBlockIndex, {
      forceOff: [swapState.outgoingPlayer],
    })
  }

  // After the next block, ask whether the removed player should return.
  setAvailabilityPrompts((current) => [
    ...asArray(current),
    {
      player: swapState.outgoingPlayer,
      squad: swapState.outgoingSquad,
      promptAfterBlock,
    },
  ])

  setSwapState((current) => ({
    ...current,
    outgoingPlayer: '',
    incomingPlayer: '',
  }))
}

  const nextBlockIndex = currentInterval + 1

  // Current block: remove injured/tired player and bring replacement on now.
  applyOverrideUpdate(swapState.outgoingSquad, currentInterval, {
    forceOff: [swapState.outgoingPlayer],
  })

  applyOverrideUpdate(swapState.incomingSquad, currentInterval, {
    forceOn: [swapState.incomingPlayer],
  })

  // Next block: protect the replacement so they are not immediately subbed back off.
  if (nextBlockIndex <= maxIntervalIndex) {
    applyOverrideUpdate(swapState.incomingSquad, nextBlockIndex, {
      forceOn: [swapState.incomingPlayer],
    })
  }

  setSwapState((c) => ({
    ...c,
    outgoingPlayer: '',
    incomingPlayer: '',
  }))
}
  const onApplyFutureReturn=()=>{ if(!futureState.player) return; const blockIndex=Number(futureState.block); if(Number.isNaN(blockIndex)) return; applyOverrideUpdate(futureState.squad, blockIndex, { forceOn:[futureState.player] }); if(futureState.squad==='white'){ setUnavailableWhite((c)=>asArray(c).filter((n)=>n!==futureState.player)); setReturningWhite((c)=>uniq([...asArray(c), futureState.player])) } else { setUnavailableRed((c)=>asArray(c).filter((n)=>n!==futureState.player)); setReturningRed((c)=>uniq([...asArray(c), futureState.player])) } setFutureState((c)=>({ ...c, player:'' })) }
  const markUnavailable=(squadKey, player)=>{ if(squadKey==='white'){ setUnavailableWhite((c)=>uniq([...asArray(c), player])); setReturningWhite((c)=>asArray(c).filter((n)=>n!==player)); if(asArray(liveRow?.onWhite).includes(player)) applyOverrideUpdate('white', currentInterval, { forceOff:[player] }) } else { setUnavailableRed((c)=>uniq([...asArray(c), player])); setReturningRed((c)=>asArray(c).filter((n)=>n!==player)); if(asArray(liveRow?.onRed).includes(player)) applyOverrideUpdate('red', currentInterval, { forceOff:[player] }) } }
  const markAvailableAgain=(squadKey, player)=>{ if(squadKey==='white'){ setUnavailableWhite((c)=>asArray(c).filter((n)=>n!==player)); setReturningWhite((c)=>uniq([...asArray(c), player])) } else { setUnavailableRed((c)=>asArray(c).filter((n)=>n!==player)); setReturningRed((c)=>uniq([...asArray(c), player])) } }
  const archiveCurrentGame=(nextDate)=>{ const record={ id:`${gameDate}-${Date.now()}`, gameDate, halfMinutes, intervalMinutes, totalOnField, summary:summarySafe, elapsedSeconds, currentInterval, targetMinutesPerPlayer:schedule.targetMinutesPerPlayer, spreadMinutes:schedule.spreadMinutes }; setGameHistory((current)=>[...asArray(current), record].sort((a,b)=>String(a?.gameDate||'').localeCompare(String(b?.gameDate||'')))); setGameDate(nextDate || nextWeekIso(gameDate)); setAbsentWhite([]); setAbsentRed([]); setUnavailableWhite([]); setUnavailableRed([]); setReturningWhite([]); setReturningRed([]); setCurrentInterval(0); setElapsedSeconds(0); setTimerRunning(false); setOverrides({ white:{}, red:{} }); autoArchiveDoneRef.current = false; window.scrollTo({ top:0, behavior:'smooth' }) }
useEffect(() => {
  if (!totalMatchSeconds) return
  if (elapsedSeconds < totalMatchSeconds) return
  if (autoArchiveDoneRef.current) return

  autoArchiveDoneRef.current = true
  setTimerRunning(false)

  archiveCurrentGame(nextWeekIso(gameDate))
}, [elapsedSeconds, totalMatchSeconds, gameDate])  
  const loadHistoricalGame=(recordId)=>{ const selected=asArray(sortedHistory).find((i)=>i?.id===recordId); if(!selected) return; setGameDate(selected.gameDate || todayIso()); setHalfMinutes(Number(selected.halfMinutes)||25); setIntervalMinutes(Number(selected.intervalMinutes)||5); setTotalOnField(Number(selected.totalOnField)||9); setCurrentInterval(0); setElapsedSeconds(0); setTimerRunning(false); setOverrides({ white:{}, red:{} }); setUnavailableWhite([]); setUnavailableRed([]); setReturningWhite([]); setReturningRed([]) }

  if (showLanding) return <div className="app-shell"><div className="container"><LandingPage onOpenManager={()=>setShowLanding(false)} domainIdeas={domainIdeas} /></div></div>

  return <div className="app-shell"><div className="container"><HeroBanner /><DateBar gameDate={gameDate} setGameDate={setGameDate} /><div className="layout mobile-first-layout"><div className="sidebar no-print top-stack"><CompactLiveConsole row={liveRow} totalBlocks={asArray(schedule.rows).length} currentIndex={currentInterval} elapsedSeconds={elapsedSeconds} totalMatchSeconds={totalMatchSeconds} timerRunning={timerRunning} onStartPause={()=>setTimerRunning((v)=>!v)} onResetTimer={()=>{ setTimerRunning(false); setElapsedSeconds(0) }} onNext={() => { promptToMakeAvailableAgain(currentInterval); setCurrentInterval((value) => Math.min(value + 1, maxIntervalIndex)); }} onBack={() => setCurrentInterval((v) => Math.max(v-1,0))} onSync={()=>setCurrentInterval(timerBlockIndex)} timerBlockIndex={timerBlockIndex} mismatch={mismatch} /><Disclosure title="Quick Swap"><QuickSwapSection swapState={swapState} setSwapState={setSwapState} currentRow={liveRow} whiteBench={whiteBench} redBench={redBench} onApplyQuickSwap={onApplyQuickSwap} /></Disclosure><Disclosure title="Re-enter a player"><ReEnterSection futureState={futureState} setFutureState={setFutureState} currentRow={liveRow} whiteBench={whiteBench} redBench={redBench} totalBlocks={asArray(schedule.rows).length} onApplyFutureReturn={onApplyFutureReturn} /></Disclosure><Disclosure title="Game Tools"><GameTools gameDate={gameDate} historyCount={asArray(sortedHistory).length} onArchiveAndStartNew={archiveCurrentGame} overrideItems={overrideItems} onClearOverride={clearOverride} onClearAllOverrides={clearAllOverrides}><SquadStatusPanel squadLabel="White squad" players={cleanWhite} unavailableSet={unavailableSetWhite} returningSet={returningSetWhite} markUnavailable={(name)=>markUnavailable('white', name)} markAvailableAgain={(name)=>markAvailableAgain('white', name)} resetStatuses={()=>{ setUnavailableWhite([]); setReturningWhite([]) }} /><SquadStatusPanel squadLabel="Red squad" players={cleanRed} unavailableSet={unavailableSetRed} returningSet={returningSetRed} markUnavailable={(name)=>markUnavailable('red', name)} markAvailableAgain={(name)=>markAvailableAgain('red', name)} resetStatuses={()=>{ setUnavailableRed([]); setReturningRed([]) }} /><section className="card"><div className="row between center gap wrap"><h2>Match setup</h2><Badge tone="red">Fairness first</Badge></div><div className="grid three mt"><label><span>Minutes per half</span><input type="number" min="1" value={halfMinutes} onChange={(e)=>setHalfMinutes(Number(e.target.value)||0)} /></label><label><span>Sub interval</span><input type="number" min="1" value={intervalMinutes} onChange={(e)=>setIntervalMinutes(Number(e.target.value)||0)} /></label><label className="span-two"><span>Total players on field at one time</span><input type="number" min="1" max={Math.max(1, availableTotal || 1)} value={totalOnField} onChange={(e)=>setTotalOnField(Number(e.target.value)||0)} /></label></div>{!canGenerate ? <div className="alert mt"><strong>Please fix the setup</strong><ul>{halfMinutes % intervalMinutes !== 0 ? <li key="a">Minutes per half must divide evenly by the sub interval.</li> : null}{totalOnField>availableTotal ? <li key="b">Total players on field cannot exceed available players.</li> : null}{duplicateNames.length ? <li key="c">Each player name must appear only once across both squads.</li> : null}{!availableTotal ? <li key="d">At least one player must be available.</li> : null}</ul></div> : null}</section><AvailabilityPanel title="White squad availability" players={cleanWhite} absentSet={absentSetWhite} toggleAbsent={(name)=>setAbsentWhite((c)=>asArray(c).includes(name) ? asArray(c).filter((v)=>v!==name) : [...asArray(c), name])} markAllPresent={()=>setAbsentWhite([])} /><AvailabilityPanel title="Red squad availability" players={cleanRed} absentSet={absentSetRed} toggleAbsent={(name)=>setAbsentRed((c)=>asArray(c).includes(name) ? asArray(c).filter((v)=>v!==name) : [...asArray(c), name])} markAllPresent={()=>setAbsentRed([])} /><NameEditor title="White squad names" names={cleanWhite} setNames={setWhiteSquadPlayers} /><NameEditor title="Red squad names" names={cleanRed} setNames={setRedSquadPlayers} /></GameTools></Disclosure><Disclosure title="Minutes Summary"><MinutesSummary summary={summarySafe} totalMatchMinutes={totalMatchMinutes} intervalMinutes={intervalMinutes} targetMinutesPerPlayer={schedule.targetMinutesPerPlayer||0} spreadMinutes={schedule.spreadMinutes||0} availableCount={availableTotal} totalOnField={totalOnField} previousGameDate={previousGame?.gameDate || ''} /><Disclosure title="Rotation Plan"><RotationPlan rows={schedule.rows} currentInterval={currentInterval} /></Disclosure><Disclosure title="Previous game records"><HistoryPanel history={sortedHistory} onLoadGame={loadHistoricalGame} /></Disclosure></div></div></div></div>
}

