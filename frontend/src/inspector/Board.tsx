// Minimal, deterministic SVG board drawn from ONE observation frame as delivered
// to the target (so it shows exactly what the agent could see). Grid Tactics
// duel frames and eval-raid member views; anything malformed is skipped.
import type { ReactNode } from 'react';
import { clean } from '../lib/sanitize.ts';

type Cell = [number, number];
type O = Record<string, unknown>;
const N = 9;
const S = 32;

const isObj = (x: unknown): x is O => x !== null && typeof x === 'object' && !Array.isArray(x);
const list = (x: unknown): unknown[] => (Array.isArray(x) ? x.slice(0, 128) : []);
const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);
function cell(x: unknown): Cell | null {
  if (!Array.isArray(x) || x.length !== 2) return null;
  const [a, b] = x;
  return Number.isInteger(a) && Number.isInteger(b) && a >= 0 && a < N && b >= 0 && b < N ? [a, b] : null;
}
const cells = (x: unknown): Cell[] => list(x).map(cell).filter((c): c is Cell => c !== null);
const ringOf = (x: number, y: number) => Math.min(x, N - 1 - x, y, N - 1 - y);
const k = (c: Cell) => `${c[0]},${c[1]}`;

function Sq({ c, cls }: { c: Cell; cls: string }) {
  return <rect className={cls} x={c[0] * S + 1} y={c[1] * S + 1} width={S - 2} height={S - 2} />;
}
function Diamond({ c, cls, label }: { c: Cell; cls: string; label: string }) {
  const [cx, cy] = [c[0] * S + S / 2, c[1] * S + S / 2];
  return (
    <g>
      <polygon className={cls} points={`${cx},${cy - 13} ${cx + 13},${cy} ${cx},${cy + 13} ${cx - 13},${cy}`} />
      <text className="glyph" x={cx} y={cy + 4}>{label}</text>
    </g>
  );
}
function Unit({ c, cls, label, shape, sub }: { c: Cell; cls: string; label: string; shape: 'circle' | 'square' | 'tri'; sub?: string }) {
  const [cx, cy] = [c[0] * S + S / 2, c[1] * S + S / 2];
  return (
    <g>
      {shape === 'circle' && <circle className={cls} cx={cx} cy={cy} r={11} />}
      {shape === 'square' && <rect className={cls} x={cx - 10} y={cy - 10} width={20} height={20} />}
      {shape === 'tri' && <polygon className={cls} points={`${cx},${cy - 11} ${cx + 11},${cy + 9} ${cx - 11},${cy + 9}`} />}
      <text className="glyph" x={cx} y={cy + 4}>{label}</text>
      {sub && <text className="sub" x={cx + 11} y={cy + 14}>{sub}</text>}
    </g>
  );
}

function Frame({ children, label, fog, obstacles, rings }: { children: ReactNode; label: string; fog: Set<string> | null; obstacles: Cell[]; rings: number[] }) {
  const all: Cell[] = [];
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) all.push([x, y]);
  const obs = new Set(obstacles.map(k));
  return (
    <svg className="board" viewBox={`0 0 ${N * S} ${N * S}`} role="img" aria-label={label}>
      {all.map((c) => (
        <Sq key={k(c)} c={c} cls={obs.has(k(c)) ? 'obstacle' : rings.includes(ringOf(c[0], c[1])) ? 'cell corrupt' : 'cell'} />
      ))}
      {children}
      {fog && all.filter((c) => !fog.has(k(c))).map((c) => <Sq key={`f${k(c)}`} c={c} cls="fog" />)}
    </svg>
  );
}

const TYPE = (t: unknown) => clean(t, 8).slice(0, 1).toUpperCase() || '?';

export function GridBoard({ obs, obstacles }: { obs: O; obstacles: Cell[] }) {
  const you = isObj(obs.you) ? obs.you : {};
  const vis = obs.visible_cells !== undefined ? new Set(cells(obs.visible_cells).map(k)) : null;
  const collapse = isObj(obs.collapse) ? obs.collapse : {};
  const own = list(you.units).filter(isObj);
  const enemy = list(obs.enemy_visible).filter(isObj);
  return (
    <Frame label={`Grid Tactics board: ${own.length} own units, ${enemy.length} enemy units visible`} fog={vis} obstacles={obstacles} rings={list(collapse.corrupted_rings).filter(Number.isInteger) as number[]}>
      {list(obs.objectives).filter(isObj).map((o, i) => {
        const c = cell(o.cell);
        const ctl = clean(o.controller, 4);
        return c && <Diamond key={`o${i}`} c={c} cls={`objective ctl-${ctl === 'A' || ctl === 'B' ? ctl : 'none'}`} label={ctl === 'none' ? '-' : ctl} />;
      })}
      {own.map((u, i) => {
        const c = cell(u.cell);
        return c && <Unit key={`u${i}`} c={c} cls="own" shape="circle" label={TYPE(u.type)} sub={String(num(u.hp) ?? '?')} />;
      })}
      {enemy.map((u, i) => {
        const c = cell(u.cell);
        return c && <Unit key={`e${i}`} c={c} cls="enemy" shape="square" label={TYPE(u.type)} sub={String(num(u.hp) ?? '?')} />;
      })}
    </Frame>
  );
}

export function RaidBoard({ view }: { view: O }) {
  const self = clean(view.member_id, 4);
  const boss = isObj(view.boss) ? view.boss : {};
  const tel = isObj(view.boss_telegraph) ? view.boss_telegraph : {};
  const part = isObj(view.partition) ? view.partition : null;
  const delay = isObj(view.delay) ? view.delay : null;
  const readings = list(view.boss_readings).filter(isObj).flatMap((r) => cells(r.cells));
  const squad = list(view.squad).filter(isObj);
  return (
    <Frame label={`Raid board as seen by ${self}: boss phase ${num(boss.phase) ?? '?'}, ${squad.length} squad members`} fog={null} obstacles={cells(view.obstacles)} rings={list(view.corrupted_rings).filter(Number.isInteger) as number[]}>
      {cells(boss.footprint).map((c) => <Sq key={`b${k(c)}`} c={c} cls="boss" />)}
      {readings.map((c, i) => <Sq key={`r${i}`} c={c} cls="reading" />)}
      {cells(tel.hazard_cells).map((c) => <Sq key={`h${k(c)}`} c={c} cls="hazard" />)}
      {list(view.anchors).filter(isObj).map((a, i) => {
        const c = cell(a.cell);
        return c && <Diamond key={`a${i}`} c={c} cls={a.held_by ? 'objective ctl-A' : 'objective ctl-none'} label={clean(a.id, 12).replace(/^relay_/, '').slice(0, 1).toUpperCase()} />;
      })}
      {list(view.locks).filter(isObj).map((l, i) => {
        const c = cell(l.cell);
        return c && <Unit key={`l${i}`} c={c} cls="lock" shape="square" label={String(num(l.rank) ?? '?')} />;
      })}
      {part && cell(part.core_cell) && <Unit c={cell(part.core_cell)!} cls="core" shape="circle" label="C" />}
      {delay && cell(delay.observed_cell) && <Unit c={cell(delay.observed_cell)!} cls="stale" shape="tri" label="?" />}
      {list(view.adds).filter(isObj).map((a, i) => {
        const c = cell(a.cell);
        return c && <Unit key={`d${i}`} c={c} cls="enemy" shape="tri" label="+" sub={String(num(a.hp) ?? '?')} />;
      })}
      {squad.map((m, i) => {
        const c = cell(m.cell);
        const id = clean(m.member_id, 4);
        const cls = `own${m.downed === true ? ' downed' : ''}${id === self ? ' self' : ''}${m.is_boss_target === true ? ' targeted' : ''}`;
        return c && <Unit key={`m${i}`} c={c} cls={cls} shape="circle" label={id.replace(/^m/, '')} sub={String(num(m.hp) ?? '?')} />;
      })}
    </Frame>
  );
}

export function obstaclesOf(obs: unknown): Cell[] | null {
  return isObj(obs) && isObj(obs.map) && Array.isArray(obs.map.obstacles) ? cells(obs.map.obstacles) : null;
}
export { isObj, num, list };
