// diplomacy_standard (power mode): the step list and one step as TEXT, read
// defensively from the target's observation as delivered and its accepted
// action. No province map (out of scope). Every press body, note, ask and term
// is target- or rival-authored and reaches the DOM only through <T>/<JsonBlock>;
// other powers' press is shown only as it sits in the target's own inbox.
import type { ReplaySeat, ReplayTick } from '../lib/replay-format.ts';
import { dipStepOf, type DipStep } from '../lib/chain.ts';
import { cleanJson } from '../lib/sanitize.ts';
import { isObj, list } from './Board.tsx';
import { JsonBlock, T } from './Text.tsx';

type O = Record<string, unknown>;
const POWERS = ['austria', 'england', 'france', 'germany', 'italy', 'russia', 'turkey'];
const s = (x: unknown): string => (typeof x === 'string' ? x : typeof x === 'number' ? String(x) : '');
const oneLine = (x: unknown, cap = 400) => <T v={JSON.stringify(cleanJson(x))} cap={cap} className="mono" />;

export function stepLabel(st: DipStep | null): string {
  if (!st) return 'unknown step';
  const what = { intent: 'intent', press: `press round ${st.round}`, orders: 'orders', retreat: 'retreats', adjust: 'builds / removals' }[st.kind];
  return `${st.phase} ${what}${st.adjudicates ? ' → adjudication' : ''}`;
}

export function DipStepList({ ticks, idx, onPick }: { ticks: ReplayTick[]; idx: number; onPick: (i: number) => void }) {
  return (
    <ol className="plain steps small-text" aria-label="steps">
      {ticks.map((t, i) => (
        <li key={i}>
          <button type="button" className="small" aria-pressed={i === idx} onClick={() => onPick(i)}>
            {t.tick}
          </button>{' '}
          <T v={stepLabel(dipStepOf(t))} cap={60} />
          {t.seats.length === 0 && <span className="muted"> (no decision)</span>}
          {t.oracle_events.length > 0 && <span className="tag">oracle event</span>}
        </li>
      ))}
    </ol>
  );
}

function to(x: unknown): string {
  if (!isObj(x)) return '?';
  if (x.kind === 'private') return `to ${s(x.power)}`;
  if (x.kind === 'group') return `to group ${list(x.powers).map(s).join(', ')}`;
  return x.kind === 'broadcast' ? 'to all' : '?';
}

/** One press move: routing and move as text, body as plain text, asks/terms as one-line JSON text. */
function Press({ m, from }: { m: O; from: boolean }) {
  const head = [from ? `from ${s(m.from)}` : '', to(m.to), s(m.move), s(m.msg_id), m.respond_to !== undefined ? `re ${s(m.respond_to)}` : ''].filter(Boolean).join(' · ');
  return (
    <li>
      <T v={head} cap={160} className="mono small-text" />
      {m.body !== undefined && (
        <div className="press-body">
          <T v={m.body} cap={600} />
        </div>
      )}
      {m.asks !== undefined && <div className="small-text">asks: {oneLine(m.asks)}</div>}
      {m.terms !== undefined && <div className="small-text">terms: {oneLine(m.terms)}</div>}
    </li>
  );
}

function PressList({ items, from, empty }: { items: unknown[]; from: boolean; empty: string }) {
  const ms = items.filter(isObj).slice(0, 72);
  if (ms.length === 0) return <p className="muted">{empty}</p>;
  return (
    <ul className="plain press">
      {ms.map((m, i) => (
        <Press key={i} m={m} from={from} />
      ))}
    </ul>
  );
}

function BoardText({ obs }: { obs: O }) {
  const board = isObj(obs.board) ? obs.board : {};
  const units = list(board.units).filter(isObj);
  const sc = isObj(board.supply_centers) ? board.supply_centers : {};
  const counts = isObj(board.sc_counts) ? board.sc_counts : {};
  const neutral = Object.keys(sc).filter((k) => sc[k] === null);
  const step = isObj(obs.step) ? obs.step : {};
  const horizon = isObj(obs.horizon) ? obs.horizon : {};
  const adj = isObj(obs.adjustment) ? obs.adjustment : null;
  return (
    <>
      <p className="mono small-text">
        <T v={`phase ${s(obs.phase)} · step ${s(step.kind)}${step.round !== undefined ? ` ${s(step.round)}/${s(step.rounds_total)}` : ''} · final year ${s(horizon.final_year)} (${s(horizon.years_remaining)} left)`} cap={120} />
      </p>
      <div className="scroll-x">
        <table className="small-text">
          <thead>
            <tr>
              <th scope="col">Power</th>
              <th scope="col">Centres</th>
              <th scope="col">Units</th>
            </tr>
          </thead>
          <tbody>
            {POWERS.map((p) => (
              <tr key={p} className={p === obs.power ? 'sel' : undefined}>
                <td>
                  {p}
                  {p === obs.power ? ' (target)' : ''}
                </td>
                <td>
                  <T v={`${s(counts[p]) || '0'}: ${Object.keys(sc).filter((k) => sc[k] === p).join(' ')}`} cap={200} className="mono" />
                </td>
                <td>
                  <T v={units.filter((u) => u.power === p).map((u) => `${s(u.type)} ${s(u.at)}`).join(', ') || '-'} cap={300} className="mono" />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="small-text muted">
        <T v={`neutral centres: ${neutral.join(' ') || 'none'}`} cap={200} />
      </p>
      {list(obs.dislodged).filter(isObj).length > 0 && (
        <p className="small-text">
          dislodged: <T v={list(obs.dislodged).filter(isObj).map((d) => `${s(d.power)} ${s(d.type)} ${s(d.at)} (retreats: ${list(d.retreat_options).map(s).join(' ') || 'none'})`).join('; ')} cap={600} className="mono" />
        </p>
      )}
      {adj && (
        <p className="small-text">
          adjustment: <T v={`delta ${s(adj.delta)}, buildable ${list(adj.buildable).map(s).join(' ') || 'none'}`} cap={200} className="mono" />
        </p>
      )}
    </>
  );
}

function Action({ seat }: { seat: ReplaySeat }) {
  const a = isObj(seat.action) ? seat.action : null;
  if (!a) return <p className="muted">No action applied (miss or no decision).</p>;
  const orders = list(a.orders);
  const intent = isObj(a.intent) ? a.intent : null;
  const press = list(a.press).filter(isObj);
  const moves = new Map<string, number>();
  for (const m of press) moves.set(s(m.move), (moves.get(s(m.move)) ?? 0) + 1);
  return (
    <>
      {a.orders !== undefined && (
        <>
          <p className="small-text">orders ({orders.length}):</p>
          <ul className="plain mono small-text">
            {orders.slice(0, 64).map((o, i) => (
              <li key={i}>{typeof o === 'string' ? <T v={o} cap={80} /> : oneLine(o, 200)}</li>
            ))}
          </ul>
        </>
      )}
      {intent && (
        <>
          <p className="small-text">
            private intent for <T v={intent.phase} cap={8} />: <T v={list(intent.orders).map((o) => (typeof o === 'string' ? o : JSON.stringify(cleanJson(o)))).join(', ')} cap={600} className="mono" />
          </p>
          {intent.notes !== undefined && (
            <p className="press-body small-text">
              notes (target text): <T v={intent.notes} cap={1024} />
            </p>
          )}
        </>
      )}
      {a.press !== undefined && (
        <>
          <p className="small-text">
            press sent: {press.length} message{press.length === 1 ? '' : 's'}
            {press.length > 0 && ' '}
            {press.length > 0 && <T v={`(${[...moves].map(([k, n]) => `${n} ${k}`).join(', ')})`} cap={120} />}
          </p>
          <PressList items={press} from={false} empty="(empty batch)" />
        </>
      )}
    </>
  );
}

export function DipStepDetail({ tick }: { tick: ReplayTick }) {
  const seat = tick.seats[0];
  const obs = seat && isObj(seat.observation) ? seat.observation : null;
  const last = obs && isObj(obs.last_phase) ? obs.last_phase : null;
  const rejects = obs ? list(obs.press_rejects).filter(isObj) : [];
  const feedback = obs ? list(obs.order_feedback).filter(isObj) : [];
  return (
    <div className="seat">
      <p className="muted small-text">No province map: the standard-map board is shown as text, from the observation the target received (a map view is out of scope for the inspector).</p>
      {!seat || !obs ? (
        <p className="muted">No decision by the target at this step (it may be eliminated or in civil disorder).</p>
      ) : (
        <div className="tickgrid">
          <div className="panel">
            <h3>
              Board seen by <T v={obs.power} cap={16} />
            </h3>
            <BoardText obs={obs} />
            {last && (
              <details>
                <summary>
                  Last adjudicated phase <T v={last.phase} cap={8} /> (public orders)
                </summary>
                <ul className="plain mono small-text">
                  {list(last.orders)
                    .filter(isObj)
                    .slice(0, 448)
                    .map((o, i) => (
                      <li key={i}>
                        <T v={`${s(o.power)}: ${s(o.order)} (${[s(o.status), s(o.result), s(o.reason)].filter(Boolean).join(', ')})`} cap={120} />
                      </li>
                    ))}
                </ul>
              </details>
            )}
          </div>
          <div className="panel">
            <h3>
              Target action: <T v={seat.ack.status} cap={16} />
              {seat.ack.reason !== undefined && <T v={` (${seat.ack.reason})`} cap={64} />}
            </h3>
            <Action seat={seat} />
            <h3>Rejects and feedback on the previous step</h3>
            {rejects.length === 0 && feedback.length === 0 ? (
              <p className="muted">None.</p>
            ) : (
              <ul className="plain mono small-text">
                {rejects.map((r, i) => (
                  <li key={`p${i}`}>
                    <T v={`press #${s(r.msg_index)} ${s(r.move)}: ${s(r.code)}${r.hint !== undefined ? ` (${s(r.hint)})` : ''}`} cap={200} />
                  </li>
                ))}
                {feedback.map((r, i) => (
                  <li key={`o${i}`}>
                    <T v={`${s(r.source)} #${s(r.index)}: ${s(r.code)}${r.raw !== undefined ? ` "${s(r.raw)}"` : ''}`} cap={200} />
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
      {obs && (
        <>
          <h3>Press inbox as the target received it (untrusted rival text)</h3>
          <PressList items={list(obs.inbox)} from empty="No press delivered at this step." />
          {list(obs.sent).length > 0 && (
            <>
              <h3>Own press delivered at the last round close</h3>
              <PressList items={list(obs.sent)} from={false} empty="" />
            </>
          )}
        </>
      )}
      {seat && (
        <details>
          <summary>Raw observation and action (sanitised JSON text)</summary>
          <JsonBlock v={seat.action} label="action applied" />
          <JsonBlock v={seat.observation} label="observation as delivered" />
        </details>
      )}
    </div>
  );
}
