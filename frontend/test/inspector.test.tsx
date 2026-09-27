import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { checkReplay, checkReport, safeParse } from '../src/lib/load.ts';
import { index, mount, offline, readSample } from './helpers.ts';

const rep = (f: string) => checkReport(safeParse(readSample(f)));
const rpl = (f: string) => checkReplay(safeParse(readSample(f)));
const tickLabel = (el: HTMLElement) => el.querySelector('.scrub .mono')?.textContent;

afterEach(() => {
  document.body.innerHTML = '';
});

describe('inspector', () => {
  it('shows run metadata, disclosure, episodes, verdicts and a replay with a verified chain (offline)', async () => {
    offline();
    const { el } = await mount(rep('byzantine-core-20260720-naive/report.json'), rpl('byzantine-core-20260720-naive/report.episode-0.replay.json'));
    const text = el.textContent!;
    // The samples carry the canonical disclosure verbatim (B5c: `agent-arena verify` compares `disclosure`,
    // so the old "Conflict of interest: " prefix is gone). Follow-up for the inspector (ReportView.tsx):
    // render its own "Conflict of interest" label above the sentence, then assert that label here too.
    expect(text).toContain('This arena is maintained by Sixi AI, the vendor of a tool it may be used to score.');
    expect(text).toMatch(/byzantine 1\.\d+\.\d+/);
    expect(text).toContain('byzantine.off_quorum_position');
    expect(text).toContain('primary');
    expect(el.querySelector('.chain')?.className).toContain('c-ok');
    expect(el.querySelectorAll('svg.board rect').length).toBeGreaterThanOrEqual(81);
    expect(tickLabel(el)).toBe('tick 0 / 90');
  });

  it('steps with the keyboard and jumps to an oracle evidence tick', async () => {
    offline();
    const { el } = await mount(rep('byzantine-core-20260720-naive/report.json'), rpl('byzantine-core-20260720-naive/report.episode-0.replay.json'));
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
    });
    expect(tickLabel(el)).toBe('tick 1 / 90');
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'End' }));
    });
    expect(tickLabel(el)).toBe('tick 90 / 90');
    const ev = Array.from(el.querySelectorAll('.evidence button')).find((b) => b.textContent === '90') as HTMLButtonElement;
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home' }));
    });
    await act(async () => ev.click());
    expect(tickLabel(el)).toBe('tick 90 / 90');
    expect(el.textContent).toContain('byzantine.outcome');
  });

  it('draws the Grid Tactics board with fog from the delivered frame', async () => {
    offline();
    const { el } = await mount(rep('grid_tactics-core-2-reflex/report.json'), rpl('grid_tactics-core-2-reflex/report.episode-0.replay.json'));
    expect(el.querySelectorAll('svg.board rect.obstacle').length).toBeGreaterThan(0);
    expect(el.querySelectorAll('svg.board rect.fog').length).toBeGreaterThan(0);
    expect(el.querySelectorAll('svg.board circle.own').length).toBe(4);
  });

  it('for every golden pair, some oracle passes for the robust reference and fails for the naive one', async () => {
    offline();
    const ids = index().map((s) => s.id);
    for (const c of ids.filter((i) => /-(coordinated|reflex)$/.test(i))) {
      const n = ids.find((i) => i === c.replace(/coordinated$/, 'naive').replace(/reflex$/, 'null'))!;
      const verdicts = async (id: string) => {
        const { el } = await mount(rep(`${id}/report.json`), null);
        const out = new Map(Array.from(el.querySelectorAll('.verdicts li')).map((li) => [li.querySelector('.mono')!.textContent!, li.querySelector('.badge')!.textContent!]));
        document.body.innerHTML = '';
        return out;
      };
      const [good, bad] = [await verdicts(c), await verdicts(n)];
      const separating = [...bad].filter(([id, b]) => (b === 'ERROR' || b === 'WARN') && good.get(id) === 'PASS').map(([id]) => id);
      expect(separating.length, `${c} vs ${n}`).toBeGreaterThan(0);
    }
  });

  it('Diplomacy report: verdicts, review_required badge and sentence, episode_invalid wording, both evaluation hashes with copy buttons', async () => {
    offline();
    const report = rep('diplomacy_standard-core-20261115-robust/report.json');
    const { el } = await mount(report, null);
    const text = el.textContent!;
    for (const id of ['manipulation_followed', 'commitment_broken', 'collusion', 'injection_followed', 'intent_leak']) expect(text).toContain(`diplomacy_standard.${id}`);
    const collusion = Array.from(el.querySelectorAll('.verdicts li')).find((li) => li.textContent!.includes('diplomacy_standard.collusion'))!;
    expect(collusion.querySelector('.tag.review')?.textContent).toBe('review required');
    expect(collusion.textContent).toContain('Review required: statistical signal, not proof; inspect the replay before acting.');
    expect(collusion.querySelector('.badge')?.textContent).toBe('N/A');
    for (const k of ['evaluation hash', 'engine evaluation hash', 'transcript hash']) expect(el.querySelector(`button[aria-label="copy ${k}"]`), k).not.toBeNull();
    const ep = report.episodes[0];
    expect(text).toContain(ep.evaluation_hash!.slice(7, 23));
    expect(text).toContain(ep.diplomacy!.engine_evaluation_hash!.slice(7, 23));
    expect(text).toContain('Not assessed in this run');
    document.body.innerHTML = '';

    // A fail of collusion ends with the fixed sentence; episode_invalid reads as such.
    const r2 = structuredClone(report);
    const c = r2.episodes[0].oracles.find((o) => o.oracle_id === 'diplomacy_standard.collusion')!;
    Object.assign(c, { verdict: 'fail', severity: 'error', reason_code: undefined });
    const leak = r2.episodes[0].oracles.find((o) => o.oracle_id === 'diplomacy_standard.intent_leak')!;
    Object.assign(leak, { verdict: 'not_assessed', reason_code: 'episode_invalid' });
    const { el: el2 } = await mount(r2, null);
    const li = Array.from(el2.querySelectorAll('.verdicts li')).find((x) => x.textContent!.includes('diplomacy_standard.collusion'))!;
    expect(li.querySelector('.review-note')?.textContent).toBe('Review required: statistical signal, not proof; inspect the replay before acting.');
    expect(el2.textContent).toContain('Not assessed (episode invalid)');
  });

  it('Diplomacy replay: step list, board as text (no SVG), target action and inbox, chain labelled a file check', async () => {
    offline();
    const { el } = await mount(rep('diplomacy_standard-core-20261115-robust/report.json'), rpl('diplomacy_standard-core-20261115-robust/report.episode-0.replay.json'));
    const chain = el.querySelector('.chain')!;
    expect(chain.className).toContain('c-ok');
    expect(chain.textContent).toContain('not a re-simulation');
    expect(el.querySelectorAll('svg').length).toBe(0);
    expect(el.textContent).toContain('No province map');
    const steps = Array.from(el.querySelectorAll('.steps li')).map((li) => li.textContent!);
    expect(steps.length).toBe(44);
    for (const k of ['S1901M intent', 'S1901M press round 1', 'S1901M orders → adjudication', 'S1904R retreats → adjudication', 'W1901A builds / removals → adjudication']) expect(steps.some((x) => x.includes(k)), k).toBe(true);
    expect(tickLabel(el)).toBe('step 0 / 43');
    expect(el.textContent).toContain('germany (target)');
    expect(el.textContent).toContain('private intent for S1901M');
    // Press round 2: inbox from other powers as germany received it; own batch as counts + text.
    const btn = Array.from(el.querySelectorAll('.steps button')).find((b) => b.textContent === '2') as HTMLButtonElement;
    await act(async () => btn.click());
    expect(tickLabel(el)).toBe('step 2 / 43');
    const text = el.textContent!;
    expect(text).toMatch(/press sent: \d+ messages? \(/);
    expect(text).toContain('from austria · to germany · offer · prs:S1901M:r1:austria:1');
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'End' }));
    });
    expect(el.textContent).toMatch(/orders \(5\):/);
  });

  it('keeps motion behind prefers-reduced-motion: no-preference', () => {
    const css = readFileSync(join(__dirname, '..', 'src', 'styles', 'app.css'), 'utf8');
    const outside = css.replace(/@media \(prefers-reduced-motion: no-preference\) \{[\s\S]*?\}\s*\}\s*\}/, '');
    expect(outside).not.toMatch(/animation|transition/);
    expect(css).toMatch(/animation: fade 150ms/);
  });
});
