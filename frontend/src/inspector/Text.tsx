// The only two components that put file-derived strings into the DOM. Both emit
// React text children; nothing here (or anywhere in src/) builds markup, links
// or URLs from report data (verify/no-danger.mjs enforces the obvious bans).
import { CAP, jsonText, sanitize } from '../lib/sanitize.ts';

export function T({ v, cap = CAP.text, className }: { v: unknown; cap?: number; className?: string }) {
  const c = sanitize(v, cap);
  return (
    <span className={className} title={c.truncated ? 'truncated for display' : undefined}>
      {c.text}
    </span>
  );
}

export function JsonBlock({ v, label }: { v: unknown; label: string }) {
  return (
    <pre className="json" aria-label={label} tabIndex={0}>
      {jsonText(v)}
    </pre>
  );
}

const SEV_LABEL = { error: 'ERROR', warning: 'WARN', note: 'NOTE' } as const;

/** Severity/verdict badge: carried by text and shape, colour is redundant. */
export function Badge({ verdict, severity }: { verdict: string; severity: string }) {
  const kind = verdict === 'fail' ? (severity in SEV_LABEL ? severity : 'error') : verdict === 'pass' ? 'pass' : 'na';
  const text = verdict === 'fail' ? SEV_LABEL[kind as keyof typeof SEV_LABEL] : verdict === 'pass' ? 'PASS' : 'N/A';
  return <span className={`badge b-${kind}`}>{text}</span>;
}

export function short(h: string, n = 12): string {
  return h.startsWith('sha256:') ? `${h.slice(7, 7 + n)}…` : h.slice(0, n);
}
