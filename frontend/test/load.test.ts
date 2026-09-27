import { describe, expect, it } from 'vitest';
import { checkChain, dipChainProblem, dipStepOf } from '../src/lib/chain.ts';
import { loadText } from '../src/lib/load.ts';
import { clean, sanitize } from '../src/lib/sanitize.ts';
import { index, readSample } from './helpers.ts';

describe('sanitize', () => {
  it('strips ANSI (CSI, OSC 8, OSC 52), zero-width, bidi, tag characters; keeps visible text', () => {
    expect(clean('\u001b[1;31mA\u001b[0m\u001b]8;;http://e/\u0007B\u001b]8;;\u0007\u001b]52;c;Zm9v\u0007C')).toBe('ABC');
    expect(clean('a​b‮c\u{E0041}d️e­f')).toBe('abcdef');
    expect(clean('line\nbreak\ttab')).toBe('line break tab');
    expect(clean('\uD800x')).toBe('�x');
  });
  it('caps by code point and marks truncation', () => {
    const r = sanitize('\u{1F600}'.repeat(10), 5);
    expect(Array.from(r.text)).toHaveLength(5);
    expect(r.truncated).toBe(true);
  });
});

describe('hostile-file loader', () => {
  const report = readSample('byzantine-core-20260720-naive/report.json');
  it('rejects prototype keys, bad JSON, wrong kinds, over-deep nesting and over-cap counts', () => {
    expect(() => loadText('{"report_version":"1.0","__proto__":{"x":1}}')).toThrow(/forbidden key/);
    expect(() => loadText('{"a":{"constructor":1}}')).toThrow(/forbidden key/);
    expect(() => loadText('{nope')).toThrow(/not valid JSON/);
    expect(() => loadText('{"x":1}')).toThrow(/neither a report/);
    expect(() => loadText('['.repeat(40) + ']'.repeat(40))).toThrow(/nesting/);
    const r = JSON.parse(report);
    r.episodes[0].replay_hash = 'sha256:nothex';
    expect(() => loadText(JSON.stringify(r))).toThrow(/episodes\[0\]\.replay_hash/);
    r.episodes = Array.from({ length: 1001 }, () => ({}));
    expect(() => loadText(JSON.stringify(r))).toThrow(/more than 1000/);
    const p = JSON.parse(readSample('byzantine-core-20260720-naive/report.episode-0.replay.json'));
    p.ticks = Array.from({ length: 200 }, () => p.ticks[0]);
    expect(() => loadText(JSON.stringify(p))).toThrow(/replay\.ticks: more than/);
  });

  it('loads every sample; every shipped replay chain-checks against its report', async () => {
    const list = index();
    expect(list.map((s) => s.id)).toContain('byzantine-core-20260720-coordinated');
    const families = new Set(list.map((s) => s.id.split('-')[0]));
    expect(families.size).toBeGreaterThanOrEqual(7); // every open scenario, plus whatever ships next
    for (const f of ['grid_tactics', 'byzantine', 'deadlock', 'hallucinator', 'latency', 'overfit', 'split_brain', 'diplomacy_standard']) expect(families, f).toContain(f);
    for (const s of list) {
      const rep = loadText(readSample(s.report));
      expect(rep.kind).toBe('report');
      if (!s.replay || rep.kind !== 'report') continue;
      const rpl = loadText(readSample(s.replay));
      if (rpl.kind !== 'replay') throw new Error('not a replay');
      expect(await checkChain(rpl.replay, rep.report.episodes[0].replay_hash), s.id).toBe('ok');
    }
  });

  it('accepts a Diplomacy report (press budget object, diplomacy block, seats, not_assessed) and still rejects hostile shapes in it', () => {
    const text = readSample(DIP_REPORT);
    const ok = loadText(text);
    if (ok.kind !== 'report') throw new Error('not a report');
    expect(ok.report.episodes[0].diplomacy?.power).toBe('germany');
    expect(typeof ok.report.episodes[0].budget.press).toBe('object');
    expect(ok.report.not_assessed?.length).toBeGreaterThan(0);
    const mut = (f: (r: any) => void) => {
      const r = JSON.parse(text);
      f(r);
      return JSON.stringify(r);
    };
    expect(() => loadText(mut((r) => (r.episodes[0].budget.press.messages_accepted = 'many')))).toThrow(/budget\.press\.messages_accepted/);
    expect(() => loadText(mut((r) => (r.episodes[0].budget.other = { a: 1 })))).toThrow(/budget\.other: expected a scalar/);
    expect(() => loadText(mut((r) => (r.episodes[0].evaluation_hash = 'sha256:x')))).toThrow(/evaluation_hash/);
    expect(() => loadText(mut((r) => (r.episodes[0].diplomacy.engine_evaluation_hash = 1)))).toThrow(/engine_evaluation_hash/);
    expect(() => loadText(mut((r) => (r.episodes[0].diplomacy.roster = Array.from({ length: 8 }, () => r.episodes[0].diplomacy.roster[0]))))).toThrow(/roster: more than 7/);
    expect(() => loadText(mut((r) => (r.episodes[0].diplomacy.roster[0].agent = 'x'.repeat(5000))))).toThrow(/roster\[0\]\.agent/);
    expect(() => loadText(mut((r) => (r.episodes[0].seats[3].recorded_inputs.digest = 'nope')))).toThrow(/seats\[3\]\.recorded_inputs\.digest/);
    expect(() => loadText(mut((r) => (r.episodes[0].oracles[2].review_required = 'yes')))).toThrow(/review_required/);
    expect(() => loadText(mut((r) => (r.not_assessed = [{ kind: 'oracle', id: 1, reason_code: 'x' }])))).toThrow(/not_assessed\[0\]\.id/);
    expect(() => loadText(text.replace('"diplomacy": {', '"diplomacy": {"__proto__": {"polluted": 1},'))).toThrow(/forbidden key/);
    let deep = '1';
    for (let i = 0; i < 40; i++) deep = `{"a":${deep}}`;
    expect(() => loadText(text.replace('"diplomacy": {', `"diplomacy": {"deep": ${deep},`))).toThrow(/nesting/);
  });
});

const DIP_REPORT = 'diplomacy_standard-core-20261115-robust/report.json';
const DIP_REPLAY = 'diplomacy_standard-core-20261115-robust/report.episode-0.replay.json';

describe('power-mode (Diplomacy) adjudicator chain check', () => {
  const load = () => {
    const rep = loadText(readSample(DIP_REPORT));
    const rpl = loadText(readSample(DIP_REPLAY));
    if (rep.kind !== 'report' || rpl.kind !== 'replay') throw new Error('bad sample');
    return { expected: rep.report.episodes[0].replay_hash, replay: rpl.replay };
  };

  it("reproduces the report's replay_hash from the CLI-written replay file", async () => {
    const { expected, replay } = load();
    expect(replay.mode).toBe('power');
    expect(replay.replay_hash).toBe(expected);
    expect(dipChainProblem(replay, expected)).toBeNull();
    expect(await checkChain(replay, expected)).toBe('ok');
    // The chain advances exactly at the adjudications and nowhere else.
    const adj = replay.ticks.filter((t) => dipStepOf(t)?.adjudicates).length;
    expect(new Set([replay.initial_state_hash, ...replay.ticks.map((t) => t.state_hash)]).size).toBe(adj + 1);
    expect(await checkChain(replay, `sha256:${'0'.repeat(64)}`)).toBe('mismatch');
  });

  it('detects a tampered adjudication step (last, and intermediate followed by a press step)', async () => {
    const zero = `sha256:${'0'.repeat(64)}`;
    const adjIdx = load().replay.ticks.flatMap((t, i) => (dipStepOf(t)?.adjudicates ? [i] : []));
    {
      const { expected, replay } = load();
      replay.ticks[adjIdx[adjIdx.length - 1]].state_hash = zero;
      expect(await checkChain(replay, expected)).toBe('mismatch');
    }
    {
      const { expected, replay } = load();
      const i = adjIdx.find((k) => dipStepOf(replay.ticks[k + 1])?.kind === 'intent')!;
      replay.ticks[i].state_hash = zero;
      expect(dipChainProblem(replay, expected)).toMatch(/never folded/);
    }
    {
      // An adjudication that claims no fold (head copied from the previous step).
      const { expected, replay } = load();
      replay.ticks[adjIdx[0]].state_hash = replay.ticks[adjIdx[0] - 1].state_hash;
      expect(dipChainProblem(replay, expected)).toMatch(/did not advance/);
    }
    {
      // An adjudication step relabelled as a press round.
      const { expected, replay } = load();
      const ev = replay.ticks[adjIdx[0]].engine_events.find((e) => e.type === 'step')!;
      ev.step = String(ev.step).replace(':orders', ':r1');
      expect(await checkChain(replay, expected)).toBe('mismatch');
    }
  });

  it('press and intent steps are not folded: a moved head on one is a mismatch, dropping them all changes nothing', async () => {
    {
      const { expected, replay } = load();
      const i = replay.ticks.findIndex((t) => dipStepOf(t)?.kind === 'press');
      replay.ticks[i].state_hash = `sha256:${'1'.repeat(64)}`;
      expect(dipChainProblem(replay, expected)).toMatch(/press.*never folded/);
    }
    {
      const { expected, replay } = load();
      const pressSteps = replay.ticks.filter((t) => dipStepOf(t)?.kind === 'press');
      expect(pressSteps.length).toBeGreaterThan(0);
      replay.ticks = replay.ticks.filter((t) => dipStepOf(t)?.adjudicates);
      expect(await checkChain(replay, expected)).toBe('ok');
    }
  });
});
