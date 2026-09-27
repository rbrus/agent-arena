/** Test helpers: subprocess CLI runs, scratch dirs, tiny HTTP stubs. Not a test file. */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
export const BIN = join(PKG, 'src', 'bin.ts');
export const WORKSPACE = join(PKG, '..', '..');
/** tsx by its resolved URL, so a child started in any working directory (a temp dir) finds it. */
export const TSX = import.meta.resolve('tsx');

export function scratch(prefix = 'arena-cli-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run the CLI in a child process (tsx), with an explicit, minimal environment. */
export function runCli(args: string[], env: Record<string, string | undefined> = {}, cwd = WORKSPACE): Promise<CliRun> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', TSX, BIN, ...args], {
      cwd,
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env } as NodeJS.ProcessEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

/** Every file under a directory (recursively), with contents. */
export function allFiles(dir: string): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else out.push({ path: p, text: readFileSync(p, 'utf8') });
    }
  };
  walk(dir);
  return out;
}

export interface Stub {
  server: Server;
  port: number;
  url: string;
  requests: { method: string; url: string; headers: IncomingMessage['headers']; body: string }[];
  connections: number;
  close(): Promise<void>;
}

export async function stub(handler: (req: IncomingMessage, body: string, res: ServerResponse, n: number) => void, host = '127.0.0.1'): Promise<Stub> {
  const s: Partial<Stub> = { requests: [], connections: 0 };
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      s.requests!.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
      handler(req, body, res, s.requests!.length);
    });
  });
  server.on('connection', () => (s.connections! += 1));
  await new Promise<void>((r) => server.listen(0, host, () => r()));
  const port = (server.address() as AddressInfo).port;
  return Object.assign(s, {
    server,
    port,
    url: `http://${host}:${port}`,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  }) as Stub;
}

// ── Credential leak checks (gate criterion 6, G-19) ──

export function encodings(v: string): string[] {
  const b = Buffer.from(v);
  return [v, b.toString('base64').replace(/=+$/, ''), b.toString('base64url'), encodeURIComponent(v), b.toString('hex')];
}

/**
 * What a reader of a log can trivially undo: backslash escapes (Markdown /
 * JSON), percent-encoding of any casing, and invisible characters.
 */
export function leakViews(text: string): string[] {
  const unescaped = text.replace(/\\(.)/g, '$1');
  const decoded = unescaped.replace(/%([0-9A-Fa-f]{2})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16)));
  const visible = decoded.replace(/[\u200b-\u200f\u2060-\u2064\ufeff\u00ad]/g, '');
  return [text, unescaped, decoded, visible];
}

/** Every encoding of the canary, plus the 12-char prefix and suffix of each (what a truncation leaves). */
export function leakNeedles(canary: string): { what: string; s: string }[] {
  const out: { what: string; s: string }[] = [];
  encodings(canary).forEach((enc, i) => {
    const what = ['raw', 'base64', 'base64url', 'url-encoded', 'hex'][i];
    out.push({ what, s: enc }, { what: `${what} prefix (truncated)`, s: enc.slice(0, 12) }, { what: `${what} suffix (truncated)`, s: enc.slice(-12) });
  });
  return out;
}

/** Fails if the canary, in any encoding, escaped or truncated form, appears in any blob under any view. */
export function assertNoLeak(canary: string, blobs: { where: string; text: string }[]): void {
  const viewName = ['', 'unescaped', 'percent-decoded', 'invisibles stripped'];
  for (const b of blobs) {
    for (const [vi, view] of leakViews(b.text).entries()) {
      for (const n of leakNeedles(canary)) {
        assert.ok(!view.includes(n.s), `credential (${n.what}) leaked into ${b.where}${vi ? ` (${viewName[vi]} view)` : ''}`);
      }
    }
  }
}
