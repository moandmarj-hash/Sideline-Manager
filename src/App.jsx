import React, { useEffect, useMemo, useRef, useState } from 'react'

const STORAGE_KEY = 'sideline-manager-v3-dynamic-polished'
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
  absentWhite: [],
  absentRed: [],
  unavailableWhite: [],
  unavailableRed: [],
  returningWhite: [],
  returningRed: [],
  currentInterval: 0,
  elapsedSeconds: 0,
  timerRunning: false,
  gameHistory: [],
  overrides: { white: {}, red: {} },
}

function asArray(value, fallback = []) { return Array.isArray(value) ? value : fallback }
function asObject(value, fallback = {}) { return value && typeof value === 'object' && !Array.isArray(value) ? value : fallback }
function uniq(list) { return Array.from(new Set(asArray(list).filter(Boolean))) }
function todayIso() { return new Date().toISOString().slice(0, 10) }
function nextWeekIso(dateText) {
  const base = new Date(`${dateText}T12:00:00`)
  if (Number.isNaN(base.getTime())) return todayIso()
  base.setDate(base.getDate() + 7)
  return base.toISOString().slice(0, 10)
}
function formatTime(totalSeconds) {
  const safe = Math.max(0, Math.floor(Number(totalSeconds) || 0))
  const mins = Math.floor(safe / 60)
  const secs = safe % 60
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
}
function halfLabel(halfNumber) { return Number(halfNumber) === 1 ? '1st Half' : '2nd Half' }

function loadState() {
  if (typeof window === 'undefined') return DEFAULT_STATE
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_STATE
    const parsed = JSON.parse(raw)
    const overrides = asObject(parsed.overrides, {})
    return {
      ...DEFAULT_STATE,
      ...parsed,
      whiteSquadPlayers: uniq(parsed.whiteSquadPlayers || DEFAULT_WHITE),
      redSquadPlayers: uniq(parsed.redSquadPlayers || DEFAULT_RED),
      absentWhite: uniq(parsed.absentWhite),
      absentRed: uniq(parsed.absentRed),
      unavailableWhite: uniq(parsed.unavailableWhite),
      unavailableRed: uniq(parsed.unavailableRed),
      returningWhite: uniq(parsed.returningWhite),
      returningRed: uniq(parsed.returningRed),
      gameHistory: asArray(parsed.gameHistory, []),
      overrides: { white: asObject(overrides.white, {}), red: asObject(overrides.red, {}) },
      currentInterval: Number.isFinite(parsed.currentInterval) ? parsed.currentInterval : 0,
      elapsedSeconds: Number.isFinite(parsed.elapsedSeconds) ? parsed.elapsedSeconds : 0,
      timerRunning: Boolean(parsed.timerRunning),
      showLanding: typeof parsed.showLanding === 'boolean' ? parsed.showLanding : true,
      gameDate: typeof parsed.gameDate === 'string' && parsed.gameDate ? parsed.gameDate : todayIso(),
    }
  } catch {
    return DEFAULT_STATE
  }
}

function previousMinutesMap(record) {
  const out = {}
  asArray(record?.summary).forEach((item) => {
    if (item && typeof item.name === 'string') out[item.name] = Number(item.minutes) || 0
  })
  return out
}

function normalizeOverride(value) {
  const safe = asObject(value, {})
  return { forceOn: uniq(safe.forceOn), forceOff: uniq(safe.forceOff) }
}

function mergeOverride(existing, updates) {
  const current = normalizeOverride(existing)
  const updateSafe = normalizeOverride(updates)
  const next = {
    forceOn: uniq([...current.forceOn, ...updateSafe.forceOn]),
    forceOff: uniq([...current.forceOff, ...updateSafe.forceOff]),
  }
  next.forceOn = next.forceOn.filter((name) => !next.forceOff.includes(name))
  return next
}

function chooseDynamicSplit({ totalOnField, whiteCount, redCount, remainingWhiteTarget, remainingRedTarget, remainingBlocks }) {
  const candidates = []
  for (let whiteSpots = 0; whiteSpots <= Math.min(totalOnField, whiteCount); whiteSpots += 1) {
    const redSpots = totalOnField - whiteSpots
    if (redSpots < 0 || redSpots > redCount) continue
    candidates.push({ whiteSpots, redSpots })
  }
  if (!candidates.length) return { whiteSpots: 0, redSpots: 0 }
  const redMajority = candidates.filter((candidate) => candidate.redSpots > candidate.whiteSpots)
  const pool = redMajority.length ? redMajority : candidates
  const idealWhite = remainingWhiteTarget / Math.max(1, remainingBlocks)
  const idealRed = remainingRedTarget / Math.max(1, remainingBlocks)
  let best = pool[0]
  let bestScore = null
  pool.forEach((candidate) => {
    const score = [
      Math.abs(candidate.whiteSpots - idealWhite) + Math.abs(candidate.redSpots - idealRed),
      Math.abs(candidate.whiteSpots - Math.round(idealWhite)),
      -(candidate.redSpots - candidate.whiteSpots),
      candidate.whiteSpots,
    ]
    if (!bestScore || score[0] < bestScore[0] || (score[0] === bestScore[0] && (score[1] < bestScore[1] || (score[1] === bestScore[1] && (score[2] < bestScore[2] || (score[2] === bestScore[2] && score[3] < bestScore[3])))))) {
      best = candidate
      bestScore = score
    }
  })
  return best
}

function pickPlayers(players, spots, equityScore, currentBlocks, lastPlayed, intervalIndex, cursor, override) {
  const safePlayers = asArray(players)
  if (!safePlayers.length || spots <= 0) return { selected: [], nextCursor: 0 }
  const safeOverride = normalizeOverride(override)
  const forceOff = new Set(safeOverride.forceOff.filter((name) => safePlayers.includes(name)))
  const forceOn = safePlayers.filter((name) => safeOverride.forceOn.includes(name) && !forceOff.has(name)).slice(0, spots)
  const remaining = safePlayers
    .filter((name) => !forceOn.includes(name) && !forceOff.has(name))
    .map((name) => ({
      name,
      idx: safePlayers.indexOf(name),
      equity: Number(equityScore[name]) || 0,
      currentBlocks: Number(currentBlocks[name]) || 0,
      last: Number(lastPlayed[name]) || -999,
      ring: (safePlayers.indexOf(name) - cursor + safePlayers.length) % safePlayers.length,
    }))
    .sort((a, b) => {
      if (a.equity !== b.equity) return a.equity - b.equity
      if (a.currentBlocks !== b.currentBlocks) return a.currentBlocks - b.currentBlocks
      if (a.last !== b.last) return a.last - b.last
      return a.ring - b.ring
    })
    .slice(0, Math.max(0, spots - forceOn.length))
    .sort((a, b) => a.idx - b.idx)
    .map((item) => item.name)
  const selected = [...forceOn, ...remaining].sort((a, b) => safePlayers.indexOf(a) - safePlayers.indexOf(b))
  const nextCursor = selected.length ? (safePlayers.indexOf(selected[selected.length - 1]) + 1) % safePlayers.length : cursor
  selected.forEach((name) => {
    equityScore[name] = (Number(equityScore[name]) || 0) + 1
    currentBlocks[name] = (Number(currentBlocks[name]) || 0) + 1
    lastPlayed[name] = intervalIndex
  })
  return { selected, nextCursor }
}

function diff(previous, current) {
  const prev = asArray(previous)
  const cur = asArray(current)
  if (!prev.length) return { incoming: cur, outgoing: [], hasPrevious: false }
  return {
    incoming: cur.filter((name) => !prev.includes(name)),
    outgoing: prev.filter((name) => !cur.includes(name)),
    hasPrevious: true,
  }
}

function buildSchedule({ whitePlayers, redPlayers, totalOnField, intervals, intervalMinutes, halfMinutes, priorMinutes, overrides }) {
  const allPlayers = [...asArray(whitePlayers), ...asArray(redPlayers)]
  const totalPlayers = allPlayers.length
  const totalSlots = intervals * totalOnField
  const targetSlotsPerPlayer = totalPlayers ? totalSlots / totalPlayers : 0
  const targetMinutesPerPlayer = targetSlotsPerPlayer * intervalMinutes
  const targetWhiteSlots = targetSlotsPerPlayer * asArray(whitePlayers).length
  const targetRedSlots = targetSlotsPerPlayer * asArray(redPlayers).length
  const equityScore = {}
  const currentBlocks = {}
  const lastPlayed = {}
  allPlayers.forEach((name) => {
    equityScore[name] = (Number(priorMinutes[name]) || 0) / Math.max(1, intervalMinutes)
    currentBlocks[name] = 0
    lastPlayed[name] = -999
  })
  let assignedWhiteSlots = 0
  let assignedRedSlots = 0
  let cursorWhite = 0
  let cursorRed = 0
  let prevWhite = null
  let prevRed = null
  const rows = []
  for (let i = 0; i < intervals; i += 1) {
    const remainingBlocks = intervals - i
    const remainingWhiteTarget = Math.max(0, targetWhiteSlots - assignedWhiteSlots)
    const remainingRedTarget = Math.max(0, targetRedSlots - assignedRedSlots)
    const split = chooseDynamicSplit({
      totalOnField,
      whiteCount: asArray(whitePlayers).length,
      redCount: asArray(redPlayers).length,
      remainingWhiteTarget,
      remainingRedTarget,
      remainingBlocks,
    })
    const start = i * intervalMinutes
    const end = start + intervalMinutes
    const half = start < halfMinutes ? 1 : 2
    const whiteOverride = normalizeOverride(asObject(asObject(overrides).white, {})[String(i)])
    const redOverride = normalizeOverride(asObject(asObject(overrides).red, {})[String(i)])
    const pickWhite = pickPlayers(whitePlayers, split.whiteSpots, equityScore, currentBlocks, lastPlayed, i, cursorWhite, whiteOverride)
    const pickRed = pickPlayers(redPlayers, split.redSpots, equityScore, currentBlocks, lastPlayed, i, cursorRed, redOverride)
    cursorWhite = pickWhite.nextCursor
    cursorRed = pickRed.nextCursor
    assignedWhiteSlots += split.whiteSpots
    assignedRedSlots += split.redSpots
    const diffWhite = diff(prevWhite, pickWhite.selected)
    const diffRed = diff(prevRed, pickRed.selected)
    rows.push({
      key: i,
      intervalIndex: i,
      label: halfLabel(half),
      matchLabel: `${start}-${end}`,
      splitLabel: `${split.whiteSpots}W / ${split.redSpots}R`,
      whiteSpots: split.whiteSpots,
      redSpots: split.redSpots,
      onWhite: pickWhite.selected,
      onRed: pickRed.selected,
      incomingWhite: diffWhite.incoming,
      outgoingWhite: diffWhite.outgoing,
      incomingRed: diffRed.incoming,
      outgoingRed: diffRed.outgoing,
      hasPrevious: diffWhite.hasPrevious || diffRed.hasPrevious,
      whiteOverride,
      redOverride,
    })
    prevWhite = pickWhite.selected
    prevRed = pickRed.selected
  }
  const summary = allPlayers.map((name) => ({
    name,
    intervals: Number(currentBlocks[name]) || 0,
    minutes: (Number(currentBlocks[name]) || 0) * intervalMinutes,
    group: asArray(whitePlayers).includes(name) ? 'White squad' : 'Red squad',
  }))
  const spreadMinutes = summary.length ? Math.max(...summary.map((player) => player.minutes)) - Math.min(...summary.map((player) => player.minutes)) : 0
  return { rows, summary, targetMinutesPerPlayer, targetWhiteSlots, targetRedSlots, spreadMinutes }
}

function BrandMark({ small = false, landing = false }) {
  const classes = ['brand-mark']
  if (small) classes.push('small')
  if (landing) classes.push('landing-size')
  return <img src="/icon.svg" alt="Sideline Manager logo" className={classes.join(' ')} />
}
function GrassStrip({ large = false }) { return <img src="/grass.svg" alt="Green grass decoration" className={large ? 'grass-strip large' : 'grass-strip'} /> }
function Badge({ tone='slate', children }) { return <span className={`badge ${tone}`}>{children}</span> }
function PlayerChip({ name, tone='slate' }) { return <span className={`chip ${tone}`}>{name}</span> }
function StatusChip({ status }) { const tone = status === 'Unavailable' ? 'red' : status === 'Returning' ? 'green' : 'slate'; return <Badge tone={tone}>{status}</Badge> }
function ChipRow({ title, names, tone, emptyText='None' }) {
  const list = asArray(names)
  return <div><div className="eyebrow">{title}</div><div className="chip-wrap compact">{list.length ? list.map((name) => <PlayerChip key={`${title}-${name}`} name={name} tone={tone} />) : <div className="muted">{emptyText}</div>}</div></div>
}

function LandingPage({ onOpenManager, domainIdeas }) {
  return (
    <div className="landing-shell">
      <section className="landing-hero striped-hero">
        <div className="landing-brand">
          <BrandMark landing />
          <div className="landing-copy">
            <div className="eyebrow light">Sideline-ready rotation control</div>
            <div className="title-badge landing"><h1>Sideline Manager</h1></div>
            <GrassStrip large />
          </div>
        </div>
        <div className="landing-cta-group">
          <button type="button" className="btn btn-primary" onClick={onOpenManager}>Open the manager</button>
          <div className="small muted light">Dynamic fairness, smart split selection, and live sideline recovery in one place.</div>
        </div>
      </section>
      <section className="landing-grid">
        <div className="card landing-card">
          <h2>What this build focuses on</h2>
          <ul>
            <li>Whole-game fairness target across all available players</li>
            <li>Dynamic White / Red split by block</li>
            <li>Rebalance after injuries and manual changes</li>
            <li>Polished title screen and simplified game-day view</li>
          </ul>
        </div>
        <div className="card landing-card">
          <h2>Shareable domain ideas</h2>
          <ul>{domainIdeas.map((idea) => <li key={idea}><strong>{idea}</strong></li>)}</ul>
          <p className="small muted">My pick: <strong>sidelinemanager.app</strong></p>
        </div>
      </section>
    </div>
  )
}

function TopMetaBar({ gameDate, setGameDate, previousGameDate, targetMinutesPerPlayer, spreadMinutes }) {
  return (
    <section className="card compact-meta no-print striped-card">
      <div className="meta-grid wide">
        <label className="date-label"><span>Week / game date</span><input type="date" value={gameDate} onChange={(e) => setGameDate(e.target.value || todayIso())} /></label>
        <div className="meta-note"><span className="eyebrow">Rotation balancing source</span><div className="small muted">{previousGameDate ? `Using prior minutes from ${previousGameDate}` : 'No previous saved game yet'}</div></div>
        <div className="meta-pill-group"><Badge tone="blue">Target: {targetMinutesPerPlayer.toFixed(1)} mins/player</Badge><Badge tone={spreadMinutes <= 5 ? 'green' : 'amber'}>Projected spread: {spreadMinutes} mins</Badge><Badge tone="red">Dynamic split mode</Badge></div>
      </div>
    </section>
  )
}

function CompactLiveConsole({ row, totalBlocks, currentIndex, elapsedSeconds, totalMatchSeconds, timerRunning, onStartPause, onResetTimer, onNext, onBack, onSync, timerBlockIndex, mismatch }) {
  if (!row) return null
  const atEnd = currentIndex >= totalBlocks - 1
  const atStart = currentIndex <= 0
  const isStart = !row.hasPrevious
  const remaining = Math.max(0, totalMatchSeconds - elapsedSeconds)
  const progress = totalMatchSeconds ? Math.min(100, (elapsedSeconds / totalMatchSeconds) * 100) : 0
  return (
    <section className="card live-console no-print striped-card">
      <div className="console-top"><div><div className="eyebrow">Current block</div><h1 className="console-block-title">{row.label}</h1><p className="muted small">Match minutes {row.matchLabel} · Split {row.splitLabel}</p></div><div className="console-badges"><Badge tone={timerRunning ? 'green' : 'amber'}>{timerRunning ? 'Running' : 'Paused'}</Badge><Badge tone="red">{row.splitLabel}</Badge></div></div>
      <div className="timer-strip"><div><div className="eyebrow">Game time</div><div className="timer-value">{formatTime(elapsedSeconds)}</div><div className="small muted">Remaining {formatTime(remaining)}</div></div><div className="timer-actions-inline"><button type="button" className="btn btn-primary" onClick={onStartPause}>{timerRunning ? 'Pause' : 'Start'}</button><button type="button" className="btn btn-ghost" onClick={onResetTimer}>Reset</button></div></div>
      <div className="progress mt-sm"><div style={{ width: `${progress}%` }} /></div>
      {mismatch ? <div className="alert alert-amber mt-sm compact-alert"><strong>Out of sync:</strong> timer says block {timerBlockIndex + 1}. <button type="button" className="btn btn-warning mt-xs full" onClick={onSync}>Sync to timer block</button></div> : null}
      <div className="console-middle"><div className="console-panel"><div className="group-title">White squad</div><ChipRow title="Go on now" names={row.incomingWhite} tone="green" emptyText={isStart ? 'Starting group' : 'No changes'} /><ChipRow title="Come off now" names={row.outgoingWhite} tone="red" emptyText={isStart ? 'Start of game' : 'No changes'} /></div><div className="console-panel red-panel"><div className="group-title">Red squad</div><ChipRow title="Go on now" names={row.incomingRed} tone="green" emptyText={isStart ? 'Starting group' : 'No changes'} /><ChipRow title="Come off now" names={row.outgoingRed} tone="red" emptyText={isStart ? 'Start of game' : 'No changes'} /></div></div>
      <div className="console-bottom"><button type="button" className="btn btn-ghost full" onClick={onBack} disabled={atStart}>Previous</button><button type="button" className="btn btn-primary full next-button" onClick={onNext} disabled={atEnd}>{atEnd ? 'Last block' : 'Next interval'}</button></div>
    </section>
  )
}

function SquadStatusPanel({ squadLabel, players, unavailableSet, returningSet, markUnavailable, markAvailableAgain, resetStatuses }) {
  return <section className="card"><div className="row between center gap wrap"><div><h2>{squadLabel} injury / return status</h2><div className="small muted">Mark players out for the rest of the game or bring them back into the pool.</div></div><button type="button" className="btn btn-ghost small-btn" onClick={resetStatuses}>Reset section</button></div><div className="stack mt-sm">{asArray(players).map((name) => { const status = unavailableSet.has(name) ? 'Unavailable' : returningSet.has(name) ? 'Returning' : 'Available'; return <div key={`${squadLabel}-${name}`} className="status-row"><div className="status-left"><strong>{name}</strong><StatusChip status={status} /></div><div className="status-actions"><button type="button" className="btn btn-ghost small-btn" onClick={() => markUnavailable(name)}>Unavailable for rest of game</button><button type="button" className="btn btn-ghost small-btn" onClick={() => markAvailableAgain(name)}>Available again</button></div></div> })}</div></section>
}

function AvailabilityPanel({ title, players, absentSet, toggleAbsent, markAllPresent }) {
  return <section className="card"><div className="row between start gap wrap"><div><h2>{title}</h2><p className="muted">Tap a player to mark them absent or present for this game.</p></div><button type="button" className="btn btn-ghost" onClick={markAllPresent}>Reset</button></div><div className="chip-wrap mt">{asArray(players).map((player) => { const absent = absentSet.has(player); return <button key={player} type="button" className={`presence ${absent ? 'absent' : 'present'}`} onClick={() => toggleAbsent(player)}>{player} · {absent ? 'Absent' : 'Present'}</button> })}</div></section>
}

function NameEditor({ title, names, setNames }) {
  return <section className="card"><div className="row between center gap"><h2>{title}</h2><Badge tone="blue">{asArray(names).length} listed</Badge></div><textarea className="textarea mt" value={asArray(names).join('\n')} onChange={(e) => setNames(e.target.value.split('\n').map((x) => x.trim()).filter(Boolean))} /><p className="small muted">One player per line.</p></section>
}

function MinutesSummary({ summary, totalMatchMinutes, intervalMinutes, targetMinutesPerPlayer }) {
  return <section className="card no-print"><div className="row between center gap wrap"><h2>Minutes summary</h2><Badge tone="blue">Target {targetMinutesPerPlayer.toFixed(1)} mins</Badge></div><div className="grid summary-grid mt">{asArray(summary).map((player) => { const isRedSquad = player.group === 'Red squad'; const delta = player.minutes - targetMinutesPerPlayer; return <div key={player.name} className={`mini-card minutes-card ${isRedSquad ? 'red-squad-tile' : 'white-squad-tile'}`}><div className="row between start gap"><div><strong>{player.name}</strong><div className="small muted">{player.group}</div></div><Badge tone={isRedSquad ? 'red' : 'slate'}>{player.minutes} mins</Badge></div><div className="progress mt-sm"><div className={isRedSquad ? 'progress-red' : ''} style={{ width: `${Math.max(8, totalMatchMinutes ? (player.minutes / totalMatchMinutes) * 100 : 0)}%` }} /></div><div className="small muted mt-sm">{player.intervals} × {intervalMinutes}-minute blocks · {delta === 0 ? 'On target' : `${delta > 0 ? '+' : ''}${delta.toFixed(1)} mins vs target`}</div></div> })}</div></section>
}

function RotationPlan({ rows, currentInterval }) {
  return <section className="card no-print"><div className="row between center gap wrap"><div><h2>Rotation plan</h2><p className="muted">Dynamic split mode keeps Red on the field more often where possible while pushing the whole squad toward the same total minutes.</p></div><Badge tone="slate">{asArray(rows).length} blocks</Badge></div><div className="stack mt">{asArray(rows).map((row) => { const status = row.intervalIndex < currentInterval ? 'completed' : row.intervalIndex === currentInterval ? 'current' : 'upcoming'; const statusLabel = status === 'completed' ? 'Done' : status === 'current' ? 'Current' : 'Up next'; const statusTone = status === 'completed' ? 'slate' : status === 'current' ? 'green' : 'blue'; return <div key={row.key} className={`mini-card block-card ${status}`}><div className="row between start gap wrap"><div><h3>{row.label}</h3><div className="small muted">Match minutes {row.matchLabel}</div></div><div className="column gap-xs align-end"><Badge tone={statusTone}>{statusLabel}</Badge><Badge tone="red">{row.splitLabel}</Badge></div></div><div className="stack mt-sm"><div className="subcard"><h3>White squad</h3><ChipRow title={!row.hasPrevious ? 'Starting on' : 'On now'} names={row.onWhite} tone="blue" emptyText="None" /></div><div className="subcard red-subcard"><h3>Red squad</h3><ChipRow title={!row.hasPrevious ? 'Starting on' : 'On now'} names={row.onRed} tone="blue" emptyText="None" /></div></div></div> })}</div></section>
}

function HistoryPanel({ history, onLoadGame }) {
  return <details className="history-panel no-print"><summary>Previous game records ({asArray(history).length})</summary><div className="stack mt-sm">{asArray(history).length ? asArray(history).map((record) => <div key={record.id} className="mini-card history-card"><div className="row between start gap wrap"><div><strong>{record.gameDate}</strong><div className="small muted">Target {record.targetMinutesPerPlayer?.toFixed?.(1) ?? '0'} mins · Projected spread {record.spreadMinutes ?? 0} mins</div></div><button type="button" className="btn btn-ghost small-btn" onClick={() => onLoadGame(record.id)}>Load</button></div></div>) : <div className="card"><div className="small muted">No previous games saved yet.</div></div>}</div></details>
}

function GameTools(props) {
  const { gameDate, historyCount, onArchiveAndStartNew, currentSwapState, setCurrentSwapState, futureState, setFutureState, currentRow, whiteBench, redBench, totalBlocks, onApplyCurrentSwap, onApplyFutureReturn, overrideItems, onClearOverride, onClearAllOverrides, children } = props
  const currentSquad = currentSwapState.squad || 'white'
  const currentOnList = currentSquad === 'white' ? asArray(currentRow?.onWhite) : asArray(currentRow?.onRed)
  const currentBench = currentSquad === 'white' ? asArray(whiteBench) : asArray(redBench)
  const futureSquad = futureState.squad || 'white'
  const futureOptions = futureSquad === 'white' ? uniq([...asArray(currentRow?.onWhite), ...asArray(whiteBench)]) : uniq([...asArray(currentRow?.onRed), ...asArray(redBench)])
  return <details className="game-tools no-print"><summary>Game Tools</summary><div className="stack mt-sm"><section className="card discreet-tools"><div className="tool-heading">Quick current block swap</div><p className="small muted">Swap out a player mid-block. Sideline Manager then rebuilds the remaining game using the updated fairness position.</p><div className="grid two-up mt-sm"><label><span>Squad</span><select value={currentSwapState.squad} onChange={(e) => setCurrentSwapState((current) => ({ ...current, squad: e.target.value, outgoing: '', incoming: '' }))}><option value="white">White squad</option><option value="red">Red squad</option></select></label><label><span>Player coming off now</span><select value={currentSwapState.outgoing} onChange={(e) => setCurrentSwapState((current) => ({ ...current, outgoing: e.target.value }))}><option value="">Choose player</option>{currentOnList.map((name) => <option key={name} value={name}>{name}</option>)}</select></label><label className="span-two"><span>Player going back on now</span><select value={currentSwapState.incoming} onChange={(e) => setCurrentSwapState((current) => ({ ...current, incoming: e.target.value }))}><option value="">Choose player</option>{currentBench.map((name) => <option key={name} value={name}>{name}</option>)}</select></label></div><button type="button" className="btn btn-ghost mt-sm" onClick={onApplyCurrentSwap}>Apply current block swap</button></section><section className="card discreet-tools"><div className="tool-heading">Re-enter a player into an upcoming block</div><p className="small muted">Force a player back into a selected future block if that player is okay to return later.</p><div className="grid two-up mt-sm"><label><span>Squad</span><select value={futureState.squad} onChange={(e) => setFutureState((current) => ({ ...current, squad: e.target.value, player: '' }))}><option value="white">White squad</option><option value="red">Red squad</option></select></label><label><span>Upcoming block</span><select value={futureState.block} onChange={(e) => setFutureState((current) => ({ ...current, block: e.target.value }))}>{Array.from({ length: Math.max(totalBlocks, 0) }, (_, idx) => idx).filter((i) => i > 0).map((i) => <option key={i} value={String(i)}>{`Block ${i + 1}`}</option>)}</select></label><label className="span-two"><span>Player to force back in</span><select value={futureState.player} onChange={(e) => setFutureState((current) => ({ ...current, player: e.target.value }))}><option value="">Choose player</option>{futureOptions.map((name) => <option key={name} value={name}>{name}</option>)}</select></label></div><button type="button" className="btn btn-ghost mt-sm" onClick={onApplyFutureReturn}>Add to upcoming block</button></section><section className="card discreet-tools"><div className="row between center gap wrap"><div><div className="tool-heading">Manual changes currently applied</div><div className="small muted">These changes are kept and the remaining blocks rebalance around them.</div></div><button type="button" className="btn btn-ghost small-btn" onClick={onClearAllOverrides}>Clear all</button></div><div className="stack mt-sm">{asArray(overrideItems).length ? asArray(overrideItems).map((item) => <div key={item.key} className="mini-card history-card"><div className="row between start gap wrap"><div><strong>{item.squadLabel} · {item.blockLabel}</strong><div className="small muted">On: {item.forceOn.join(', ') || 'None'} · Off: {item.forceOff.join(', ') || 'None'}</div></div><button type="button" className="btn btn-ghost small-btn" onClick={() => onClearOverride(item.squadLabel === 'White squad' ? 'white' : 'red', item.blockIndex)}>Remove</button></div></div>) : <div className="small muted">No manual changes saved yet.</div>}</div></section><section className="card discreet-tools"><div className="tool-heading">New game page</div><p className="small muted">Archive this game, then start a fresh page for the next game week.</p><button type="button" className="btn btn-ghost" onClick={() => onArchiveAndStartNew(nextWeekIso(gameDate))}>Archive game & start next week</button><div className="small muted mt-sm">Saved previous games: {historyCount}</div></section>{children}</div></details>
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
  const [currentSwapState, setCurrentSwapState] = useState({ squad: 'white', outgoing: '', incoming: '' })
  const [futureState, setFutureState] = useState({ squad: 'white', block: '1', player: '' })

  const intervals = Math.floor((halfMinutes * 2) / intervalMinutes)
  const totalMatchMinutes = halfMinutes * 2
  const totalMatchSeconds = totalMatchMinutes * 60
  const blockSeconds = intervalMinutes * 60
  const cleanWhite = useMemo(() => uniq(whiteSquadPlayers), [whiteSquadPlayers])
  const cleanRed = useMemo(() => uniq(redSquadPlayers), [redSquadPlayers])
  const duplicateNames = cleanWhite.filter((player) => cleanRed.includes(player))
  const absentSetWhite = useMemo(() => new Set(asArray(absentWhite).filter((name) => cleanWhite.includes(name))), [absentWhite, cleanWhite])
  const absentSetRed = useMemo(() => new Set(asArray(absentRed).filter((name) => cleanRed.includes(name))), [absentRed, cleanRed])
  const unavailableSetWhite = useMemo(() => new Set(asArray(unavailableWhite).filter((name) => cleanWhite.includes(name))), [unavailableWhite, cleanWhite])
  const unavailableSetRed = useMemo(() => new Set(asArray(unavailableRed).filter((name) => cleanRed.includes(name))), [unavailableRed, cleanRed])
  const returningSetWhite = useMemo(() => new Set(asArray(returningWhite).filter((name) => cleanWhite.includes(name))), [returningWhite, cleanWhite])
  const returningSetRed = useMemo(() => new Set(asArray(returningRed).filter((name) => cleanRed.includes(name))), [returningRed, cleanRed])
  const availableWhite = useMemo(() => cleanWhite.filter((name) => !absentSetWhite.has(name) && !unavailableSetWhite.has(name)), [cleanWhite, absentSetWhite, unavailableSetWhite])
  const availableRed = useMemo(() => cleanRed.filter((name) => !absentSetRed.has(name) && !unavailableSetRed.has(name)), [cleanRed, absentSetRed, unavailableSetRed])
  const availableTotal = availableWhite.length + availableRed.length
  const sortedHistory = useMemo(() => asArray(gameHistory).slice().sort((a, b) => String(a?.gameDate || '').localeCompare(String(b?.gameDate || ''))), [gameHistory])
  const previousGame = useMemo(() => { const earlier = sortedHistory.filter((record) => String(record?.gameDate || '') < gameDate); return earlier.length ? earlier[earlier.length - 1] : null }, [sortedHistory, gameDate])
  const priorMinutes = useMemo(() => previousMinutesMap(previousGame), [previousGame])
  const schedule = useMemo(() => buildSchedule({ whitePlayers: availableWhite, redPlayers: availableRed, totalOnField, intervals, intervalMinutes, halfMinutes, priorMinutes, overrides }), [availableWhite, availableRed, totalOnField, intervals, intervalMinutes, halfMinutes, priorMinutes, overrides])
  const summarySafe = schedule.summary || []
  const maxIntervalIndex = Math.max(0, asArray(schedule.rows).length - 1)
  const timerBlockIndex = asArray(schedule.rows).length ? Math.min(Math.floor(elapsedSeconds / Math.max(1, blockSeconds)), maxIntervalIndex) : 0
  const mismatch = asArray(schedule.rows).length > 0 && currentInterval !== timerBlockIndex
  const liveRow = asArray(schedule.rows)[currentInterval] ?? null
  const whiteBench = liveRow ? availableWhite.filter((name) => !asArray(liveRow.onWhite).includes(name)) : availableWhite
  const redBench = liveRow ? availableRed.filter((name) => !asArray(liveRow.onRed).includes(name)) : availableRed
  const overrideItems = useMemo(() => {
    const items = []
    ;['white', 'red'].forEach((squadKey) => {
      const blockMap = asObject(asObject(overrides)[squadKey], {})
      Object.entries(blockMap).forEach(([blockText, override]) => {
        const blockIndex = Number(blockText)
        const row = asArray(schedule.rows)[blockIndex]
        if (!row) return
        const safe = normalizeOverride(override)
        if (!safe.forceOn.length && !safe.forceOff.length) return
        items.push({ key: `${squadKey}-${blockIndex}`, squadLabel: squadKey === 'white' ? 'White squad' : 'Red squad', blockIndex, blockLabel: row.label, forceOn: safe.forceOn, forceOff: safe.forceOff })
      })
    })
    return items.sort((a, b) => a.blockIndex - b.blockIndex || a.squadLabel.localeCompare(b.squadLabel))
  }, [overrides, schedule.rows])
  const domainIdeas = ['sidelinemanager.app', 'sidelinemanager.co.nz', 'playsidelinemanager.com', 'sidelineinterchange.com']

  useEffect(() => {
    if (!timerRunning) return undefined
    const timer = window.setInterval(() => {
      setElapsedSeconds((value) => {
        const next = Math.min(value + 1, totalMatchSeconds)
        if (next >= totalMatchSeconds) setTimerRunning(false)
        return next
      })
    }, 1000)
    return () => window.clearInterval(timer)
  }, [timerRunning, totalMatchSeconds])

  useEffect(() => {
    if (typeof window === 'undefined') return
    const payload = { showLanding, gameDate, halfMinutes, intervalMinutes, totalOnField, whiteSquadPlayers: cleanWhite, redSquadPlayers: cleanRed, absentWhite: Array.from(absentSetWhite), absentRed: Array.from(absentSetRed), unavailableWhite: Array.from(unavailableSetWhite), unavailableRed: Array.from(unavailableSetRed), returningWhite: Array.from(returningSetWhite), returningRed: Array.from(returningSetRed), currentInterval, elapsedSeconds, timerRunning, gameHistory, overrides }
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload))
  }, [showLanding, gameDate, halfMinutes, intervalMinutes, totalOnField, cleanWhite, cleanRed, absentSetWhite, absentSetRed, unavailableSetWhite, unavailableSetRed, returningSetWhite, returningSetRed, currentInterval, elapsedSeconds, timerRunning, gameHistory, overrides])

  useEffect(() => {
    setFutureState((current) => ({ ...current, block: String(Math.min(Math.max(currentInterval + 1, 1), Math.max(maxIntervalIndex, 1))) }))
  }, [currentInterval, maxIntervalIndex])

  const canGenerate = intervalMinutes > 0 && halfMinutes > 0 && halfMinutes % intervalMinutes === 0 && totalOnField <= availableTotal && !duplicateNames.length && availableTotal > 0

  const applyOverrideUpdate = (squadKey, blockIndex, updates) => {
    setOverrides((current) => {
      const safe = asObject(current, { white: {}, red: {} })
      const next = { ...safe, [squadKey]: { ...asObject(safe[squadKey], {}) } }
      const key = String(blockIndex)
      const merged = mergeOverride(next[squadKey][key], updates)
      if (!merged.forceOn.length && !merged.forceOff.length) delete next[squadKey][key]
      else next[squadKey][key] = merged
      return next
    })
  }
  const clearOverride = (squadKey, blockIndex) => setOverrides((current) => { const safe = asObject(current, { white: {}, red: {} }); const next = { ...safe, [squadKey]: { ...asObject(safe[squadKey], {}) } }; delete next[squadKey][String(blockIndex)]; return next })
  const clearAllOverrides = () => setOverrides({ white: {}, red: {} })
  const onApplyCurrentSwap = () => {
    if (!currentSwapState.outgoing || !currentSwapState.incoming) return
    applyOverrideUpdate(currentSwapState.squad, currentInterval, { forceOff: [currentSwapState.outgoing], forceOn: [currentSwapState.incoming] })
    setCurrentSwapState((current) => ({ ...current, outgoing: '', incoming: '' }))
  }
  const onApplyFutureReturn = () => {
    if (!futureState.player) return
    const blockIndex = Number(futureState.block)
    if (Number.isNaN(blockIndex)) return
    applyOverrideUpdate(futureState.squad, blockIndex, { forceOn: [futureState.player] })
    if (futureState.squad === 'white') {
      setUnavailableWhite((current) => asArray(current).filter((name) => name !== futureState.player))
      setReturningWhite((current) => uniq([...asArray(current), futureState.player]))
    } else {
      setUnavailableRed((current) => asArray(current).filter((name) => name !== futureState.player))
      setReturningRed((current) => uniq([...asArray(current), futureState.player]))
    }
    setFutureState((current) => ({ ...current, player: '' }))
  }
  const markUnavailable = (squadKey, player) => {
    if (squadKey === 'white') {
      setUnavailableWhite((current) => uniq([...asArray(current), player]))
      setReturningWhite((current) => asArray(current).filter((name) => name !== player))
      if (asArray(liveRow?.onWhite).includes(player)) applyOverrideUpdate('white', currentInterval, { forceOff: [player] })
    } else {
      setUnavailableRed((current) => uniq([...asArray(current), player]))
      setReturningRed((current) => asArray(current).filter((name) => name !== player))
      if (asArray(liveRow?.onRed).includes(player)) applyOverrideUpdate('red', currentInterval, { forceOff: [player] })
    }
  }
  const markAvailableAgain = (squadKey, player) => {
    if (squadKey === 'white') {
      setUnavailableWhite((current) => asArray(current).filter((name) => name !== player))
      setReturningWhite((current) => uniq([...asArray(current), player]))
    } else {
      setUnavailableRed((current) => asArray(current).filter((name) => name !== player))
      setReturningRed((current) => uniq([...asArray(current), player]))
    }
  }
  const archiveCurrentGame = (nextDate) => {
    const record = { id: `${gameDate}-${Date.now()}`, gameDate, halfMinutes, intervalMinutes, totalOnField, summary: summarySafe, elapsedSeconds, currentInterval, targetMinutesPerPlayer: schedule.targetMinutesPerPlayer, spreadMinutes: schedule.spreadMinutes }
    setGameHistory((current) => [...asArray(current), record].sort((a, b) => String(a?.gameDate || '').localeCompare(String(b?.gameDate || ''))))
    setGameDate(nextDate || nextWeekIso(gameDate)); setAbsentWhite([]); setAbsentRed([]); setUnavailableWhite([]); setUnavailableRed([]); setReturningWhite([]); setReturningRed([]); setCurrentInterval(0); setElapsedSeconds(0); setTimerRunning(false); setOverrides({ white: {}, red: {} })
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }
  const loadHistoricalGame = (recordId) => {
    const selected = asArray(sortedHistory).find((item) => item?.id === recordId)
    if (!selected) return
    setGameDate(selected.gameDate || todayIso()); setHalfMinutes(Number(selected.halfMinutes) || 25); setIntervalMinutes(Number(selected.intervalMinutes) || 5); setTotalOnField(Number(selected.totalOnField) || 9); setCurrentInterval(0); setElapsedSeconds(0); setTimerRunning(false); setOverrides({ white: {}, red: {} }); setUnavailableWhite([]); setUnavailableRed([]); setReturningWhite([]); setReturningRed([])
  }

  if (showLanding) return <div className="app-shell"><div className="container"><LandingPage onOpenManager={() => setShowLanding(false)} domainIdeas={domainIdeas} /></div></div>

  return (
    <div className="app-shell"><div className="container"><section className="hero no-print compact-hero striped-hero"><div className="hero-brand"><BrandMark /><div className="hero-copy"><div className="title-badge app"><h1>Sideline Manager</h1></div><GrassStrip /></div></div><div className="hero-actions"><button type="button" className="btn btn-ghost tiny-btn" onClick={() => setShowLanding(true)}>Back to landing</button></div></section><TopMetaBar gameDate={gameDate} setGameDate={setGameDate} previousGameDate={previousGame?.gameDate || ''} targetMinutesPerPlayer={schedule.targetMinutesPerPlayer || 0} spreadMinutes={schedule.spreadMinutes || 0} /><div className="status-bar no-print"><Badge tone="slate">Available: {availableTotal}</Badge><Badge tone="blue">On field: {totalOnField}</Badge><Badge tone="red">Dynamic whole-game split</Badge><Badge tone={schedule.spreadMinutes <= 5 ? 'green' : 'amber'}>Projected spread: {schedule.spreadMinutes} mins</Badge></div><div className="layout mobile-first-layout"><div className="sidebar no-print top-stack"><CompactLiveConsole row={liveRow} totalBlocks={asArray(schedule.rows).length} currentIndex={currentInterval} elapsedSeconds={elapsedSeconds} totalMatchSeconds={totalMatchSeconds} timerRunning={timerRunning} onStartPause={() => setTimerRunning((value) => !value)} onResetTimer={() => { setTimerRunning(false); setElapsedSeconds(0) }} onNext={() => setCurrentInterval((value) => Math.min(value + 1, maxIntervalIndex))} onBack={() => setCurrentInterval((value) => Math.max(value - 1, 0))} onSync={() => setCurrentInterval(timerBlockIndex)} timerBlockIndex={timerBlockIndex} mismatch={mismatch} /><GameTools gameDate={gameDate} historyCount={asArray(sortedHistory).length} onArchiveAndStartNew={archiveCurrentGame} currentSwapState={currentSwapState} setCurrentSwapState={setCurrentSwapState} futureState={futureState} setFutureState={setFutureState} currentRow={liveRow} whiteBench={whiteBench} redBench={redBench} totalBlocks={asArray(schedule.rows).length} onApplyCurrentSwap={onApplyCurrentSwap} onApplyFutureReturn={onApplyFutureReturn} overrideItems={overrideItems} onClearOverride={clearOverride} onClearAllOverrides={clearAllOverrides}><section className="card"><div className="row between center gap wrap"><h2>Match setup</h2><Badge tone="red">Fairness first</Badge></div><div className="grid three mt"><label><span>Minutes per half</span><input type="number" min="1" value={halfMinutes} onChange={(e) => setHalfMinutes(Number(e.target.value) || 0)} /></label><label><span>Sub interval</span><input type="number" min="1" value={intervalMinutes} onChange={(e) => setIntervalMinutes(Number(e.target.value) || 0)} /></label><label className="span-two"><span>Total players on field at one time</span><input type="number" min="1" max={Math.max(1, availableTotal || 1)} value={totalOnField} onChange={(e) => setTotalOnField(Number(e.target.value) || 0)} /></label></div><div className="row wrap gap mt"><Badge tone="slate">Listed: {cleanWhite.length + cleanRed.length}</Badge><Badge tone="slate">Intervals: {intervals}</Badge><Badge tone="slate">Game: {totalMatchMinutes} mins</Badge><Badge tone="blue">Current block: {asArray(schedule.rows).length ? currentInterval + 1 : 0}/{asArray(schedule.rows).length}</Badge><Badge tone="blue">Timer block: {asArray(schedule.rows).length ? timerBlockIndex + 1 : 0}/{asArray(schedule.rows).length}</Badge></div>{!canGenerate ? <div className="alert mt"><strong>Please fix the setup</strong><ul>{halfMinutes % intervalMinutes !== 0 ? <li key="a">Minutes per half must divide evenly by the sub interval.</li> : null}{totalOnField > availableTotal ? <li key="b">Total players on field cannot exceed available players.</li> : null}{duplicateNames.length ? <li key="c">Each player name must appear only once across both squads.</li> : null}{availableTotal === 0 ? <li key="d">At least one player must be available.</li> : null}</ul></div> : null}</section><SquadStatusPanel squadLabel="White squad" players={cleanWhite} unavailableSet={unavailableSetWhite} returningSet={returningSetWhite} markUnavailable={(name) => markUnavailable('white', name)} markAvailableAgain={(name) => markAvailableAgain('white', name)} resetStatuses={() => { setUnavailableWhite([]); setReturningWhite([]) }} /><SquadStatusPanel squadLabel="Red squad" players={cleanRed} unavailableSet={unavailableSetRed} returningSet={returningSetRed} markUnavailable={(name) => markUnavailable('red', name)} markAvailableAgain={(name) => markAvailableAgain('red', name)} resetStatuses={() => { setUnavailableRed([]); setReturningRed([]) }} /><AvailabilityPanel title="White squad availability" players={cleanWhite} absentSet={absentSetWhite} toggleAbsent={(name) => setAbsentWhite((current) => asArray(current).includes(name) ? asArray(current).filter((value) => value !== name) : [...asArray(current), name])} markAllPresent={() => setAbsentWhite([])} /><AvailabilityPanel title="Red squad availability" players={cleanRed} absentSet={absentSetRed} toggleAbsent={(name) => setAbsentRed((current) => asArray(current).includes(name) ? asArray(current).filter((value) => value !== name) : [...asArray(current), name])} markAllPresent={() => setAbsentRed([])} /><NameEditor title="White squad names" names={cleanWhite} setNames={setWhiteSquadPlayers} /><NameEditor title="Red squad names" names={cleanRed} setNames={setRedSquadPlayers} /></GameTools><HistoryPanel history={sortedHistory} onLoadGame={loadHistoricalGame} /></div><div className="main"><MinutesSummary summary={summarySafe} totalMatchMinutes={totalMatchMinutes} intervalMinutes={intervalMinutes} targetMinutesPerPlayer={schedule.targetMinutesPerPlayer || 0} /><RotationPlan rows={schedule.rows} currentInterval={currentInterval} /></div></div></div></div>
  )
}
