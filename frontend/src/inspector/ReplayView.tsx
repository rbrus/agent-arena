// Tick scrubber + per-seat observation / action / ack panels + events.
import { useEffect, useMemo, useState } from 'react';
import type { ChainStatus } from '../lib/chain.ts';
import type { ReplayFile, ReplayTick } from '../lib/replay-format.ts';
import { CAP, clean } from '../lib/sanitize.ts';
import { GridBoard, isObj, list, obstaclesOf, RaidBoard } from './Board.tsx';
import { DipStepDetail, DipStepList } from './DipView.tsx';
import { Badge, JsonBlock, T } from './Text.tsx';

const CHAIN_TEXT: Record<ChainStatus, string> = {
  checking: 'checking hash chain…',
  ok: 'hash chain consistent with the report (file check, not a re-simulation; run agent-arena verify for that)',
  mismatch: 'HASH CHAIN MISMATCH: this replay does not reproduce the committed replay hash',
  unavailable: 'hash chain not checked (WebCrypto unavailable in this context)',
};
// Power mode (diplomacy_standard): the file carries the adjudicator chain heads, not the fold inputs.
const DIP_CHAIN_TEXT: Record<ChainStatus, string> = {
  ...CHAIN_TEXT,
  ok: 'adjudicator chain consistent with the report: the head is unchanged on every intent and press step, advances at every adjudication, and ends at the committed replay hash. This is a file-consistency check, not a re-simulation: the orders digests and board states behind each fold are not in the replay file; run agent-arena verify to re-simulate.',
  mismatch: 'ADJUDICATOR CHAIN MISMATCH: this replay does not match the committed replay hash (or a press step moved the chain). File-consistency check, not a re-simulation.',
};

function eventText(e: ReplayTick['engine_events'][number]): string {
  const rest = Object.entries(e)
    .filter(([k]) => k !== 'type')
    .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
    .join(' ');
  return `${e.type} ${rest}`;
}

function Board({ tick, replay, viewId, obstacles }: { tick: ReplayTick; replay: ReplayFile; viewId: string; obstacles: [number, number][] }) {
  const obs = tick.seats[0]?.observation;
  if (!isObj(obs)) return <p className="muted">No observation delivered this tick.</p>;
  if (replay.scenario_id === 'grid_tactics') return <GridBoard obs={obs} obstacles={obstacles} />;
  const views = obs.view !== undefined ? [obs.view] : list(obs.views);
  const view = views.filter(isObj).find((v) => clean(v.member_id, 4) === viewId) ?? views.find(isObj);
  if (!view || !isObj(view)) return <p className="muted">No member view in this frame.</p>;
  const boss = isObj(view.boss) ? view.boss : {};
  return (
    <>
      <p className="mono small-text">
        <T v={`view ${clean(view.member_id, 4)} | boss hp ${boss.hp}/${boss.max_hp} | phase ${boss.phase} | enrage in ${boss.enrage_in_ticks}`} cap={120} />
      </p>
      <RaidBoard view={view} />
    </>
  );
}

export function ReplayView({ replay, chain, request, onTick }: { replay: ReplayFile; chain: ChainStatus; request: { tick: number; n: number } | null; onTick: (tick: number) => void }) {
  const [idx, setIdx] = useState(0);
  const [viewId, setViewId] = useState('m0');
  const last = replay.ticks.length - 1;
  const tick = replay.ticks[Math.min(idx, last)];

  useEffect(() => {
    if (!request) return;
    const i = replay.ticks.findIndex((t) => t.tick === request.tick);
    if (i >= 0) setIdx(i);
  }, [request, replay]);
  useEffect(() => {
    if (tick) onTick(tick.tick);
  }, [tick, onTick]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
      const step = { ArrowLeft: -1, ArrowRight: 1 }[e.key];
      if (step) setIdx((i) => Math.max(0, Math.min(last, i + step)));
      else if (e.key === 'Home') setIdx(0);
      else if (e.key === 'End') setIdx(last);
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [last]);

  // Obstacles are only in some duel frames; carry the last seen layout forward.
  const obstacles = useMemo(() => {
    const out: [number, number][][] = [];
    let cur: [number, number][] = [];
    for (const t of replay.ticks) {
      cur = obstaclesOf(t.seats[0]?.observation) ?? cur;
      out.push(cur);
    }
    return out;
  }, [replay]);
  const evidence = useMemo(() => replay.ticks.filter((t) => t.oracle_events.length > 0).map((t) => t.tick), [replay]);
  const memberIds = useMemo(() => {
    const o = replay.ticks[0]?.seats[0]?.observation;
    return isObj(o) ? (o.view !== undefined ? [o.view] : list(o.views)).filter(isObj).map((v) => clean(v.member_id, 4)) : [];
  }, [replay]);

  if (!tick) return <p className="muted">This replay has no ticks.</p>;
  const power = replay.mode === 'power';
  return (
    <section aria-labelledby="rp-h" id="replay">
      <h2 id="rp-h">Replay</h2>
      <p className={`chain c-${chain}`} role="status">
        {(power ? DIP_CHAIN_TEXT : CHAIN_TEXT)[chain]}
      </p>
      <div className="scrub">
        <button type="button" onClick={() => setIdx((i) => Math.max(0, i - 1))} disabled={idx === 0} aria-label="previous tick">
          &larr;
        </button>
        <input type="range" min={0} max={last} value={Math.min(idx, last)} onChange={(e) => setIdx(Number(e.target.value))} aria-label="tick" aria-valuetext={`tick ${tick.tick}`} />
        <button type="button" onClick={() => setIdx((i) => Math.min(last, i + 1))} disabled={idx >= last} aria-label="next tick">
          &rarr;
        </button>
        <span className="mono" aria-live="polite">
          {power ? 'step' : 'tick'} {tick.tick} / {replay.ticks[last].tick}
        </span>
      </div>
      {evidence.length > 0 && (
        <p className="ticks">
          Ticks with oracle events:{' '}
          {evidence.map((t) => (
            <button key={t} type="button" className="small" aria-pressed={t === tick.tick} onClick={() => setIdx(replay.ticks.findIndex((x) => x.tick === t))}>
              {t}
            </button>
          ))}
        </p>
      )}
      <div className="tickgrid fade" key={tick.tick}>
        {power ? (
          <div className="panel">
            <h3>Steps</h3>
            <DipStepList ticks={replay.ticks} idx={idx} onPick={setIdx} />
          </div>
        ) : (
        <div className="panel">
          {memberIds.length > 1 && (
            <label>
              Member view{' '}
              <select value={viewId} onChange={(e) => setViewId(e.target.value)}>
                {memberIds.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </label>
          )}
          <Board tick={tick} replay={replay} viewId={viewId} obstacles={obstacles[idx] ?? []} />
          <p className="legend small-text">
            circle = own / squad unit (number = member, small = hp) · square = enemy or lock · triangle = add or stale cell · diamond = objective / anchor · shaded = fog or obstacle
          </p>
        </div>
        )}
        <div className="panel">
          <h3>Oracle events at this tick</h3>
          {tick.oracle_events.length === 0 ? (
            <p className="muted">None.</p>
          ) : (
            <ul className="plain">
              {tick.oracle_events.map((e, i) => (
                <li key={i}>
                  <Badge verdict="fail" severity={e.severity} /> <T v={e.oracle_id} cap={CAP.name * 2} className="mono" /> {e.code !== undefined && <T v={`[${e.code}]`} cap={64} className="mono muted" />}
                </li>
              ))}
            </ul>
          )}
          <h3>Engine events</h3>
          <ul className="plain mono small-text">
            {tick.engine_events.map((e, i) => (
              <li key={i}>
                <T v={eventText(e)} cap={200} />
              </li>
            ))}
          </ul>
          <p className="mono small-text muted">
            {power ? 'chain head' : 'state'} {tick.state_hash.slice(7, 23)}
          </p>
        </div>
      </div>
      {power && <DipStepDetail tick={tick} />}
      {!power && tick.seats.map((s, i) => (
        <div className="seat" key={i}>
          <h3>
            Seat <T v={s.seat} cap={8} />: <T v={s.ack.status} cap={16} />
            {s.ack.reason !== undefined && <T v={` (${s.ack.reason})`} cap={64} />}
            {s.ack.late && ' (late)'}
          </h3>
          {s.ack.coercions && s.ack.coercions.length > 0 && <JsonBlock v={s.ack.coercions} label="engine coercions" />}
          <details open>
            <summary>Action submitted (target-authored, untrusted)</summary>
            <JsonBlock v={s.action} label="action submitted" />
          </details>
          <details open>
            <summary>Observation as delivered</summary>
            <JsonBlock v={s.observation} label="observation as delivered" />
          </details>
        </div>
      ))}
    </section>
  );
}
