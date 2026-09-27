// The one route: load a report (+ optional replay), inspect it. Files are read
// locally via the File API; the only fetches are this site's own bundled samples.
import { useCallback, useEffect, useState } from 'react';
import { checkChain, type ChainStatus } from '../lib/chain.ts';
import { loadFile, loadText, LoadError, safeParse, type Loaded, type Report } from '../lib/load.ts';
import type { ReplayFile } from '../lib/replay-format.ts';
import { ReplayView } from './ReplayView.tsx';
import { DiplomacyMeta, EpisodeTable, RunMeta, Verdicts } from './ReportView.tsx';
import { T } from './Text.tsx';

interface Sample {
  id: string;
  label: string;
  report: string;
  replay?: string;
}
// Sample paths as gen-samples writes them: `<id>/report.json`, `<id>/report.episode-N.replay.json`.
export const FILE = /^[a-z0-9_-]{1,80}\/report(\.episode-\d{1,4}\.replay)?\.json$/;

async function fetchSamples(): Promise<Sample[]> {
  const res = await fetch('samples/index.json');
  const v = safeParse(await res.text());
  if (!Array.isArray(v)) return [];
  return v
    .filter((s): s is Sample => !!s && typeof s.id === 'string' && typeof s.label === 'string' && FILE.test(s.report) && (s.replay === undefined || FILE.test(s.replay)))
    .slice(0, 64);
}

function parseHash(): { sample?: string; ep?: number; t?: number } {
  const p = new URLSearchParams(location.hash.slice(1));
  const n = (k: string) => (p.get(k) !== null && /^\d{1,4}$/.test(p.get(k)!) ? Number(p.get(k)) : undefined);
  return { sample: p.get('sample') ?? undefined, ep: n('ep'), t: n('t') };
}

export interface InspectorProps {
  initialReport?: Report | null;
  initialReplay?: ReplayFile | null;
}

export function App({ initialReport = null, initialReplay = null }: InspectorProps) {
  const [report, setReport] = useState<Report | null>(initialReport);
  const [replay, setReplay] = useState<ReplayFile | null>(initialReplay);
  const [sel, setSel] = useState(0);
  const [errors, setErrors] = useState<string[]>([]);
  const [samples, setSamples] = useState<Sample[]>([]);
  const [sampleId, setSampleId] = useState<string | null>(null);
  const [pick, setPick] = useState<string | null>(null);
  const [chain, setChain] = useState<ChainStatus>('checking');
  const [request, setRequest] = useState<{ tick: number; n: number } | null>(null);
  const [curTick, setCurTick] = useState<number | null>(null);
  const [drag, setDrag] = useState(false);

  const ingest = useCallback((items: Loaded[], errs: string[], from: string | null) => {
    const rep = items.find((x) => x.kind === 'report');
    const rpl = items.find((x) => x.kind === 'replay');
    if (rep && rep.kind === 'report') {
      setReport(rep.report);
      setSel(0);
      if (!rpl) setReplay(null);
    }
    if (rpl && rpl.kind === 'replay') setReplay(rpl.replay);
    if (rep || rpl) setSampleId(from);
    setErrors(errs);
  }, []);

  const onFiles = useCallback(
    async (files: FileList | File[]) => {
      const items: Loaded[] = [];
      const errs: string[] = [];
      for (const f of Array.from(files).slice(0, 4)) {
        try {
          items.push(await loadFile(f));
        } catch (e) {
          errs.push(`${f.name}: ${e instanceof LoadError ? e.message : 'could not read file'}`);
        }
      }
      ingest(items, errs, null);
    },
    [ingest],
  );

  const loadSample = useCallback(
    async (s: Sample, ep?: number, t?: number) => {
      try {
        const items = [loadText(await (await fetch(`samples/${s.report}`)).text())];
        if (s.replay) items.push(loadText(await (await fetch(`samples/${s.replay}`)).text()));
        ingest(items, [], s.id);
        if (ep !== undefined) setSel(ep);
        if (t !== undefined) setRequest({ tick: t, n: Date.now() });
      } catch (e) {
        setErrors([`sample ${s.id}: ${e instanceof LoadError ? e.message : 'could not load'}`]);
      }
    },
    [ingest],
  );

  useEffect(() => {
    fetchSamples()
      .then((list) => {
        setSamples(list);
        const h = parseHash();
        const s = list.find((x) => x.id === h.sample);
        if (s && !initialReport) {
          setPick(s.id);
          void loadSample(s, h.ep, h.t);
        }
      })
      .catch(() => setSamples([]));
  }, [loadSample, initialReport]);

  const episode = report?.episodes[Math.min(sel, (report?.episodes.length ?? 1) - 1)];
  const replayMatches = !!(replay && episode && replay.replay_hash === episode.replay_hash);
  const replayEpisode = report && replay ? report.episodes.findIndex((e) => e.replay_hash === replay.replay_hash) : -1;

  useEffect(() => {
    if (report && replay && replayEpisode >= 0) setSel(replayEpisode);
  }, [report, replay, replayEpisode]);
  useEffect(() => {
    if (!replay) return;
    setChain('checking');
    let live = true;
    void checkChain(replay, report && replayEpisode >= 0 ? report.episodes[replayEpisode].replay_hash : replay.replay_hash).then((c) => live && setChain(c));
    return () => {
      live = false;
    };
  }, [replay, report, replayEpisode]);
  useEffect(() => {
    if (!sampleId) return;
    const t = replayMatches && curTick !== null ? `&t=${curTick}` : '';
    history.replaceState(null, '', `#sample=${encodeURIComponent(sampleId)}&ep=${sel}${t}`);
  }, [sampleId, sel, curTick, replayMatches]);

  const jump = (tick: number) => {
    setRequest({ tick, n: Date.now() });
    document.getElementById('replay')?.scrollIntoView({ block: 'start' });
  };

  return (
    <main
      className={drag ? 'drag' : undefined}
      onDragOver={(e) => {
        e.preventDefault();
        setDrag(true);
      }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDrag(false);
        void onFiles(e.dataTransfer.files);
      }}
    >
      <header>
        <h1>Agent Arena — Replay Inspector</h1>
        <p className="muted">Drop or pick a report.json and, optionally, its replay JSON. Files are read locally; nothing is uploaded or fetched from elsewhere.</p>
        <p className="muted small-text">
          Verdicts are shown as the report records them. This page is <strong>not a re-simulation</strong>: it checks file consistency only; run <code>agent-arena verify</code> to re-simulate.
        </p>
        <div className="load">
          <label className="button">
            Open files
            <input type="file" accept=".json,application/json" multiple onChange={(e) => e.target.files && void onFiles(e.target.files)} />
          </label>
          {samples.length > 0 && (
            <>
              <select aria-label="sample" value={pick ?? samples[0].id} onChange={(e) => setPick(e.target.value)}>
                {samples.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                    {s.replay ? '' : ' (report only)'}
                  </option>
                ))}
              </select>
              <button type="button" onClick={() => void loadSample(samples.find((s) => s.id === pick) ?? samples[0])}>
                Load sample
              </button>
            </>
          )}
        </div>
        {errors.length > 0 && (
          <ul className="errors" role="alert">
            {errors.map((e, i) => (
              <li key={i}>
                <T v={e} cap={300} />
              </li>
            ))}
          </ul>
        )}
      </header>

      {report && episode && (
        <>
          <RunMeta report={report} />
          <EpisodeTable report={report} selected={sel} onSelect={setSel} replayHash={replay?.replay_hash ?? null} />
          <DiplomacyMeta episode={episode} report={report} />
          <Verdicts title={`Oracle verdicts, episode ${episode.episode_index} (seed ${episode.seed})`} oracles={episode.oracles} report={report} canJump={replayMatches} onJump={jump} />
          {report.run_oracles.length > 0 && <Verdicts title="Run-level verdicts" oracles={report.run_oracles} report={report} canJump={false} onJump={jump} />}
        </>
      )}
      {replay && report && replayEpisode < 0 && (
        <p className="errors" role="alert">
          The loaded replay (hash {replay.replay_hash.slice(7, 19)}) does not belong to any episode of this report; it is not shown.
        </p>
      )}
      {replay && report && replayEpisode >= 0 && !replayMatches && (
        <p className="muted">
          The loaded replay is for episode {report.episodes[replayEpisode].episode_index}.{' '}
          <button type="button" className="small" onClick={() => setSel(replayEpisode)}>
            Show it
          </button>
        </p>
      )}
      {replay && (!report || replayMatches) && <ReplayView replay={replay} chain={chain} request={request} onTick={setCurTick} />}
      {!report && !replay && <p className="empty">No report loaded.</p>}
    </main>
  );
}
