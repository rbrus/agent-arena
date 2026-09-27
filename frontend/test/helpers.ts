import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { vi } from 'vitest';
import { App } from '../src/inspector/App.tsx';
import type { Report } from '../src/lib/load.ts';
import type { ReplayFile } from '../src/lib/replay-format.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

export const SAMPLES = join(__dirname, '..', 'public', 'samples');
export const readSample = (f: string) => readFileSync(join(SAMPLES, f), 'utf8');
export const index = (): { id: string; report: string; replay?: string }[] => JSON.parse(readSample('index.json'));

/** Every fetch the app makes is recorded and refused: the inspector must work without network. */
export function offline() {
  const calls: string[] = [];
  vi.stubGlobal('fetch', (u: string) => {
    calls.push(String(u));
    return Promise.reject(new Error('offline'));
  });
  return calls;
}

export async function mount(report: Report | null, replay: ReplayFile | null): Promise<{ el: HTMLElement; root: Root }> {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => {
    root.render(createElement(App, { initialReport: report, initialReplay: replay }));
  });
  // Let the async WebCrypto chain check settle.
  for (let i = 0; i < 200 && el.querySelector('.chain.c-checking'); i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
  }
  return { el, root };
}
