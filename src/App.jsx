import React, { useEffect, useMemo, useRef, useState } from 'react'

const STORAGE_KEY = 'rugby-scheduler-stable-v1'
const DEFAULT_WHITE = ['Ikaia', 'Daniel', 'Hazel', 'Leon', 'Caleb', 'Seb']
const DEFAULT_RED = ['Xavier', 'Marcus', 'Manaia', 'Owen', 'Noah', 'Isaac', 'Andre', 'Te Manawa', 'Ted']

const DEFAULT_STATE = {
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

function uniq(list) { return Array.from(new Set((list || []).filter(Boolean))) }
function todayIso() { return new Date().toISOString().slice(0, 10) }
function nextWeekIso(dateText) {
  const base = new Date(`${dateText}T12:00:00`)
  if (Number.isNaN(base.getTime())) return todayIso()
  base.setDate(base.getDate() + 7)
  return base.toISOString().slice(0, 10)
}
function formatTime(totalSeconds) {
  const safe = Math.max(0, Math.floor(totalSeconds))
  const m = Math.floor(safe / 60)
  const s = safe % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}
function halfLabel(half) { return half === 1 ? '1st Half' : '2nd Half' }

function loadState() {
  if (typeof window === 'undefined') return DEFAULT_STATE
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_STATE
    const parsed = JSON.parse(raw)
    return {
      ...DEFAULT_STATE,
      ...parsed,
      whiteSquadPlayers: Array.isArray(parsed.whiteSquadPlayers) ? parsed.whiteSquadPlayers : DEFAULT_WHITE,
      redSquadPlayers: Array.isArray(parsed.redSquadPlayers) ? parsed.redSquadPlayers : DEFAULT_RED,
      absentWhite: Array.isArray(parsed.absentWhite) ? parsed.absentWhite : [],
      absentRed: Array.isArray(parsed.absentRed) ? parsed.absentRed : [],
      unavailableWhite: Array.isArray(parsed.unavailableWhite) ? parsed.unavailableWhite : [],
      unavailableRed: Array.isArray(parsed.unavailableRed) ? parsed.unavailableRed : [],
      returningWhite: Array.isArray(parsed.returningWhite) ? parsed.returningWhite : [],
      returningRed: Array.isArray(parsed.returningRed) ? parsed.returningRed : [],
      gameHistory: Array.isArray(parsed.gameHistory) ? parsed.gameHistory : [],
      overrides: parsed.overrides && typeof parsed.overrides === 'object' ? {white: parsed.overrides.white || {}, red: parsed.overrides.red || {}} : {white:{}, red:{}},
    }
  } catch {
    return DEFAULT_STATE
  }
}

function previousMinutesMap(record) {
  const out = {}
  ;(record?.summary || []).forEach((item) => { out[item.name] = item.minutes })
  return out
}

function findBestSplit(totalOnField, whiteCount, redCount, blockCount, intervalMinutes) {
  let best = null
  for (let whiteSpots = 0; whiteSpots <= Math.min(totalOnField, whiteCount); whiteSpots += 1) {
    const redSpots = totalOnField - whiteSpots
    if (redSpots < 0 || redSpots > redCount) continue
    const avgWhite = whiteCount ? (whiteSpots * blockCount) / whiteCount : 0
    const avgRed = redCount ? (redSpots * blockCount) / redCount : 0
    const whiteM = avgWhite * intervalMinutes
    const redM = avgRed * intervalMinutes
    const spread = Math.abs(whiteM - redM)
    const exact = Number.isInteger(avgWhite) && Number.isInteger(avgRed)
    const option = { whiteSpots, redSpots, spread, exact }
    if (!best || option.spread < best.spread || (option.spread === best.spread && option.exact && !best.exact)) best = option
  }
  return best
}

function normalizeOverride(value) {
  return { forceOn: uniq(value?.forceOn || []), forceOff: uniq(value?.forceOff || []) }
}
function mergeOverride(existing, updates) {
  const current = normalizeOverride(existing)
  const next = { forceOn: uniq([...(current.forceOn || []), ...(updates.forceOn || [])]), forceOff: uniq([...(current.forceOff || []), ...(updates.forceOff || [])]) }
  next.forceOn = next.forceOn.filter((name) => !next.forceOff.includes(name))
  return next
}

function pickPlayers(players, spots, previousCredit, currentBlocks, lastPlayed, intervalIndex, cursor, override) {
  if (!players.length || spots <= 0) return { selected: [], nextCursor: 0 }
  const forceOff = new Set((override?.forceOff || []).filter((name) => players.includes(name)))
  const forceOn = players.filter((name) => (override?.forceOn || []).includes(name) && !forceOff.has(name)).slice(0, spots)
  const remaining = players
    .filter((name) => !forceOn.includes(name) && !forceOff.has(name))
    .map((name) => ({
      name,
      idx: players.indexOf(name),
      prevCredit: previousCredit[name] ?? 0,
      currentBlocks: currentBlocks[name] ?? 0,
      last: lastPlayed[name] ?? -999,
      ring: (players.indexOf(name) - cursor + players.length) % players.length,
    }))
    .sort((a, b) => {
      if (a.prevCredit !== b.prevCredit) return a.prevCredit - b.prevCredit
      if (a.currentBlocks !== b.currentBlocks) return a.currentBlocks - b.currentBlocks
      if (a.last !== b.last) return a.last - b.last
      return a.ring - b.ring
    })
    .slice(0, Math.max(0, spots - forceOn.length))
    .sort((a, b) => a.idx - b.idx)
    .map((item) => item.name)

  const selected = [...forceOn, ...remaining].sort((a, b) => players.indexOf(a) - players.indexOf(b))
  const nextCursor = selected.length ? (players.indexOf(selected[selected.length - 1]) + 1) % players.length : cursor
  selected.forEach((name) => {
    previousCredit[name] = (previousCredit[name] ?? 0) + 1
    currentBlocks[name] = (currentBlocks[name] ?? 0) + 1
    lastPlayed[name] = intervalIndex
  })
  return { selected, nextCursor }
}

function diff(previous, current) {
  if (!previous) return { incoming: current, outgoing: [], hasPrevious: false }
  return {
    incoming: current.filter((name) => !previous.includes(name)),
    outgoing: previous.filter((name) => !current.includes(name)),
    hasPrevious: true,
  }
}

function buildSchedule({ whitePlayers, redPlayers, whiteSpots, redSpots, intervals, intervalMinutes, halfMinutes, priorMinutes, overrides }) {
  const previousCredit = {}
  const currentBlocks = {}
  const lastPlayed = {}
  ;[...whitePlayers, ...redPlayers].forEach((name) => {
    previousCredit[name] = (priorMinutes[name] ?? 0) / Math.max(1, intervalMinutes)
    currentBlocks[name] = 0
    lastPlayed[name] = -999
  })

  let cursorWhite = 0
  let cursorRed = 0
  let prevWhite = null
  let prevRed = null
  const rows = []

  for (let i = 0; i < intervals; i += 1) {
    const start = i * intervalMinutes
    const end = start + intervalMinutes
    const half = start < halfMinutes ? 1 : 2
    const wOverride = normalizeOverride(overrides?.white?.[String(i)])
    const rOverride = normalizeOverride(overrides?.red?.[String(i)])
    const pickWhite = pickPlayers(whitePlayers, whiteSpots, previousCredit, currentBlocks, lastPlayed, i, cursorWhite, wOverride)
    const pickRed = pickPlayers(redPlayers, redSpots, previousCredit, currentBlocks, lastPlayed, i, cursorRed, rOverride)
    cursorWhite = pickWhite.nextCursor
    cursorRed = pickRed.nextCursor
    const dWhite = diff(prevWhite, pickWhite.selected)
    const dRed = diff(prevRed, pickRed.selected)

    rows.push({
      key: i,
      intervalIndex: i,
      label: halfLabel(half),
      matchLabel: `${start}-${end}`,
      onWhite: pickWhite.selected,
      onRed: pickRed.selected,
      incomingWhite: dWhite.incoming,
      outgoingWhite: dWhite.outgoing,
      incomingRed: dRed.incoming,
      outgoingRed: dRed.outgoing,
      hasPrevious: dWhite.hasPrevious || dRed.hasPrevious,
      whiteOverride: wOverride,
      redOverride: rOverride,
    })

    prevWhite = pickWhite.selected
    prevRed = pickRed.selected
  }

  const summary = [...whitePlayers, ...redPlayers].map((name) => ({
    name,
    intervals: currentBlocks[name],
    minutes: currentBlocks[name] * intervalMinutes,
    group: whitePlayers.includes(name) ? 'White squad' : 'Red squad',
  }))

  return { rows, summary }
}

function Badge({ tone='slate', children }) { return <span className={`badge ${tone}`}>{children}</span> }
function PlayerChip({ name, tone='slate' }) { return <span className={`chip ${tone}`}>{name}</span> }
function StatusChip({ status }) {
  const tone = status === 'Unavailable' ? 'red' : status === 'Returning' ? 'green' : 'slate'
  return <Badge tone={tone}>{status}</Badge>
}
function ChipRow({ title, names, tone, emptyText='None' }) {
  return (
    <div>
      <div className="eyebrow">{title}</div>
      <div className="chip-wrap compact">{names.length ? names.map((name) => <PlayerChip key={`${title}-${name}`} name={name} tone={tone} />) : <div className="muted">{emptyText}</div>}</div>
    </div>
  )
}

function TopMetaBar({ gameDate, setGameDate, previousGameDate }) {
  return (
    <section className="card compact-meta no-print">
      <div className="meta-grid">
        <label className="date-label">
          <span>Week / game date</span>
          <input type="date" value={gameDate} onChange={(e) => setGameDate(e.target.value || todayIso())} />
        </label>
        <div className="meta-note">
          <span className="eyebrow">Rotation balancing source</span>
          <div className="small muted">{previousGameDate ? `Using prior minutes from ${previousGameDate}` : 'No previous saved game yet'}</div>
        </div>
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
    <section className="card live-console no-print">
      <div className="console-top">
        <div>
          <div className="eyebrow">Current block</div>
          <h1 className="console-block-title">{row.label}</h1>
          <p className="muted small">Match minutes {row.matchLabel}</p>
        </div>
        <div className="console-badges">
          <Badge tone={timerRunning ? 'green' : 'amber'}>{timerRunning ? 'Running' : 'Paused'}</Badge>
          <Badge tone={mismatch ? 'amber' : 'blue'}>Timer block {timerBlockIndex + 1}</Badge>
        </div>
      </div>
      <div className="timer-strip">
        <div>
          <div className="eyebrow">Game time</div>
          <div className="timer-value">{formatTime(elapsedSeconds)}</div>
          <div className="small muted">Remaining {formatTime(remaining)}</div>
        </div>
        <div className="timer-actions-inline">
          <button type="button" className="btn btn-primary" onClick={onStartPause}>{timerRunning ? 'Pause' : 'Start'}</button>
          <button type="button" className="btn btn-ghost" onClick={onResetTimer}>Reset</button>
        </div>
      </div>
      <div className="progress mt-sm"><div style={{ width: `${progress}%` }} /></div>
      {mismatch ? <div className="alert alert-amber mt-sm compact-alert"><strong>Out of sync:</strong> timer says block {timerBlockIndex + 1}. <button type="button" className="btn btn-warning mt-xs full" onClick={onSync}>Sync to timer block</button></div> : null}
      <div className="console-middle">
        <div className="console-panel">
          <div className="group-title">White squad</div>
          <ChipRow title="Go on now" names={row.incomingWhite} tone="green" emptyText={isStart ? 'Starting group' : 'No changes'} />
          <ChipRow title="Come off now" names={row.outgoingWhite} tone="red" emptyText={isStart ? 'Start of game' : 'No changes'} />
        </div>
        <div className="console-panel">
          <div className="group-title">Red squad</div>
          <ChipRow title="Go on now" names={row.incomingRed} tone="green" emptyText={isStart ? 'Starting group' : 'No changes'} />
          <ChipRow title="Come off now" names={row.outgoingRed} tone="red" emptyText={isStart ? 'Start of game' : 'No changes'} />
        </div>
      </div>
      <div className="console-bottom">
        <button type="button" className="btn btn-ghost full" onClick={onBack} disabled={atStart}>Previous</button>
        <button type="button" className="btn btn-primary full next-button" onClick={onNext} disabled={atEnd}>{atEnd ? 'Last block' : 'Next interval'}</button>
      </div>
    </section>
  )
}

function SquadStatusPanel({ squadLabel, players, unavailableSet, returningSet, markUnavailable, markAvailableAgain }) {
  return (
    <section className="card">
      <div className="row between center gap">
        <h2>{squadLabel} status</h2>
        <div className="small muted">Manage in-game injuries / returns</div>
      </div>
      <div className="stack mt-sm">
        {players.map((name) => {
          const status = unavailableSet.has(name) ? 'Unavailable' : returningSet.has(name) ? 'Returning' : 'Available'
          return (
            <div key={`${squadLabel}-${name}`} className="status-row">
              <div className="status-left"><strong>{name}</strong><StatusChip status={status} /></div>
              <div className="status-actions">
                <button type="button" className="btn btn-ghost small-btn" onClick={() => markUnavailable(name)}>Unavailable for rest of game</button>
                <button type="button" className="btn btn-ghost small-btn" onClick={() => markAvailableAgain(name)}>Available again</button>
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}

function AvailabilityPanel({ title, players, absentSet, toggleAbsent, markAllPresent }) {
  return (
    <section className="card">
      <div className="row between start gap">
        <div><h2>{title}</h2><p className="muted">Tap a player to mark them absent or present.</p></div>
        <button type="button" className="btn btn-ghost" onClick={markAllPresent}>Reset</button>
      </div>
      <div className="chip-wrap mt">
        {players.map((player) => {
          const absent = absentSet.has(player)
          return <button key={player} type="button" className={`presence ${absent ? 'absent' : 'present'}`} onClick={() => toggleAbsent(player)}>{player} · {absent ? 'Absent' : 'Present'}</button>
        })}
      </div>
    </section>
  )
}

function NameEditor({ title, names, setNames }) {
  return (
    <section className="card">
      <div className="row between center gap"><h2>{title}</h2><Badge tone="blue">{names.length} listed</Badge></div>
      <textarea className="textarea mt" value={names.join('\n')} onChange={(e) => setNames(e.target.value.split('\n').map((x) => x.trim()).filter(Boolean))} />
      <p className="small muted">One player per line.</p>
    </section>
  )
}

function MinutesSummary({ summary, totalMatchMinutes, intervalMinutes }) {
  return (
    <section className="card no-print">
      <h2>Minutes summary</h2>
      <div className="grid summary-grid mt">
        {summary.map((player) => {
          const isRedSquad = player.group === 'Red squad'
          return (
            <div key={player.name} className={`mini-card minutes-card ${isRedSquad ? 'red-squad-tile' : 'white-squad-tile'}`}>
              <div className="row between start gap">
                <div><strong>{player.name}</strong><div className="small muted">{player.group}</div></div>
                <Badge tone={isRedSquad ? 'red' : 'slate'}>{player.minutes} mins</Badge>
              </div>
              <div className="progress mt-sm"><div className={isRedSquad ? 'progress-red' : ''} style={{ width: `${Math.max(8, totalMatchMinutes ? (player.minutes / totalMatchMinutes) * 100 : 0)}%` }} /></div>
              <div className="small muted mt-sm">{player.intervals} × {intervalMinutes}-minute blocks</div>
            </div>
          )
        })}
      </div>
    </section>
  )
}

function RotationPlan({ rows, currentInterval }) {
  return (
    <section className="card no-print">
      <div className="row between center gap">
        <div><h2>Rotation plan</h2><p className="muted">Completed blocks are greyed and current block is highlighted.</p></div>
        <Badge tone="slate">{rows.length} blocks</Badge>
      </div>
      <div className="stack mt">
        {rows.map((row) => {
          const status = row.intervalIndex < currentInterval ? 'completed' : row.intervalIndex === currentInterval ? 'current' : 'upcoming'
          const statusLabel = status === 'completed' ? 'Done' : status === 'current' ? 'Current' : 'Up next'
          const statusTone = status === 'completed' ? 'slate' : status === 'current' ? 'green' : 'blue'
          return (
            <div key={row.key} className={`mini-card block-card ${status}`}>
              <div className="row between start gap">
                <div><h3>{row.label}</h3><div className="small muted">Match minutes {row.matchLabel}</div></div>
                <div className="column gap-xs align-end"><Badge tone={statusTone}>{statusLabel}</Badge><Badge tone="blue">Block {row.intervalIndex + 1}</Badge></div>
              </div>
              <div className="stack mt-sm">
                <div className="subcard"><h3>White squad</h3><ChipRow title={!row.hasPrevious ? 'Starting on' : 'On now'} names={row.onWhite} tone="blue" emptyText="None" /></div>
                <div className="subcard"><h3>Red squad</h3><ChipRow title={!row.hasPrevious ? 'Starting on' : 'On now'} names={row.onRed} tone="blue" emptyText="None" /></div>
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}

function HistoryPanel({ history, onLoadGame }) {
  return (
    <details className="history-panel no-print">
      <summary>Previous game records ({history.length})</summary>
      <div className="stack mt-sm">
        {history.length ? history.map((record) => (
          <div key={record.id} className="mini-card history-card">
            <div className="row between start gap">
              <div><strong>{record.gameDate}</strong><div className="small muted">White avg {record.perPlayerMinutesWhite?.toFixed?.(1) ?? '0'} mins · Red avg {record.perPlayerMinutesRed?.toFixed?.(1) ?? '0'} mins</div></div>
              <button type="button" className="btn btn-ghost" onClick={() => onLoadGame(record.id)}>Load</button>
            </div>
          </div>
        )) : <div className="card"><div className="small muted">No previous games saved yet.</div></div>}
      </div>
    </details>
  )
}

function GameTools(props) {
  const {
    gameDate, historyCount, onArchiveAndStartNew,
    currentSwapState, setCurrentSwapState,
    futureState, setFutureState,
    currentRow, whiteBench, redBench, totalBlocks,
    onApplyCurrentSwap, onApplyFutureReturn,
    overrideItems, onClearOverride, onClearAllOverrides,
    children,
  } = props
  const currentSquad = currentSwapState.squad || 'white'
  const currentOnList = currentSquad === 'white' ? (currentRow?.onWhite || []) : (currentRow?.onRed || [])
  const currentBench = currentSquad === 'white' ? whiteBench : redBench
  const futureSquad = futureState.squad || 'white'
  const futureOptions = futureSquad === 'white' ? uniq([...(currentRow?.onWhite || []), ...whiteBench]) : uniq([...(currentRow?.onRed || []), ...redBench])
  return (
    <details className="game-tools no-print">
      <summary>Game Tools</summary>
      <div className="stack mt-sm">
        <section className="card discreet-tools">
          <div className="tool-heading">Quick current block swap</div>
          <p className="small muted">Swap out a player mid-block and the rest of the game rebuilds from that change.</p>
          <div className="grid two-up mt-sm">
            <label><span>Squad</span><select value={currentSwapState.squad} onChange={(e) => setCurrentSwapState((c) => ({ ...c, squad: e.target.value, outgoing: '', incoming: '' }))}><option value="white">White squad</option><option value="red">Red squad</option></select></label>
            <label><span>Player coming off now</span><select value={currentSwapState.outgoing} onChange={(e) => setCurrentSwapState((c) => ({ ...c, outgoing: e.target.value }))}><option value="">Choose player</option>{currentOnList.map((name) => <option key={name} value={name}>{name}</option>)}</select></label>
            <label className="span-two"><span>Player going back on now</span><select value={currentSwapState.incoming} onChange={(e) => setCurrentSwapState((c) => ({ ...c, incoming: e.target.value }))}><option value="">Choose player</option>{currentBench.map((name) => <option key={name} value={name}>{name}</option>)}</select></label>
          </div>
          <button type="button" className="btn btn-ghost mt-sm" onClick={onApplyCurrentSwap}>Apply current block swap</button>
        </section>

        <section className="card discreet-tools">
          <div className="tool-heading">Re-enter a player into an upcoming block</div>
          <p className="small muted">Force a player back into a selected future block if the player is okay to return later.</p>
          <div className="grid two-up mt-sm">
            <label><span>Squad</span><select value={futureState.squad} onChange={(e) => setFutureState((c) => ({ ...c, squad: e.target.value, player: '' }))}><option value="white">White squad</option><option value="red">Red squad</option></select></label>
            <label><span>Upcoming block</span><select value={futureState.block} onChange={(e) => setFutureState((c) => ({ ...c, block: e.target.value }))}>{Array.from({ length: Math.max(totalBlocks, 0) }, (_, idx) => idx).filter((i) => i > 0).map((i) => <option key={i} value={String(i)}>{`Block ${i + 1}`}</option>)}</select></label>
            <label className="span-two"><span>Player to force back in</span><select value={futureState.player} onChange={(e) => setFutureState((c) => ({ ...c, player: e.target.value }))}><option value="">Choose player</option>{futureOptions.map((name) => <option key={name} value={name}>{name}</option>)}</select></label>
          </div>
          <button type="button" className="btn btn-ghost mt-sm" onClick={onApplyFutureReturn}>Add to upcoming block</button>
        </section>

        <section className="card discreet-tools">
          <div className="row between center gap"><div><div className="tool-heading">Manual changes currently applied</div><div className="small muted">These affect the rebuilt schedule from the block you changed onward.</div></div><button type="button" className="btn btn-ghost" onClick={onClearAllOverrides}>Clear all</button></div>
          <div className="stack mt-sm">
            {overrideItems.length ? overrideItems.map((item) => (
              <div key={item.key} className="mini-card history-card">
                <div className="row between start gap"><div><strong>{item.squadLabel} · {item.blockLabel}</strong><div className="small muted">On: {item.forceOn.join(', ') || 'None'} · Off: {item.forceOff.join(', ') || 'None'}</div></div><button type="button" className="btn btn-ghost" onClick={() => onClearOverride(item.squadLabel === 'White squad' ? 'white' : 'red', item.blockIndex)}>Remove</button></div>
              </div>
            )) : <div className="small muted">No manual changes saved yet.</div>}
          </div>
        </section>

        <section className="card discreet-tools">
          <div className="tool-heading">New game page</div>
          <p className="small muted">Archive this game, then start a fresh page for the next game week.</p>
          <button type="button" className="btn btn-ghost" onClick={() => onArchiveAndStartNew(nextWeekIso(gameDate))}>Archive game & start next week</button>
          <div className="small muted mt-sm">Saved previous games: {historyCount}</div>
        </section>

        {children}
      </div>
    </details>
  )
}

export default function App() {
  const saved = useRef(loadState())
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
  const duplicateNames = cleanWhite.filter((p) => cleanRed.includes(p))
  const absentSetWhite = useMemo(() => new Set(absentWhite.filter((name) => cleanWhite.includes(name))), [absentWhite, cleanWhite])
  const absentSetRed = useMemo(() => new Set(absentRed.filter((name) => cleanRed.includes(name))), [absentRed, cleanRed])
  const unavailableSetWhite = useMemo(() => new Set(unavailableWhite.filter((name) => cleanWhite.includes(name))), [unavailableWhite, cleanWhite])
  const unavailableSetRed = useMemo(() => new Set(unavailableRed.filter((name) => cleanRed.includes(name))), [unavailableRed, cleanRed])
  const returningSetWhite = useMemo(() => new Set(returningWhite.filter((name) => cleanWhite.includes(name))), [returningWhite, cleanWhite])
  const returningSetRed = useMemo(() => new Set(returningRed.filter((name) => cleanRed.includes(name))), [returningRed, cleanRed])

  const availableWhite = useMemo(() => cleanWhite.filter((name) => !absentSetWhite.has(name) && !unavailableSetWhite.has(name)), [cleanWhite, absentSetWhite, unavailableSetWhite])
  const availableRed = useMemo(() => cleanRed.filter((name) => !absentSetRed.has(name) && !unavailableSetRed.has(name)), [cleanRed, absentSetRed, unavailableSetRed])
  const availableTotal = availableWhite.length + availableRed.length

  const sortedHistory = useMemo(() => [...gameHistory].sort((a, b) => (a.gameDate || '').localeCompare(b.gameDate || '')), [gameHistory])
  const previousGame = useMemo(() => {
    const earlier = sortedHistory.filter((record) => (record.gameDate || '') < gameDate)
    return earlier.length ? earlier[earlier.length - 1] : null
  }, [sortedHistory, gameDate])
  const priorMinutes = useMemo(() => previousMinutesMap(previousGame), [previousGame])
  const split = useMemo(() => findBestSplit(totalOnField, availableWhite.length, availableRed.length, intervals, intervalMinutes), [totalOnField, availableWhite.length, availableRed.length, intervals, intervalMinutes])
  const whiteSpots = split?.whiteSpots ?? 0
  const redSpots = split?.redSpots ?? 0
  const schedule = useMemo(() => buildSchedule({ whiteSquadPlayers: availableWhite, redSquadPlayers: availableRed, whiteSpots, redSpots, intervals, intervalMinutes, halfMinutes, priorMinutes, overrides }), [availableWhite, availableRed, whiteSpots, redSpots, intervals, intervalMinutes, halfMinutes, priorMinutes, overrides])
  const summarySafe = schedule.summary || []
  const fairnessMin = summarySafe.length ? Math.min(...summarySafe.map((s) => s.minutes)) : 0
  const fairnessMax = summarySafe.length ? Math.max(...summarySafe.map((s) => s.minutes)) : 0
  const maxIntervalIndex = Math.max(0, schedule.rows.length - 1)
  const timerBlockIndex = schedule.rows.length ? Math.min(Math.floor(elapsedSeconds / Math.max(1, blockSeconds)), maxIntervalIndex) : 0
  const mismatch = schedule.rows.length > 0 && currentInterval !== timerBlockIndex
  const liveRow = schedule.rows[currentInterval] ?? null
  const whiteBench = liveRow ? availableWhite.filter((name) => !liveRow.onWhite.includes(name)) : availableWhite
  const redBench = liveRow ? availableRed.filter((name) => !liveRow.onRed.includes(name)) : availableRed
  const currentBlockLabel = liveRow?.label || 'No block'
  const overrideItems = useMemo(() => overrideSummaryItems(overrides, schedule.rows), [overrides, schedule.rows])

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
    const payload = {
      gameDate, halfMinutes, intervalMinutes, totalOnField,
      whiteSquadPlayers: cleanWhite, redSquadPlayers: cleanRed,
      absentWhite: Array.from(absentSetWhite), absentRed: Array.from(absentSetRed),
      unavailableWhite: Array.from(unavailableSetWhite), unavailableRed: Array.from(unavailableSetRed),
      returningWhite: Array.from(returningSetWhite), returningRed: Array.from(returningSetRed),
      currentInterval, elapsedSeconds, timerRunning, gameHistory, overrides,
    }
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload))
  }, [gameDate, halfMinutes, intervalMinutes, totalOnField, cleanWhite, cleanRed, absentSetWhite, absentSetRed, unavailableSetWhite, unavailableSetRed, returningSetWhite, returningSetRed, currentInterval, elapsedSeconds, timerRunning, gameHistory, overrides])

  useEffect(() => {
    setFutureState((current) => ({ ...current, block: String(Math.min(Math.max(currentInterval + 1, 1), Math.max(maxIntervalIndex, 1))) }))
  }, [currentInterval, maxIntervalIndex])

  const canGenerate = intervalMinutes > 0 && halfMinutes > 0 && halfMinutes % intervalMinutes === 0 && totalOnField <= availableTotal && !duplicateNames.length && !!split

  const applyOverrideUpdate = (squadKey, blockIndex, updates) => {
    setOverrides((current) => {
      const next = { ...current, [squadKey]: { ...(current[squadKey] || {}) } }
      const key = String(blockIndex)
      const merged = mergeOverride(next[squadKey][key], updates)
      if (!merged.forceOn.length && !merged.forceOff.length) delete next[squadKey][key]
      else next[squadKey][key] = merged
      return next
    })
  }
  const clearOverride = (squadKey, blockIndex) => setOverrides((current) => { const next = { ...current, [squadKey]: { ...(current[squadKey] || {}) } }; delete next[squadKey][String(blockIndex)]; return next })
  const clearAllOverrides = () => setOverrides({ white: {}, red: {} })
  const onApplyCurrentSwap = () => {
    if (!currentSwapState.outgoing || !currentSwapState.incoming) return
    applyOverrideUpdate(currentSwapState.squad, currentInterval, { forceOff: [currentSwapState.outgoing], forceOn: [currentSwapState.incoming] })
    setCurrentSwapState((c) => ({ ...c, outgoing: '', incoming: '' }))
  }
  const onApplyFutureReturn = () => {
    if (!futureState.player) return
    const blockIndex = Number(futureState.block)
    if (Number.isNaN(blockIndex)) return
    applyOverrideUpdate(futureState.squad, blockIndex, { forceOn: [futureState.player] })
    if (futureState.squad === 'white') {
      setUnavailableWhite((cur) => cur.filter((name) => name !== futureState.player))
      setReturningWhite((cur) => uniq([...cur, futureState.player]))
    } else {
      setUnavailableRed((cur) => cur.filter((name) => name !== futureState.player))
      setReturningRed((cur) => uniq([...cur, futureState.player]))
    }
    setFutureState((c) => ({ ...c, player: '' }))
  }
  const markUnavailable = (squadKey, player) => {
    if (squadKey === 'white') {
      setUnavailableWhite((cur) => uniq([...cur, player]))
      setReturningWhite((cur) => cur.filter((name) => name !== player))
      if (liveRow?.onWhite.includes(player)) applyOverrideUpdate('white', currentInterval, { forceOff: [player] })
    } else {
      setUnavailableRed((cur) => uniq([...cur, player]))
      setReturningRed((cur) => cur.filter((name) => name !== player))
      if (liveRow?.onRed.includes(player)) applyOverrideUpdate('red', currentInterval, { forceOff: [player] })
    }
  }
  const markAvailableAgain = (squadKey, player) => {
    if (squadKey === 'white') {
      setUnavailableWhite((cur) => cur.filter((name) => name !== player))
      setReturningWhite((cur) => uniq([...cur, player]))
    } else {
      setUnavailableRed((cur) => cur.filter((name) => name !== player))
      setReturningRed((cur) => uniq([...cur, player]))
    }
  }
  const archiveCurrentGame = (nextDate) => {
    const record = {
      id: `${gameDate}-${Date.now()}`,
      gameDate, halfMinutes, intervalMinutes, totalOnField,
      whiteSpots, redSpots, summary: summarySafe,
      elapsedSeconds, currentInterval,
      perPlayerMinutesWhite: whiteSpots && availableWhite.length ? (whiteSpots * intervals * intervalMinutes) / availableWhite.length : 0,
      perPlayerMinutesRed: redSpots && availableRed.length ? (redSpots * intervals * intervalMinutes) / availableRed.length : 0,
    }
    setGameHistory((current) => [...current, record].sort((a, b) => (a.gameDate || '').localeCompare(b.gameDate || '')))
    setGameDate(nextDate || nextWeekIso(gameDate))
    setAbsentWhite([]); setAbsentRed([])
    setUnavailableWhite([]); setUnavailableRed([])
    setReturningWhite([]); setReturningRed([])
    setCurrentInterval(0); setElapsedSeconds(0); setTimerRunning(false)
    setOverrides({ white: {}, red: {} })
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }
  const loadHistoricalGame = (recordId) => {
    const selected = sortedHistory.find((item) => item.id === recordId)
    if (!selected) return
    setGameDate(selected.gameDate || todayIso())
    setHalfMinutes(selected.halfMinutes || 25)
    setIntervalMinutes(selected.intervalMinutes || 5)
    setTotalOnField(selected.totalOnField || 9)
    setCurrentInterval(0); setElapsedSeconds(0); setTimerRunning(false)
    setOverrides({ white: {}, red: {} })
    setUnavailableWhite([]); setUnavailableRed([]); setReturningWhite([]); setReturningRed([])
  }

  return (
    <div className="app-shell">
      <div className="container">
        <section className="hero no-print compact-hero"><h1>Rugby Subs</h1><p>Built for quick sideline use.</p></section>
        <TopMetaBar gameDate={gameDate} setGameDate={setGameDate} previousGameDate={previousGame?.gameDate || ''} />
        <div className="status-bar no-print">
          <Badge tone="slate">Available: {availableTotal}</Badge>
          <Badge tone="blue">On field: {totalOnField}</Badge>
          <Badge tone="blue">Split: {whiteSpots} + {redSpots}</Badge>
          <Badge tone={fairnessMax - fairnessMin <= intervalMinutes ? 'green' : 'amber'}>Spread: {fairnessMin}-{fairnessMax} mins</Badge>
        </div>
        <div className="layout mobile-first-layout">
          <div className="sidebar no-print top-stack">
            <CompactLiveConsole
              row={liveRow}
              totalBlocks={schedule.rows.length}
              currentIndex={currentInterval}
              elapsedSeconds={elapsedSeconds}
              totalMatchSeconds={totalMatchSeconds}
              timerRunning={timerRunning}
              onStartPause={() => setTimerRunning((v) => !v)}
              onResetTimer={() => { setTimerRunning(false); setElapsedSeconds(0) }}
              onNext={() => setCurrentInterval((v) => Math.min(v + 1, maxIntervalIndex))}
              onBack={() => setCurrentInterval((v) => Math.max(v - 1, 0))}
              onSync={() => setCurrentInterval(timerBlockIndex)}
              timerBlockIndex={timerBlockIndex}
              mismatch={mismatch}
            />
            <GameTools
              gameDate={gameDate}
              historyCount={sortedHistory.length}
              onArchiveAndStartNew={archiveCurrentGame}
              currentSwapState={currentSwapState}
              setCurrentSwapState={setCurrentSwapState}
              futureState={futureState}
              setFutureState={setFutureState}
              currentRow={liveRow}
              whiteBench={whiteBench}
              redBench={redBench}
              totalBlocks={schedule.rows.length}
              onApplyCurrentSwap={onApplyCurrentSwap}
              onApplyFutureReturn={onApplyFutureReturn}
              overrideItems={overrideItems}
              onClearOverride={clearOverride}
              onClearAllOverrides={clearAllOverrides}
            >
              <section className="card">
                <h2>Match setup</h2>
                <div className="grid three mt">
                  <label><span>Minutes per half</span><input type="number" min="1" value={halfMinutes} onChange={(e) => setHalfMinutes(Number(e.target.value) || 0)} /></label>
                  <label><span>Sub interval</span><input type="number" min="1" value={intervalMinutes} onChange={(e) => setIntervalMinutes(Number(e.target.value) || 0)} /></label>
                  <label className="span-two"><span>Total players on field at one time</span><input type="number" min="1" max={Math.max(1, availableTotal || 1)} value={totalOnField} onChange={(e) => setTotalOnField(Number(e.target.value) || 0)} /></label>
                </div>
                <div className="row wrap gap mt">
                  <Badge tone="slate">Listed: {cleanWhite.length + cleanRed.length}</Badge>
                  <Badge tone="slate">Intervals: {intervals}</Badge>
                  <Badge tone="slate">Game: {totalMatchMinutes} mins</Badge>
                  <Badge tone="blue">Current block: {schedule.rows.length ? currentInterval + 1 : 0}/{schedule.rows.length}</Badge>
                  <Badge tone="blue">Timer block: {schedule.rows.length ? timerBlockIndex + 1 : 0}/{schedule.rows.length}</Badge>
                </div>
                {!canGenerate ? <div className="alert mt"><strong>Please fix the setup</strong><ul>{halfMinutes % intervalMinutes !== 0 ? <li key='1'>Minutes per half must divide evenly by the sub interval.</li> : null}{totalOnField > availableTotal ? <li key='2'>Total players on field cannot exceed available players.</li> : null}{duplicateNames.length ? <li key='3'>Each player name must appear only once across both squads.</li> : null}{!split ? <li key='4'>No valid split could be found with the current available-player setting.</li> : null}</ul></div> : null}
                <button type="button" className="btn btn-primary full mt" onClick={() => download('rugby-interchange-schedule.csv', toCsv(schedule, { gameDate, totalOnField, whiteSpots, redSpots, absentWhite: Array.from(absentSetWhite), absentRed: Array.from(absentSetRed), elapsedSeconds, currentInterval, currentBlockLabel }), 'text/csv;charset=utf-8;')} disabled={!canGenerate}>Download CSV schedule</button>
              </section>
              <SquadStatusPanel squadLabel="White squad" players={cleanWhite} unavailableSet={unavailableSetWhite} returningSet={returningSetWhite} markUnavailable={(name) => markUnavailable('white', name)} markAvailableAgain={(name) => markAvailableAgain('white', name)} />
              <SquadStatusPanel squadLabel="Red squad" players={cleanRed} unavailableSet={unavailableSetRed} returningSet={returningSetRed} markUnavailable={(name) => markUnavailable('red', name)} markAvailableAgain={(name) => markAvailableAgain('red', name)} />
              <AvailabilityPanel title="White squad availability" players={cleanWhite} absentSet={absentSetWhite} toggleAbsent={(name) => setAbsentWhite((cur) => cur.includes(name) ? cur.filter((v) => v !== name) : [...cur, name])} markAllPresent={() => setAbsentWhite([])} />
              <AvailabilityPanel title="Red squad availability" players={cleanRed} absentSet={absentSetRed} toggleAbsent={(name) => setAbsentRed((cur) => cur.includes(name) ? cur.filter((v) => v !== name) : [...cur, name])} markAllPresent={() => setAbsentRed([])} />
              <NameEditor title="White squad names" names={cleanWhite} setNames={setWhiteSquadPlayers} />
              <NameEditor title="Red squad names" names={cleanRed} setNames={setRedSquadPlayers} />
            </GameTools>
            <HistoryPanel history={sortedHistory} onLoadGame={loadHistoricalGame} />
          </div>
          <div className="main">
            <MinutesSummary summary={summarySafe} totalMatchMinutes={totalMatchMinutes} intervalMinutes={intervalMinutes} />
            <RotationPlan rows={schedule.rows} currentInterval={currentInterval} />
          </div>
        </div>
      </div>
    </div>
  )
}
