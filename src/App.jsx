import React, { useEffect, useMemo, useRef, useState } from 'react';

const STORAGE_KEY = 'rugby-interchange-history-v5';
const WHITE_SQUAD = ['Ikaia', 'Daniel', 'Hazel', 'Leon', 'Caleb', 'Seb'];
const RED_SQUAD = ['Xavier', 'Marcus', 'Manaia', 'Owen', 'Noah', 'Isaac', 'Andre', 'Te Manawa', 'Ted'];

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function nextWeekIso(dateText) {
  const base = new Date(`${dateText}T12:00:00`);
  if (Number.isNaN(base.getTime())) return todayIso();
  base.setDate(base.getDate() + 7);
  return base.toISOString().slice(0, 10);
}

const DEFAULT_STATE = {
  gameDate: todayIso(),
  halfMinutes: 25,
  intervalMinutes: 5,
  totalOnField: 9,
  whiteSquadPlayers: WHITE_SQUAD,
  redSquadPlayers: RED_SQUAD,
  absentWhite: [],
  absentRed: [],
  currentInterval: 0,
  elapsedSeconds: 0,
  timerRunning: false,
  gameHistory: [],
  overrides: { white: {}, red: {} },
};

function loadSavedState() {
  if (typeof window === 'undefined') return DEFAULT_STATE;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_STATE;
    const parsed = JSON.parse(raw);
    return {
      ...DEFAULT_STATE,
      ...parsed,
      whiteSquadPlayers: Array.isArray(parsed.whiteSquadPlayers) ? parsed.whiteSquadPlayers : WHITE_SQUAD,
      redSquadPlayers: Array.isArray(parsed.redSquadPlayers) ? parsed.redSquadPlayers : RED_SQUAD,
      absentWhite: Array.isArray(parsed.absentWhite) ? parsed.absentWhite : [],
      absentRed: Array.isArray(parsed.absentRed) ? parsed.absentRed : [],
      gameHistory: Array.isArray(parsed.gameHistory) ? parsed.gameHistory : [],
      elapsedSeconds: Number.isFinite(parsed.elapsedSeconds) ? parsed.elapsedSeconds : 0,
      timerRunning: Boolean(parsed.timerRunning),
      gameDate: typeof parsed.gameDate === 'string' && parsed.gameDate ? parsed.gameDate : todayIso(),
      overrides: parsed.overrides && typeof parsed.overrides === 'object'
        ? { white: parsed.overrides.white || {}, red: parsed.overrides.red || {} }
        : { white: {}, red: {} },
    };
  } catch {
    return DEFAULT_STATE;
  }
}

function registerServiceWorker() {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}

function formatTime(totalSeconds) {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(safe / 60);
  const seconds = safe % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function minutesMapFromRecord(record) {
  const map = {};
  (record?.summary || []).forEach((item) => {
    map[item.name] = item.minutes;
  });
  return map;
}

function normaliseOverride(override = {}) {
  return {
    forceOn: Array.isArray(override.forceOn) ? Array.from(new Set(override.forceOn)) : [],
    forceOff: Array.isArray(override.forceOff) ? Array.from(new Set(override.forceOff)) : [],
  };
}

function getOverrideForBlock(overridesBySquad, squadKey, blockIndex) {
  const raw = overridesBySquad?.[squadKey]?.[String(blockIndex)] || {};
  return normaliseOverride(raw);
}

function pickPlayers(players, spots, fairnessScores, playCounts, lastPlayed, intervalIndex, cursor, override) {
  if (!players.length || spots <= 0) return { selected: [], nextCursor: 0 };

  const forceOff = new Set((override?.forceOff || []).filter((name) => players.includes(name)));
  const forceOnOrdered = players.filter((name) => (override?.forceOn || []).includes(name) && !forceOff.has(name));
  const selected = forceOnOrdered.slice(0, Math.min(spots, forceOnOrdered.length));

  const remainingPool = players
    .filter((name) => !selected.includes(name) && !forceOff.has(name))
    .map((name, idx) => ({
      name,
      idx: players.indexOf(name),
      score: fairnessScores[name] ?? 0,
      currentBlocks: playCounts[name] ?? 0,
      last: lastPlayed[name] ?? -999,
      ring: (players.indexOf(name) - cursor + players.length) % players.length,
    }))
    .sort((a, b) => {
      if (a.score !== b.score) return a.score - b.score;
      if (a.currentBlocks !== b.currentBlocks) return a.currentBlocks - b.currentBlocks;
      if (a.last !== b.last) return a.last - b.last;
      return a.ring - b.ring;
    })
    .slice(0, Math.max(0, spots - selected.length))
    .sort((a, b) => a.idx - b.idx)
    .map((item) => item.name);

  const finalSelected = [...selected, ...remainingPool].sort((a, b) => players.indexOf(a) - players.indexOf(b));
  const nextCursor = finalSelected.length ? (players.indexOf(finalSelected[finalSelected.length - 1]) + 1) % players.length : cursor;

  finalSelected.forEach((name) => {
    fairnessScores[name] = (fairnessScores[name] ?? 0) + 1;
    playCounts[name] = (playCounts[name] ?? 0) + 1;
    lastPlayed[name] = intervalIndex;
  });

  return { selected: finalSelected, nextCursor };
}

function findBestSplit(totalOnField, whiteSize, redSize, intervals, intervalMinutes) {
  let best = null;
  for (let whiteSpots = 0; whiteSpots <= Math.min(whiteSize, totalOnField); whiteSpots += 1) {
    const redSpots = totalOnField - whiteSpots;
    if (redSpots < 0 || redSpots > redSize) continue;

    const avgWhite = whiteSize ? (whiteSpots * intervals) / whiteSize : 0;
    const avgRed = redSize ? (redSpots * intervals) / redSize : 0;
    const whiteMinutes = avgWhite * intervalMinutes;
    const redMinutes = avgRed * intervalMinutes;
    const spread = Math.abs(whiteMinutes - redMinutes);
    const exactWithinSquads = Number.isInteger(avgWhite) && Number.isInteger(avgRed);
    const option = { whiteSpots, redSpots, whiteMinutes, redMinutes, spread, exactWithinSquads };

    if (!best) {
      best = option;
      continue;
    }
    if (option.spread < best.spread) {
      best = option;
      continue;
    }
    if (option.spread === best.spread) {
      if (option.exactWithinSquads && !best.exactWithinSquads) {
        best = option;
        continue;
      }
      const benchOption = (whiteSize - option.whiteSpots) + (redSize - option.redSpots);
      const benchBest = (whiteSize - best.whiteSpots) + (redSize - best.redSpots);
      if (benchOption < benchBest) {
        best = option;
        continue;
      }
      if (benchOption === benchBest && option.whiteSpots > best.whiteSpots) {
        best = option;
      }
    }
  }
  return best;
}

function getDiff(previous, current) {
  if (!previous) return { incoming: current, outgoing: [], hasPrevious: false };
  return {
    incoming: current.filter((name) => !previous.includes(name)),
    outgoing: previous.filter((name) => !current.includes(name)),
    hasPrevious: true,
  };
}

function buildSchedule({ whiteSquadPlayers, redSquadPlayers, whiteSpots, redSpots, intervals, intervalMinutes, halfMinutes, previousMinutes, overrides }) {
  const fairnessScores = {};
  const playCounts = {};
  const lastPlayed = {};
  [...whiteSquadPlayers, ...redSquadPlayers].forEach((name) => {
    fairnessScores[name] = (previousMinutes[name] ?? 0) / Math.max(1, intervalMinutes);
    playCounts[name] = 0;
    lastPlayed[name] = -999;
  });

  let cursorWhite = 0;
  let cursorRed = 0;
  let prevOnWhite = null;
  let prevOnRed = null;
  const rows = [];

  for (let i = 0; i < intervals; i += 1) {
    const start = i * intervalMinutes;
    const end = start + intervalMinutes;
    const half = start < halfMinutes ? 1 : 2;
    const minuteInHalfStart = half === 1 ? start : start - halfMinutes;
    const minuteInHalfEnd = half === 1 ? end : end - halfMinutes;

    const whiteOverride = getOverrideForBlock(overrides, 'white', i);
    const redOverride = getOverrideForBlock(overrides, 'red', i);

    const pickWhite = pickPlayers(whiteSquadPlayers, whiteSpots, fairnessScores, playCounts, lastPlayed, i, cursorWhite, whiteOverride);
    const pickRed = pickPlayers(redSquadPlayers, redSpots, fairnessScores, playCounts, lastPlayed, i, cursorRed, redOverride);
    cursorWhite = pickWhite.nextCursor;
    cursorRed = pickRed.nextCursor;

    const diffWhite = getDiff(prevOnWhite, pickWhite.selected);
    const diffRed = getDiff(prevOnRed, pickRed.selected);

    rows.push({
      key: i,
      intervalIndex: i,
      label: `H${half} ${minuteInHalfStart}-${minuteInHalfEnd}`,
      matchLabel: `${start}-${end}`,
      onWhite: pickWhite.selected,
      onRed: pickRed.selected,
      incomingWhite: diffWhite.incoming,
      outgoingWhite: diffWhite.outgoing,
      incomingRed: diffRed.incoming,
      outgoingRed: diffRed.outgoing,
      hasPrevious: diffWhite.hasPrevious || diffRed.hasPrevious,
      whiteOverride,
      redOverride,
    });

    prevOnWhite = pickWhite.selected;
    prevOnRed = pickRed.selected;
  }

  const summary = [...whiteSquadPlayers, ...redSquadPlayers].map((name) => ({
    name,
    intervals: playCounts[name],
    minutes: playCounts[name] * intervalMinutes,
    group: whiteSquadPlayers.includes(name) ? 'White squad' : 'Red squad',
  }));

  const avgWhite = whiteSquadPlayers.length ? (whiteSpots * intervals) / whiteSquadPlayers.length : 0;
  const avgRed = redSquadPlayers.length ? (redSpots * intervals) / redSquadPlayers.length : 0;

  return {
    rows,
    summary,
    exactWithinSquads: Number.isInteger(avgWhite) && Number.isInteger(avgRed),
    perPlayerMinutesWhite: avgWhite * intervalMinutes,
    perPlayerMinutesRed: avgRed * intervalMinutes,
  };
}

function mergeOverride(existing, updates) {
  const current = normaliseOverride(existing);
  const next = {
    forceOn: Array.from(new Set([...(current.forceOn || []), ...(updates.forceOn || [])])).filter(Boolean),
    forceOff: Array.from(new Set([...(current.forceOff || []), ...(updates.forceOff || [])])).filter(Boolean),
  };
  next.forceOn = next.forceOn.filter((name) => !next.forceOff.includes(name));
  return next;
}

function overrideSummaryItems(overrides, rows) {
  const items = [];
  ['white', 'red'].forEach((squadKey) => {
    Object.entries(overrides?.[squadKey] || {}).forEach(([blockText, override]) => {
      const blockIndex = Number(blockText);
      const row = rows[blockIndex];
      if (!row) return;
      const o = normaliseOverride(override);
      if (!o.forceOn.length && !o.forceOff.length) return;
      items.push({
        key: `${squadKey}-${blockIndex}`,
        squadLabel: squadKey === 'white' ? 'White squad' : 'Red squad',
        blockIndex,
        blockLabel: row.label,
        forceOn: o.forceOn,
        forceOff: o.forceOff,
      });
    });
  });
  return items.sort((a, b) => a.blockIndex - b.blockIndex || a.squadLabel.localeCompare(b.squadLabel));
}

function download(filename, text, mime = 'text/plain;charset=utf-8;') {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.setAttribute('download', filename);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function toCsv(schedule, meta) {
  const intro = [
    ['Game date', meta.gameDate],
    ['Total players on field', meta.totalOnField],
    ['Suggested split', `${meta.whiteSpots} from White squad / ${meta.redSpots} from Red squad`],
    ['Elapsed game time', formatTime(meta.elapsedSeconds)],
    ['Active block', meta.currentBlockLabel],
    ['Absent from White squad', meta.absentWhite.join(' | ') || 'None'],
    ['Absent from Red squad', meta.absentRed.join(' | ') || 'None'],
    [],
  ];
  const header = [
    'Interval', 'Match Minutes', 'Status',
    'White squad on', 'White squad on now', 'White squad off now',
    'Red squad on', 'Red squad on now', 'Red squad off now',
  ];
  const rows = schedule.rows.map((r, idx) => {
    let status = 'Upcoming';
    if (idx < meta.currentInterval) status = 'Completed';
    if (idx === meta.currentInterval) status = 'Current';
    return [
      r.label, r.matchLabel, status,
      r.onWhite.join(' | '), r.incomingWhite.join(' | '), r.outgoingWhite.join(' | '),
      r.onRed.join(' | '), r.incomingRed.join(' | '), r.outgoingRed.join(' | '),
    ];
  });
  const summaryHeader = ['Player', 'Squad', 'Blocks', 'Minutes'];
  const summaryRows = schedule.summary.map((s) => [s.name, s.group, s.intervals, s.minutes]);
  return [...intro, header, ...rows, [], summaryHeader, ...summaryRows]
    .map((line) => line.map((cell) => `"${String(cell ?? '').replaceAll('"', '""')}"`).join(','))
    .join('\n');
}

function Badge({ tone = 'slate', children }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}

function PlayerChip({ name, tone = 'slate' }) {
  return <span className={`chip ${tone}`}>{name}</span>;
}

function ChipRow({ title, names, tone, emptyText = 'None' }) {
  return (
    <div>
      <div className="eyebrow">{title}</div>
      <div className="chip-wrap compact">
        {names.length ? names.map((name) => <PlayerChip key={`${title}-${name}`} name={name} tone={tone} />) : <div className="muted">{emptyText}</div>}
      </div>
    </div>
  );
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
  );
}

function CompactLiveConsole({ row, totalBlocks, currentIndex, elapsedSeconds, totalMatchSeconds, timerRunning, onStartPause, onResetTimer, onNext, onBack, onSync, timerBlockIndex, mismatch }) {
  if (!row) return null;
  const atEnd = currentIndex >= totalBlocks - 1;
  const atStart = currentIndex <= 0;
  const isStart = !row.hasPrevious;
  const remaining = Math.max(0, totalMatchSeconds - elapsedSeconds);
  const progress = totalMatchSeconds ? Math.min(100, (elapsedSeconds / totalMatchSeconds) * 100) : 0;

  return (
    <section className="card live-console no-print">
      <div className="console-top">
        <div>
          <div className="eyebrow">Current block</div>
          <h1 className="console-block-title">{row.label}</h1>
          <p className="muted small">Block {currentIndex + 1} of {totalBlocks} · Match minutes {row.matchLabel}</p>
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

      {mismatch ? (
        <div className="alert alert-amber mt-sm compact-alert">
          <strong>Out of sync:</strong> timer says block {timerBlockIndex + 1}.
          <button type="button" className="btn btn-warning mt-xs full" onClick={onSync}>Sync to timer block</button>
        </div>
      ) : null}

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
  );
}

function NewGameTools({ gameDate, historyCount, onArchiveAndStartNew, currentSwapState, setCurrentSwapState, futureState, setFutureState, currentRow, whiteBench, redBench, totalBlocks, onApplyCurrentSwap, onApplyFutureReturn, overrideItems, onClearOverride, onClearAllOverrides }) {
  const currentSquad = currentSwapState.squad || 'white';
  const currentOnList = currentSquad === 'white' ? (currentRow?.onWhite || []) : (currentRow?.onRed || []);
  const currentBench = currentSquad === 'white' ? whiteBench : redBench;
  const futureSquad = futureState.squad || 'white';
  const futureOptions = futureSquad === 'white' ? currentRow?.onWhite?.concat(whiteBench).filter(Boolean) || whiteBench : currentRow?.onRed?.concat(redBench).filter(Boolean) || redBench;
  const uniqueFutureOptions = Array.from(new Set(futureOptions));

  return (
    <details className="game-tools no-print">
      <summary>Game tools</summary>
      <div className="stack mt-sm">
        <section className="card discreet-tools">
          <div className="tool-heading">Quick current block swap</div>
          <p className="small muted">Use this when someone comes off before the block finishes. It changes the current block and the rest of the game rebuilds from there.</p>
          <div className="grid two-up mt-sm">
            <label>
              <span>Squad</span>
              <select value={currentSwapState.squad} onChange={(e) => setCurrentSwapState((c) => ({ ...c, squad: e.target.value, outgoing: '', incoming: '' }))}>
                <option value="white">White squad</option>
                <option value="red">Red squad</option>
              </select>
            </label>
            <label>
              <span>Player coming off now</span>
              <select value={currentSwapState.outgoing} onChange={(e) => setCurrentSwapState((c) => ({ ...c, outgoing: e.target.value }))}>
                <option value="">Choose player</option>
                {currentOnList.map((name) => <option key={name} value={name}>{name}</option>)}
              </select>
            </label>
            <label className="span-two">
              <span>Player going back on now</span>
              <select value={currentSwapState.incoming} onChange={(e) => setCurrentSwapState((c) => ({ ...c, incoming: e.target.value }))}>
                <option value="">Choose player</option>
                {currentBench.map((name) => <option key={name} value={name}>{name}</option>)}
              </select>
            </label>
          </div>
          <button type="button" className="btn btn-ghost mt-sm" onClick={onApplyCurrentSwap}>Apply current block swap</button>
        </section>

        <section className="card discreet-tools">
          <div className="tool-heading">Re-enter a player into an upcoming block</div>
          <p className="small muted">Use this if a player who came off early is okay to return later. Pick the squad, the future block, and the player to force back in.</p>
          <div className="grid two-up mt-sm">
            <label>
              <span>Squad</span>
              <select value={futureState.squad} onChange={(e) => setFutureState((c) => ({ ...c, squad: e.target.value, player: '' }))}>
                <option value="white">White squad</option>
                <option value="red">Red squad</option>
              </select>
            </label>
            <label>
              <span>Upcoming block</span>
              <select value={futureState.block} onChange={(e) => setFutureState((c) => ({ ...c, block: e.target.value }))}>
                {Array.from({ length: Math.max(0, totalBlocks - 1) }, (_, idx) => idx + 1).map((blockIndex) => (
                  <option key={blockIndex} value={String(blockIndex)}>{`Block ${blockIndex + 1}`}</option>
                ))}
              </select>
            </label>
            <label className="span-two">
              <span>Player to force back in</span>
              <select value={futureState.player} onChange={(e) => setFutureState((c) => ({ ...c, player: e.target.value }))}>
                <option value="">Choose player</option>
                {uniqueFutureOptions.map((name) => <option key={name} value={name}>{name}</option>)}
              </select>
            </label>
          </div>
          <button type="button" className="btn btn-ghost mt-sm" onClick={onApplyFutureReturn}>Add to upcoming block</button>
        </section>

        <section className="card discreet-tools">
          <div className="tool-heading">New game page</div>
          <p className="small muted">Archive this game, then start a fresh page for the next game week. Previous schedules stay in the saved history below.</p>
          <button type="button" className="btn btn-ghost" onClick={() => onArchiveAndStartNew(nextWeekIso(gameDate))}>Archive game & start next week</button>
          <div className="small muted mt-sm">Saved previous games: {historyCount}</div>
        </section>

        <section className="card discreet-tools">
          <div className="row between center gap">
            <div>
              <div className="tool-heading">Manual changes currently applied</div>
              <div className="small muted">These affect the rebuilt schedule from the block you changed onward.</div>
            </div>
            <button type="button" className="btn btn-ghost" onClick={onClearAllOverrides}>Clear all</button>
          </div>
          <div className="stack mt-sm">
            {overrideItems.length ? overrideItems.map((item) => (
              <div key={item.key} className="mini-card history-card">
                <div className="row between start gap">
                  <div>
                    <strong>{item.squadLabel} · {item.blockLabel}</strong>
                    <div className="small muted">On: {item.forceOn.join(', ') || 'None'} · Off: {item.forceOff.join(', ') || 'None'}</div>
                  </div>
                  <button type="button" className="btn btn-ghost" onClick={() => onClearOverride(item.squadLabel === 'White squad' ? 'white' : 'red', item.blockIndex)}>Remove</button>
                </div>
              </div>
            )) : <div className="small muted">No manual changes saved yet.</div>}
          </div>
        </section>
      </div>
    </details>
  );
}

function HistoryPanel({ history, onLoadGame }) {
  return (
    <details className="history-panel no-print">
      <summary>Previous game records ({history.length})</summary>
      <div className="stack mt-sm">
        {history.length ? history.map((record) => (
          <div key={record.id} className="mini-card history-card">
            <div className="row between start gap">
              <div>
                <strong>{record.gameDate}</strong>
                <div className="small muted">White avg {record.perPlayerMinutesWhite?.toFixed?.(1) ?? '0'} mins · Red avg {record.perPlayerMinutesRed?.toFixed?.(1) ?? '0'} mins</div>
              </div>
              <button type="button" className="btn btn-ghost" onClick={() => onLoadGame(record.id)}>Load</button>
            </div>
            <div className="small muted mt-sm">This game is used to balance the next scheduled game after it.</div>
          </div>
        )) : <div className="card"><div className="small muted">No previous games saved yet.</div></div>}
      </div>
    </details>
  );
}

function AvailabilityPanel({ title, players, absentSet, toggleAbsent, markAllPresent }) {
  return (
    <section className="card">
      <div className="row between start gap">
        <div>
          <h2>{title}</h2>
          <p className="muted">Tap a player to mark them absent or present.</p>
        </div>
        <button type="button" className="btn btn-ghost" onClick={markAllPresent}>Reset</button>
      </div>
      <div className="chip-wrap mt">
        {players.map((player) => {
          const absent = absentSet.has(player);
          return (
            <button key={player} type="button" className={`presence ${absent ? 'absent' : 'present'}`} onClick={() => toggleAbsent(player)}>
              {player} · {absent ? 'Absent' : 'Present'}
            </button>
          );
        })}
      </div>
    </section>
  );
}

function NameEditor({ title, names, setNames }) {
  return (
    <section className="card">
      <div className="row between center gap">
        <h2>{title}</h2>
        <Badge tone="blue">{names.length} listed</Badge>
      </div>
      <textarea className="textarea mt" value={names.join('\n')} onChange={(e) => setNames(e.target.value.split('\n').map((x) => x.trim()).filter(Boolean))} />
      <p className="small muted">One player per line.</p>
    </section>
  );
}

function MinutesSummary({ summary, totalMatchMinutes, intervalMinutes }) {
  return (
    <section className="card no-print">
      <h2>Minutes summary</h2>
      <div className="grid summary-grid mt">
        {summary.map((player) => {
          const isRedSquad = player.group === 'Red squad';
          return (
            <div key={player.name} className={`mini-card minutes-card ${isRedSquad ? 'red-squad-tile' : 'white-squad-tile'}`}>
              <div className="row between start gap">
                <div>
                  <strong>{player.name}</strong>
                  <div className="small muted">{player.group}</div>
                </div>
                <Badge tone={isRedSquad ? 'red' : 'slate'}>{player.minutes} mins</Badge>
              </div>
              <div className="progress mt-sm"><div className={isRedSquad ? 'progress-red' : ''} style={{ width: `${Math.max(8, totalMatchMinutes ? (player.minutes / totalMatchMinutes) * 100 : 0)}%` }} /></div>
              <div className="small muted mt-sm">{player.intervals} × {intervalMinutes}-minute blocks</div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function RotationPlan({ rows, currentInterval }) {
  return (
    <section className="card no-print">
      <div className="row between center gap">
        <div>
          <h2>Rotation plan</h2>
          <p className="muted">Completed blocks are greyed and current block is highlighted.</p>
        </div>
        <Badge tone="slate">{rows.length} blocks</Badge>
      </div>
      <div className="stack mt">
        {rows.map((row) => {
          const status = row.intervalIndex < currentInterval ? 'completed' : row.intervalIndex === currentInterval ? 'current' : 'upcoming';
          const statusLabel = status === 'completed' ? 'Done' : status === 'current' ? 'Current' : 'Up next';
          const statusTone = status === 'completed' ? 'slate' : status === 'current' ? 'green' : 'blue';
          return (
            <div key={row.key} className={`mini-card block-card ${status}`}>
              <div className="row between start gap">
                <div>
                  <h3>{row.label}</h3>
                  <div className="small muted">Match minutes {row.matchLabel}</div>
                </div>
                <div className="column gap-xs align-end">
                  <Badge tone={statusTone}>{statusLabel}</Badge>
                  <Badge tone="blue">Block {row.intervalIndex + 1}</Badge>
                </div>
              </div>
              <div className="stack mt-sm">
                <div className="subcard">
                  <h3>White squad</h3>
                  <ChipRow title={!row.hasPrevious ? 'Starting on' : 'On now'} names={row.onWhite} tone="blue" emptyText="None" />
                  {(row.whiteOverride.forceOn.length || row.whiteOverride.forceOff.length) ? <div className="small muted mt-xs">Manual: on {row.whiteOverride.forceOn.join(', ') || 'none'} · off {row.whiteOverride.forceOff.join(', ') || 'none'}</div> : null}
                </div>
                <div className="subcard">
                  <h3>Red squad</h3>
                  <ChipRow title={!row.hasPrevious ? 'Starting on' : 'On now'} names={row.onRed} tone="blue" emptyText="None" />
                  {(row.redOverride.forceOn.length || row.redOverride.forceOff.length) ? <div className="small muted mt-xs">Manual: on {row.redOverride.forceOn.join(', ') || 'none'} · off {row.redOverride.forceOff.join(', ') || 'none'}</div> : null}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

export default function App() {
  const saved = useRef(loadSavedState());
  const [gameDate, setGameDate] = useState(saved.current.gameDate);
  const [halfMinutes, setHalfMinutes] = useState(saved.current.halfMinutes);
  const [intervalMinutes, setIntervalMinutes] = useState(saved.current.intervalMinutes);
  const [totalOnField, setTotalOnField] = useState(saved.current.totalOnField);
  const [whiteSquadPlayers, setWhiteSquadPlayers] = useState(saved.current.whiteSquadPlayers);
  const [redSquadPlayers, setRedSquadPlayers] = useState(saved.current.redSquadPlayers);
  const [absentWhite, setAbsentWhite] = useState(saved.current.absentWhite);
  const [absentRed, setAbsentRed] = useState(saved.current.absentRed);
  const [currentInterval, setCurrentInterval] = useState(saved.current.currentInterval);
  const [elapsedSeconds, setElapsedSeconds] = useState(saved.current.elapsedSeconds);
  const [timerRunning, setTimerRunning] = useState(saved.current.timerRunning);
  const [gameHistory, setGameHistory] = useState(saved.current.gameHistory);
  const [overrides, setOverrides] = useState(saved.current.overrides || { white: {}, red: {} });
  const [currentSwapState, setCurrentSwapState] = useState({ squad: 'white', outgoing: '', incoming: '' });
  const [futureState, setFutureState] = useState({ squad: 'white', block: '1', player: '' });

  const halves = 2;
  const intervals = Math.floor((halfMinutes * halves) / intervalMinutes);
  const totalMatchMinutes = halfMinutes * halves;
  const totalMatchSeconds = totalMatchMinutes * 60;
  const blockSeconds = intervalMinutes * 60;

  const cleanWhite = useMemo(() => Array.from(new Set(whiteSquadPlayers.filter(Boolean))), [whiteSquadPlayers]);
  const cleanRed = useMemo(() => Array.from(new Set(redSquadPlayers.filter(Boolean))), [redSquadPlayers]);
  const duplicateNames = cleanWhite.filter((p) => cleanRed.includes(p));
  const absentSetWhite = useMemo(() => new Set(absentWhite.filter((name) => cleanWhite.includes(name))), [absentWhite, cleanWhite]);
  const absentSetRed = useMemo(() => new Set(absentRed.filter((name) => cleanRed.includes(name))), [absentRed, cleanRed]);
  const availableWhite = useMemo(() => cleanWhite.filter((name) => !absentSetWhite.has(name)), [cleanWhite, absentSetWhite]);
  const availableRed = useMemo(() => cleanRed.filter((name) => !absentSetRed.has(name)), [cleanRed, absentSetRed]);
  const availableTotal = availableWhite.length + availableRed.length;

  const sortedHistory = useMemo(() => [...gameHistory].sort((a, b) => (a.gameDate || '').localeCompare(b.gameDate || '')), [gameHistory]);
  const previousGame = useMemo(() => {
    const earlier = sortedHistory.filter((record) => (record.gameDate || '') < gameDate);
    return earlier.length ? earlier[earlier.length - 1] : null;
  }, [sortedHistory, gameDate]);
  const previousMinutes = useMemo(() => minutesMapFromRecord(previousGame), [previousGame]);

  const suggestedSplit = useMemo(
    () => findBestSplit(totalOnField, availableWhite.length, availableRed.length, intervals, intervalMinutes),
    [totalOnField, availableWhite.length, availableRed.length, intervals, intervalMinutes]
  );
  const whiteSpots = suggestedSplit?.whiteSpots ?? 0;
  const redSpots = suggestedSplit?.redSpots ?? 0;

  const schedule = useMemo(
    () => buildSchedule({ whiteSquadPlayers: availableWhite, redSquadPlayers: availableRed, whiteSpots, redSpots, intervals, intervalMinutes, halfMinutes, previousMinutes, overrides }),
    [availableWhite, availableRed, whiteSpots, redSpots, intervals, intervalMinutes, halfMinutes, previousMinutes, overrides]
  );

  const summarySafe = schedule.summary ?? [];
  const fairnessMin = summarySafe.length ? Math.min(...summarySafe.map((s) => s.minutes)) : 0;
  const fairnessMax = summarySafe.length ? Math.max(...summarySafe.map((s) => s.minutes)) : 0;
  const canGenerate = intervalMinutes > 0 && halfMinutes > 0 && halfMinutes % intervalMinutes === 0 && availableTotal > 0 && totalOnField > 0 && totalOnField <= availableTotal && !!suggestedSplit && duplicateNames.length === 0;
  const maxIntervalIndex = Math.max(0, schedule.rows.length - 1);
  const timerBlockIndex = schedule.rows.length ? Math.min(Math.floor(elapsedSeconds / Math.max(1, blockSeconds)), maxIntervalIndex) : 0;
  const mismatch = schedule.rows.length > 0 && currentInterval !== timerBlockIndex;
  const currentBlockLabel = schedule.rows.length ? schedule.rows[currentInterval]?.label ?? 'No block' : 'No block';
  const overrideItems = useMemo(() => overrideSummaryItems(overrides, schedule.rows), [overrides, schedule.rows]);
  const liveRow = schedule.rows[currentInterval] ?? null;
  const whiteBench = liveRow ? availableWhite.filter((name) => !liveRow.onWhite.includes(name)) : availableWhite;
  const redBench = liveRow ? availableRed.filter((name) => !liveRow.onRed.includes(name)) : availableRed;

  useEffect(() => { registerServiceWorker(); }, []);

  useEffect(() => {
    if (!timerRunning) return undefined;
    const timer = window.setInterval(() => {
      setElapsedSeconds((value) => {
        const next = Math.min(value + 1, totalMatchSeconds);
        if (next >= totalMatchSeconds) setTimerRunning(false);
        return next;
      });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [timerRunning, totalMatchSeconds]);

  useEffect(() => {
    if (currentInterval > maxIntervalIndex) setCurrentInterval(maxIntervalIndex);
  }, [currentInterval, maxIntervalIndex]);

  useEffect(() => {
    if (elapsedSeconds > totalMatchSeconds) setElapsedSeconds(totalMatchSeconds);
  }, [elapsedSeconds, totalMatchSeconds]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const payload = {
      gameDate,
      halfMinutes,
      intervalMinutes,
      totalOnField,
      whiteSquadPlayers: cleanWhite,
      redSquadPlayers: cleanRed,
      absentWhite: Array.from(absentSetWhite),
      absentRed: Array.from(absentSetRed),
      currentInterval,
      elapsedSeconds,
      timerRunning,
      gameHistory,
      overrides,
    };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  }, [gameDate, halfMinutes, intervalMinutes, totalOnField, cleanWhite, cleanRed, absentSetWhite, absentSetRed, currentInterval, elapsedSeconds, timerRunning, gameHistory, overrides]);

  useEffect(() => {
    setFutureState((current) => ({
      ...current,
      block: String(Math.min(Math.max(currentInterval + 1, 1), Math.max(maxIntervalIndex, 1))),
    }));
  }, [currentInterval, maxIntervalIndex]);

  const applyOverrideUpdate = (squadKey, blockIndex, updates) => {
    setOverrides((current) => {
      const squadOverrides = { ...(current[squadKey] || {}) };
      const key = String(blockIndex);
      const merged = mergeOverride(squadOverrides[key], updates);
      if (!merged.forceOn.length && !merged.forceOff.length) {
        delete squadOverrides[key];
      } else {
        squadOverrides[key] = merged;
      }
      return { ...current, [squadKey]: squadOverrides };
    });
  };

  const clearOverride = (squadKey, blockIndex) => {
    setOverrides((current) => {
      const squadOverrides = { ...(current[squadKey] || {}) };
      delete squadOverrides[String(blockIndex)];
      return { ...current, [squadKey]: squadOverrides };
    });
  };

  const clearAllOverrides = () => setOverrides({ white: {}, red: {} });

  const onApplyCurrentSwap = () => {
    const squadKey = currentSwapState.squad;
    const outgoing = currentSwapState.outgoing;
    const incoming = currentSwapState.incoming;
    if (!outgoing || !incoming) return;
    applyOverrideUpdate(squadKey, currentInterval, { forceOn: [incoming], forceOff: [outgoing] });
    setCurrentSwapState((c) => ({ ...c, outgoing: '', incoming: '' }));
  };

  const onApplyFutureReturn = () => {
    const squadKey = futureState.squad;
    const player = futureState.player;
    const blockIndex = Number(futureState.block);
    if (!player || Number.isNaN(blockIndex)) return;
    applyOverrideUpdate(squadKey, blockIndex, { forceOn: [player] });
    setFutureState((c) => ({ ...c, player: '' }));
  };

  const archiveCurrentGame = (nextDate) => {
    const recordId = `${gameDate}-${Date.now()}`;
    const newRecord = {
      id: recordId,
      gameDate,
      savedAt: new Date().toISOString(),
      halfMinutes,
      intervalMinutes,
      totalOnField,
      whiteSpots,
      redSpots,
      absentWhite: Array.from(absentSetWhite),
      absentRed: Array.from(absentSetRed),
      summary: summarySafe,
      elapsedSeconds,
      currentInterval,
      perPlayerMinutesWhite: schedule.perPlayerMinutesWhite,
      perPlayerMinutesRed: schedule.perPlayerMinutesRed,
    };
    setGameHistory((current) => [...current, newRecord].sort((a, b) => (a.gameDate || '').localeCompare(b.gameDate || '')));
    setGameDate(nextDate || nextWeekIso(gameDate));
    setAbsentWhite([]);
    setAbsentRed([]);
    setCurrentInterval(0);
    setElapsedSeconds(0);
    setTimerRunning(false);
    setOverrides({ white: {}, red: {} });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const loadHistoricalGame = (recordId) => {
    const selected = sortedHistory.find((item) => item.id === recordId);
    if (!selected) return;
    setGameDate(selected.gameDate || todayIso());
    setHalfMinutes(selected.halfMinutes || 25);
    setIntervalMinutes(selected.intervalMinutes || 5);
    setTotalOnField(selected.totalOnField || 9);
    setCurrentInterval(0);
    setElapsedSeconds(0);
    setTimerRunning(false);
    setAbsentWhite(selected.absentWhite || []);
    setAbsentRed(selected.absentRed || []);
    setOverrides({ white: {}, red: {} });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const toggleAbsentWhite = (player) => setAbsentWhite((current) => current.includes(player) ? current.filter((p) => p !== player) : [...current, player]);
  const toggleAbsentRed = (player) => setAbsentRed((current) => current.includes(player) ? current.filter((p) => p !== player) : [...current, player]);

  return (
    <div className="app-shell">
      <div className="container">
        <section className="hero no-print compact-hero">
          <h1>Rugby Subs</h1>
          <p>Built for quick sideline use.</p>
        </section>

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
              onStartPause={() => setTimerRunning((value) => !value)}
              onResetTimer={() => { setTimerRunning(false); setElapsedSeconds(0); }}
              onNext={() => setCurrentInterval((value) => Math.min(value + 1, maxIntervalIndex))}
              onBack={() => setCurrentInterval((value) => Math.max(value - 1, 0))}
              onSync={() => setCurrentInterval(timerBlockIndex)}
              timerBlockIndex={timerBlockIndex}
              mismatch={mismatch}
            />

            <NewGameTools
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
            />

            <section className="card">
              <h2>Match setup</h2>
              <div className="grid three mt">
                <label>
                  <span>Minutes per half</span>
                  <input type="number" min="1" value={halfMinutes} onChange={(e) => setHalfMinutes(Number(e.target.value) || 0)} />
                </label>
                <label>
                  <span>Sub interval</span>
                  <input type="number" min="1" value={intervalMinutes} onChange={(e) => setIntervalMinutes(Number(e.target.value) || 0)} />
                </label>
                <label className="span-two">
                  <span>Total players on field at one time</span>
                  <input type="number" min="1" max={Math.max(1, availableTotal || 1)} value={totalOnField} onChange={(e) => setTotalOnField(Number(e.target.value) || 0)} />
                </label>
              </div>
              <div className="row wrap gap mt">
                <Badge tone="slate">Listed: {cleanWhite.length + cleanRed.length}</Badge>
                <Badge tone="slate">Intervals: {intervals}</Badge>
                <Badge tone="slate">Game: {totalMatchMinutes} mins</Badge>
                <Badge tone="blue">Current block: {schedule.rows.length ? currentInterval + 1 : 0}/{schedule.rows.length}</Badge>
                <Badge tone="blue">Timer block: {schedule.rows.length ? timerBlockIndex + 1 : 0}/{schedule.rows.length}</Badge>
              </div>
              {!canGenerate ? (
                <div className="alert mt">
                  <strong>Please fix the setup</strong>
                  <ul>
                    {halfMinutes % intervalMinutes !== 0 ? <li>Minutes per half must divide evenly by the sub interval.</li> : null}
                    {totalOnField > availableTotal ? <li>Total players on field cannot exceed available players.</li> : null}
                    {duplicateNames.length > 0 ? <li>Each player name must appear only once across both squads.</li> : null}
                    {!suggestedSplit ? <li>No valid split could be found with the current available-player setting.</li> : null}
                  </ul>
                </div>
              ) : null}
              <button type="button" className="btn btn-primary full mt" onClick={() => download('rugby-interchange-schedule.csv', toCsv(schedule, { gameDate, totalOnField, whiteSpots, redSpots, absentWhite: Array.from(absentSetWhite), absentRed: Array.from(absentSetRed), elapsedSeconds, currentInterval, currentBlockLabel }), 'text/csv;charset=utf-8;')} disabled={!canGenerate}>
                Download CSV schedule
              </button>
            </section>

            <HistoryPanel history={sortedHistory} onLoadGame={loadHistoricalGame} />
            <AvailabilityPanel title="White squad availability" players={cleanWhite} absentSet={absentSetWhite} toggleAbsent={toggleAbsentWhite} markAllPresent={() => setAbsentWhite([])} />
            <AvailabilityPanel title="Red squad availability" players={cleanRed} absentSet={absentSetRed} toggleAbsent={toggleAbsentRed} markAllPresent={() => setAbsentRed([])} />
            <NameEditor title="White squad names" names={cleanWhite} setNames={setWhiteSquadPlayers} />
            <NameEditor title="Red squad names" names={cleanRed} setNames={setRedSquadPlayers} />
          </div>

          <div className="main">
            <MinutesSummary summary={summarySafe} totalMatchMinutes={totalMatchMinutes} intervalMinutes={intervalMinutes} />
            <RotationPlan rows={schedule.rows} currentInterval={currentInterval} />
          </div>
        </div>
      </div>
    </div>
  );
}
