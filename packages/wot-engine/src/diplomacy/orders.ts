/**
 * Canonical text for raw and normalised orders (design §1.5.2). `formatRaw`
 * re-emits every optional token that was present, in grammar order, so that
 * parseOrder(formatRaw(x)) deep-equals x and formatRaw(parseOrder(s)) === s.
 */

import type { Order, RawLoc, RawOrder } from './types.ts';

export const locText = (l: RawLoc): string => (l.coast ? `${l.p}/${l.coast}` : l.p);

export function formatRaw(o: RawOrder): string {
  switch (o.k) {
    case 'waive':
      return 'W';
    case 'build':
      return `B ${o.type} ${locText(o.at)}`;
    default:
      break;
  }
  const head = `${o.type ? `${o.type} ` : ''}${locText(o.at)}`;
  switch (o.k) {
    case 'hold':
      return `${head} H`;
    case 'move':
      return `${head} - ${locText(o.to)}${o.via ? ' VIA' : ''}`;
    case 'support':
    case 'convoy': {
      const kw = o.k === 'support' ? 'S' : 'C';
      const who = `${o.ofPower ? `${o.ofPower} ` : ''}${o.ofType ? `${o.ofType} ` : ''}${locText(o.of)}`;
      return `${head} ${kw} ${who}${o.to ? ` - ${locText(o.to)}` : ''}`;
    }
    case 'retreat':
      return `${head} R ${locText(o.to)}`;
    case 'disband':
      return `${head} D`;
  }
}

/** Canonical normalised text: always the unit type, never a power. */
export function formatOrder(o: Order): string {
  switch (o.k) {
    case 'waive':
      return 'W';
    case 'build':
      return `B ${o.type} ${o.at}`;
    case 'hold':
      return `${o.unit.type} ${o.unit.at} H`;
    case 'move':
      return `${o.unit.type} ${o.unit.at} - ${o.to}${o.convoyed ? ' VIA' : ''}`;
    case 'support':
      return `${o.unit.type} ${o.unit.at} S ${o.ofType} ${o.of}${
        o.to ? ` - ${o.to}${o.toCoast ? `/${o.toCoast}` : ''}` : ''
      }`;
    case 'convoy':
      return `${o.unit.type} ${o.unit.at} C ${o.ofType} ${o.of} - ${o.to}`;
    case 'retreat':
      return `${o.unit.type} ${o.unit.at} R ${o.to}`;
    case 'disband':
      return `${o.unit.type} ${o.unit.at} D`;
  }
}
