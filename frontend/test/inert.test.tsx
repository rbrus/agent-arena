// Proof that hostile target-authored strings in a report and replay render inertly.
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { checkReplay, checkReport, safeParse } from '../src/lib/load.ts';
import { mount, offline, readSample } from './helpers.ts';

const IMG = '<img src=x onerror="window.__pwned=1">';
const ANSI = '\u001b[31mRED\u001b[0m \u001b]8;;http://evil.example/\u0007link\u001b]8;;\u0007 \u001b]52;c;cGF3bmVk\u0007';
const INVISIBLE = 'zero​width ‮bidi‬ \u{E0041}\u{E0042}tags ️vs ⁦iso⁩';
const HOSTILE = `${IMG} ${ANSI} ${INVISIBLE} <script>window.__pwned=2</script> [x](javascript:alert(1)) <a href="javascript:alert(1)">a</a>`;

function hostileFiles() {
  const report = JSON.parse(readSample('byzantine-core-20260720-naive/report.json'));
  const replay = JSON.parse(readSample('byzantine-core-20260720-naive/report.episode-0.replay.json'));
  report.run.spec.target.label = HOSTILE;
  report.run.spec.target.url = `http://localhost:8080/${IMG}`;
  report.disclosure.conflict_of_interest = HOSTILE;
  report.scenario.oracles[0].title = HOSTILE;
  report.episodes[0].outcome_reason = IMG;
  const failing = report.episodes[0].oracles.find((o: { verdict: string }) => o.verdict === 'fail');
  failing.evidence_ref.message = HOSTILE;
  failing.evidence_ref.code = IMG;
  failing.seat = IMG;
  const t0 = replay.ticks[0];
  t0.seats[0].action = { members: { m0: [{ verb: 'ping', unit_id: '<svg onload=alert(1)>', text: HOSTILE, cell: [1, 1], tag: 'hazard' }] }, [IMG]: HOSTILE, thought: 'x'.repeat(100_000) };
  t0.seats[0].ack = { status: 'rejected', reason: IMG };
  t0.seats[0].observation.views[0].member_id = IMG;
  t0.engine_events.push({ type: `<iframe src="javascript:alert(1)">${ANSI}`, note: HOSTILE });
  t0.oracle_events.push({ oracle_id: IMG, severity: 'error', code: HOSTILE });
  // The replay no longer hashes to the report (fine: it must still render inertly).
  return { report: checkReport(safeParse(JSON.stringify(report))), replay: checkReplay(safeParse(JSON.stringify(replay))) };
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('hostile report and replay', () => {
  it('render as inert text: no elements, no handlers, no links, no control or invisible characters', async () => {
    const calls = offline();
    const { report, replay } = hostileFiles();
    const { el } = await mount(report, replay);
    const text = el.textContent ?? '';

    expect(text).toContain('<img src=x onerror='); // visible, as text
    expect(text).toContain('RED');
    expect(text).toContain('link');
    expect(el.querySelectorAll('img, script, iframe, a, object, embed, foreignObject, image, b, [href], [src], [srcdoc]').length).toBe(0);
    for (const node of Array.from(el.querySelectorAll('*'))) {
      for (const a of Array.from(node.attributes)) {
        expect(a.name.startsWith('on'), `${node.tagName} has ${a.name}`).toBe(false);
        expect(a.value.toLowerCase()).not.toContain('javascript:');
      }
    }
    expect(text).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
    expect(text).not.toMatch(/[​-‏‪-‮⁦-⁩️]/);
    expect(text).not.toMatch(/[\u{E0000}-\u{E007F}]/u);
    expect(text).not.toContain('evil.example'); // OSC 8 target stripped with its sequence
    expect(text).not.toContain('cGF3bmVk'); // OSC 52 clipboard payload stripped
    expect(text).not.toContain('x'.repeat(1000)); // long strings capped
    expect((window as { __pwned?: number }).__pwned).toBeUndefined();
    expect(calls.every((u) => u === 'samples/index.json')).toBe(true); // no request carries report data
  });

  it('Diplomacy press text (inbox, own batch, intent notes, asks, terms, feedback) renders as inert plain text', async () => {
    const calls = offline();
    const report = JSON.parse(readSample('diplomacy_standard-core-20261115-robust/report.json'));
    const replay = JSON.parse(readSample('diplomacy_standard-core-20261115-robust/report.episode-0.replay.json'));
    report.episodes[0].diplomacy.roster[0].agent = IMG;
    report.episodes[0].diplomacy.roster[1].persona = '\u001b]8;;http://evil.example/\u0007p\u001b]8;;\u0007';
    report.episodes[0].oracles[0].evidence_ref = { replay_hash: report.episodes[0].replay_hash, ticks: [2], items: [{ kind: '<b onclick=x>k</b>', id: IMG, tick: 2, phase: '<i>p</i>' }] };
    const t = replay.ticks[2]; // S1901M press round 2: inbox and an outgoing batch
    const s0 = t.seats[0];
    s0.observation.inbox.push({ msg_id: IMG, from: IMG, to: { kind: 'group', powers: [IMG, HOSTILE] }, move: 'press', body: HOSTILE, asks: [HOSTILE, IMG], terms: { note: HOSTILE, [IMG]: [HOSTILE] } });
    s0.observation.inbox[0].body = HOSTILE;
    s0.observation.sent.push({ msg_id: 'x', from: 'germany', to: { kind: 'broadcast' }, move: 'press', body: HOSTILE });
    s0.observation.press_rejects.push({ msg_index: IMG, move: HOSTILE, code: IMG, hint: HOSTILE });
    s0.observation.order_feedback.push({ source: IMG, index: 0, code: HOSTILE, raw: HOSTILE });
    s0.observation.private.intent.notes = HOSTILE;
    s0.observation.board.units.push({ power: 'germany', type: IMG, at: HOSTILE });
    s0.observation.board.supply_centers[IMG] = 'germany';
    s0.observation.phase = HOSTILE;
    s0.action.press.push({ to: { kind: 'private', power: IMG }, move: HOSTILE, body: HOSTILE, asks: [IMG], terms: { note: HOSTILE }, respond_to: IMG });
    s0.action.intent = { phase: IMG, orders: [HOSTILE, { unit: IMG }], notes: `${HOSTILE} ${'x'.repeat(100_000)}` };
    s0.ack = { status: 'rejected', reason: IMG };
    t.engine_events.push({ type: IMG, note: HOSTILE });
    t.oracle_events.push({ oracle_id: IMG, severity: 'error', code: HOSTILE });
    const { el } = await mount(checkReport(safeParse(JSON.stringify(report))), checkReplay(safeParse(JSON.stringify(replay))));
    const btn = Array.from(el.querySelectorAll('.steps button')).find((b) => b.textContent === '2') as HTMLButtonElement;
    await act(async () => btn.click());
    for (const d of Array.from(el.querySelectorAll('details'))) d.open = true;
    const text = el.textContent ?? '';
    expect(text).toContain('<img src=x onerror='); // visible, as text, in press
    expect(text).toContain('<script>window.__pwned=2</script>');
    expect(text).toContain('[x](javascript:alert(1))'); // markdown not executed
    expect(text).toContain('RED');
    expect(el.querySelectorAll('img, script, iframe, a, object, embed, foreignObject, image, svg, b, [href], [src], [srcdoc]').length).toBe(0);
    for (const node of Array.from(el.querySelectorAll('*'))) {
      for (const a of Array.from(node.attributes)) {
        expect(a.name.startsWith('on'), `${node.tagName} has ${a.name}`).toBe(false);
        expect(a.value.toLowerCase()).not.toContain('javascript:');
      }
    }
    expect(text).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
    expect(text).not.toMatch(/[​-‏‪-‮⁦-⁩️]/);
    expect(text).not.toMatch(/[\u{E0000}-\u{E007F}]/u);
    expect(text).not.toContain('evil.example');
    expect(text).not.toContain('cGF3bmVk');
    expect(text).not.toContain('x'.repeat(1100));
    expect((window as { __pwned?: number }).__pwned).toBeUndefined();
    expect(calls.every((u) => u === 'samples/index.json')).toBe(true);
  });

  it('the replay no longer matches the committed hash chain, and the page says so', async () => {
    offline();
    const { report, replay } = hostileFiles();
    replay.ticks[3].state_hash = `sha256:${'0'.repeat(64)}`;
    const { el } = await mount(report, replay);
    expect(el.querySelector('.chain')?.textContent).toMatch(/MISMATCH/);
  });
});
