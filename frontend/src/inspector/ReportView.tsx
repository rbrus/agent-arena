// Run metadata, the episode table and per-episode oracle verdicts.
import { useState } from 'react';
import type { Episode, OracleResult, Report } from '../lib/load.ts';
import { CAP } from '../lib/sanitize.ts';
import { Badge, short, T } from './Text.tsx';

function Row({ k, v, cap }: { k: string; v: unknown; cap?: number }) {
  return (
    <>
      <dt>{k}</dt>
      <dd>
        <T v={v} cap={cap} />
      </dd>
    </>
  );
}

export function RunMeta({ report }: { report: Report }) {
  const { run, engine, scenario, summary, disclosure } = report;
  const seat = run.spec.seat;
  return (
    <section aria-labelledby="run-h">
      <h2 id="run-h">Run</h2>
      <RunVerdict report={report} />
      <p className="coi">
        <strong>Conflict of interest: </strong>
        <T v={disclosure.conflict_of_interest} cap={1000} />
      </p>
      <dl className="meta">
        <Row k="Scenario" v={`${scenario.scenario_id} ${scenario.version}`} />
        <Row k="Tier" v={run.spec.budget_tier} />
        <Row k="Seat" v={seat ? [seat.mode, seat.position, seat.fill].filter(Boolean).join(' / ') : '(not recorded)'} />
        <Row k="Target" v={`${run.spec.target.transport} ${run.spec.target.url}`} cap={200} />
        {run.spec.target.label !== undefined && <Row k="Target label" v={run.spec.target.label} cap={CAP.name} />}
        <Row k="Engine" v={`${engine.version} build ${short(engine.build_hash, 16)}${engine.commit ? ` commit ${engine.commit}` : ''}`} />
        <Row k="Tool" v={`${run.tool.name} ${run.tool.version}`} />
        <Row k="Run" v={`${run.run_id} (${run.mode}) ${run.started_at}`} />
        <Row k="Summary" v={`${summary.verdict}: ${summary.episodes_total} episode${summary.episodes_total === 1 ? '' : 's'}, ${summary.effective_episodes} effective`} />
      </dl>
      {disclosure.determinism !== undefined && (
        <p className="muted">
          <T v={disclosure.determinism} cap={1000} />
        </p>
      )}
    </section>
  );
}

function Copy({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="small"
      aria-label={label}
      onClick={() => {
        navigator.clipboard?.writeText(text).then(() => setDone(true), () => setDone(false));
      }}
    >
      {done ? 'copied' : 'copy'}
    </button>
  );
}

export function EpisodeTable({ report, selected, onSelect, replayHash }: { report: Report; selected: number; onSelect: (i: number) => void; replayHash: string | null }) {
  return (
    <section aria-labelledby="ep-h">
      <h2 id="ep-h">Episodes</h2>
      <div className="scroll-x">
        <table>
          <thead>
            <tr>
              <th scope="col">#</th>
              <th scope="col">Seed</th>
              <th scope="col">Outcome</th>
              <th scope="col">Tick</th>
              <th scope="col">Replay hash</th>
              <th scope="col">Trajectory class</th>
              <th scope="col">Budget</th>
            </tr>
          </thead>
          <tbody>
            {report.episodes.map((e, i) => (
              <tr key={i} className={i === selected ? 'sel' : undefined}>
                <td>
                  <button type="button" className="small" aria-pressed={i === selected} onClick={() => onSelect(i)}>
                    {e.episode_index}
                  </button>
                </td>
                <td>{e.seed}</td>
                <td>
                  <T v={e.outcome_reason ? `${e.outcome} (${e.outcome_reason})` : e.outcome} cap={48} />
                </td>
                <td>{e.terminal_tick}</td>
                <td className="mono">
                  <span title={e.replay_hash}>{short(e.replay_hash)}</span> <Copy text={e.replay_hash} label={`copy replay hash of episode ${e.episode_index}`} />
                  {replayHash === e.replay_hash && <span className="tag">replay loaded</span>}
                </td>
                <td className="mono">{e.trajectory_class ? short(e.trajectory_class, 8) : '-'}</td>
                <td>{e.budget.within_budget === true ? 'within' : e.budget.within_budget === false ? 'over' : '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** sarif-mapping.md "Review-required results": the fixed sentence a fail of a review_required rule ends with. */
export const REVIEW_SENTENCE = 'Review required: statistical signal, not proof; inspect the replay before acting.';

function Hash({ k, v }: { k: string; v: string | undefined }) {
  if (v === undefined) return null;
  return (
    <>
      <dt>{k}</dt>
      <dd className="mono">
        <span title={v}>{short(v, 16)}</span> <Copy text={v} label={`copy ${k}`} />
      </dd>
    </>
  );
}

const counts = (m: Record<string, unknown> | undefined) =>
  m ? Object.entries(m).filter(([, v]) => typeof v === 'number').map(([k, v]) => `${k} ${v}`).join(', ') : '';

/** diplomacy_standard: the three hashes, table context and press accounting (reported, never scored). */
export function DiplomacyMeta({ episode, report }: { episode: Episode; report: Report }) {
  const d = episode.diplomacy;
  if (!d) return null;
  const press = episode.budget.press;
  return (
    <section aria-labelledby="dip-h">
      <h3 id="dip-h">Diplomacy episode {episode.episode_index}</h3>
      <dl className="meta">
        <Row k="Target power" v={`${d.power} (profile ${d.profile}, horizon ${d.horizon_year}, ${d.press_rounds} press rounds, signatures ${d.sig_mode})`} />
        {d.terminal && <Row k="Terminal" v={`${d.terminal.kind}${d.terminal.year !== undefined ? ` ${d.terminal.year}` : ''}${d.terminal.winner ? `, winner ${d.terminal.winner}` : ''}`} />}
        <Row k="Centres" v={counts(d.sc_counts)} cap={200} />
        <Row k="Units" v={counts(d.unit_counts)} cap={200} />
        {(d.eliminated.length > 0 || d.civil_disorder.length > 0) && <Row k="Out" v={`eliminated: ${d.eliminated.join(', ') || '-'}; civil disorder: ${d.civil_disorder.join(', ') || '-'}`} />}
        <Row k="Table" v={d.roster.map((r) => `${r.power} ${r.seat_kind === 'target' ? 'TARGET' : [r.agent, r.persona].filter(Boolean).join('/') || r.seat_kind}`).join(' · ')} cap={600} />
        <Row k="Engagement" v={counts(d.engagement)} cap={600} />
        {typeof press === 'object' && <Row k="Press budget" v={counts(press)} cap={600} />}
        <Hash k="replay hash (board chain)" v={episode.replay_hash} />
        <Hash k="transcript hash" v={episode.transcript_hash} />
        <Hash k="evaluation hash" v={episode.evaluation_hash} />
        <Hash k="engine evaluation hash" v={d.engine_evaluation_hash} />
      </dl>
      <p className="muted small-text">Win, loss and centre counts are context for a reader, never scored. Press text lives only in the replay and is shown there as plain text.</p>
      {report.not_assessed && report.not_assessed.length > 0 && (
        <>
          <h3>Not assessed in this run</h3>
          <ul className="plain small-text">
            {report.not_assessed.map((n, i) => (
              <li key={i}>
                <T v={`${n.kind} ${n.id}: ${n.reason_code}${n.seat ? ` (seat ${n.seat})` : ''}`} cap={200} className="mono" />
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

/** The first thing a reader sees: the run verdict in words and the failing oracles that decide it (text + badge shape, never colour alone). */
function RunVerdict({ report }: { report: Report }) {
  const v = report.summary.verdict;
  const all = [...report.run_oracles, ...report.episodes.flatMap((e) => e.oracles)];
  const fails = all.filter((o) => o.verdict === 'fail').sort((a, b) => RANK(a) - RANK(b));
  const na = all.filter((o) => o.verdict === 'not_assessed').length;
  const titles = new Map(report.scenario.oracles.map((o) => [o.oracle_id, o.title]));
  const kind = v === 'pass' ? 'pass' : v === 'fail' ? 'fail' : 'other';
  return (
    <div className={`run-verdict rv-${kind}`} role="status" aria-label="run verdict">
      <p className="rv-line">
        <Badge verdict={kind === 'pass' ? 'pass' : kind === 'fail' ? 'fail' : 'not_assessed'} severity={fails[0]?.severity ?? 'error'} />{' '}
        <strong>
          {kind === 'pass' ? 'This run passes: no oracle failed.' : kind === 'fail' ? `This run fails: ${fails.length} oracle verdict${fails.length === 1 ? '' : 's'} failed.` : <>Run verdict: <T v={v} cap={32} />{fails.length === 0 ? ' (no oracle failed, but not every oracle could be assessed)' : ''}.</>}
        </strong>
        {na > 0 && <span className="muted"> {na} not assessed (not a pass).</span>}
      </p>
      {fails.length > 0 && (
        <ul className="plain rv-fails">
          {fails.slice(0, 4).map((o, i) => (
            <li key={i}>
              <Badge verdict="fail" severity={o.severity} /> <T v={o.oracle_id} cap={CAP.name * 2} className="mono" />
              {titles.get(o.oracle_id) !== undefined && (
                <>
                  {' ('}
                  <T v={titles.get(o.oracle_id)} cap={120} />
                  {')'}
                </>
              )}
              {o.evidence_ref?.message !== undefined && (
                <>
                  {': '}
                  <T v={o.evidence_ref.message} cap={200} />
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const RANK = (o: OracleResult) => (o.verdict === 'fail' ? { error: 0, warning: 1, note: 2 }[o.severity] : o.verdict === 'not_assessed' ? 3 : 4);

function kv(m: Record<string, number> | undefined): string {
  return m ? Object.entries(m).map(([k, v]) => `${k}=${v}`).join('  ') : '';
}

export function Verdicts({ title, oracles, report, canJump, onJump }: { title: string; oracles: OracleResult[]; report: Report; canJump: boolean; onJump: (tick: number) => void }) {
  const meta = new Map(report.scenario.oracles.map((o) => [o.oracle_id, o]));
  const sorted = [...oracles].sort((a, b) => RANK(a) - RANK(b));
  return (
    <section aria-label={title}>
      <h3>{title}</h3>
      {sorted.length === 0 && <p className="muted">No verdicts.</p>}
      <ul className="verdicts">
        {sorted.map((o, i) => {
          const m = meta.get(o.oracle_id) as (Report['scenario']['oracles'][number] & { review_required?: unknown }) | undefined;
          const review = o.review_required === true || m?.review_required === true;
          return (
            <li key={i} className={`v-${o.verdict} s-${o.severity}`}>
              <div className="vhead">
                <Badge verdict={o.verdict} severity={o.severity} />
                <T v={o.oracle_id} cap={CAP.name * 2} className="mono" />
                {m?.primary && <span className="tag">primary</span>}
                <span className="tag">{o.basis === 'attested' ? 'attested' : 'resim'}</span>
                {review && <span className="tag review">review required</span>}
                {o.seat !== undefined && <T v={`seat ${o.seat}`} cap={16} className="muted" />}
              </div>
              {m && <T v={m.title} cap={120} className="vtitle" />}
              {o.verdict === 'not_assessed' &&
                (o.reason_code === 'episode_invalid' ? (
                  <p className="muted">Not assessed (episode invalid): a reference seat failed an oracle, so this episode tests nothing about the target. This is not a pass.</p>
                ) : (
                  <p className="muted">
                    Not assessed (<T v={o.reason_code ?? 'no reason given'} cap={64} />). This is not a pass.
                  </p>
                ))}
              {review && <p className={o.verdict === 'fail' ? 'review-note' : 'muted small-text'}>{o.verdict === 'fail' ? REVIEW_SENTENCE : `A fail of this oracle would read: ${REVIEW_SENTENCE}`}</p>}
              {(o.measures || o.thresholds) && (
                <p className="mono small-text">
                  <T v={kv(o.measures)} cap={600} />
                  {o.thresholds && (
                    <>
                      {' | thresholds: '}
                      <T v={kv(o.thresholds)} cap={600} />
                    </>
                  )}
                </p>
              )}
              {o.evidence_ref && (
                <div className="evidence">
                  {o.evidence_ref.message !== undefined && <T v={o.evidence_ref.message} cap={280} />}
                  {o.evidence_ref.code !== undefined && <T v={` [${o.evidence_ref.code}]`} cap={64} className="mono muted" />}
                  {o.evidence_ref.items && o.evidence_ref.items.length > 0 && (
                    <ul className="plain mono small-text">
                      {o.evidence_ref.items.map((it, j) => (
                        <li key={j}>
                          <T v={`${it.kind} ${it.id} @ ${it.tick}${it.phase ? ` ${it.phase}` : ''}${it.step ? ` ${it.step}` : ''}`} cap={140} />
                        </li>
                      ))}
                    </ul>
                  )}
                  <div className="ticks">
                    Evidence ticks:{' '}
                    {o.evidence_ref.ticks.map((t) => (
                      <button key={t} type="button" className="small" disabled={!canJump} title={canJump ? `go to tick ${t}` : 'load this episode replay to open the tick'} onClick={() => onJump(t)}>
                        {t}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export type { Episode };
