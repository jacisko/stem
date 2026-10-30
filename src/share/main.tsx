import { Component, StrictMode, useEffect, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { Flag, Lock } from 'lucide-react';
import { ShareView } from '../renderer/share/ShareView';
import type { ShareSnapshot } from '../shared/share';
import { NewerShareError, openShare } from './decrypt';
import '../renderer/styles.css';
import './viewer.css';

// share.heystem.app: /s/<id>#<key>. The key never leaves this page; the
// server only hands out the encrypted blob (relay/PROTOCOL.md, "Share links").

type State =
  | { kind: 'loading'; got?: number; total?: number }
  | { kind: 'ready'; snap: ShareSnapshot }
  | { kind: 'error'; title: string; detail: string };

const ID_RE = /^\/s\/([A-Za-z0-9_-]{22})\/?$/;

function parseLocation(): { id: string; key: string } | null {
  const m = ID_RE.exec(location.pathname);
  const key = location.hash.replace(/^#/, '');
  return m && key ? { id: m[1]!, key } : null;
}

/** The blob, reporting bytes as they arrive: a share with pictures runs to
 * megabytes, and a bare "Unlocking…" for that long reads as a broken link. */
async function readBody(res: Response, onProgress: (got: number, total: number) => void): Promise<Uint8Array> {
  const total = Number(res.headers.get('Content-Length')) || 0;
  if (!res.body || !total) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    onProgress(got, total);
  }
  const out = new Uint8Array(got);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

const mb = (bytes: number) => (bytes / (1 << 20)).toFixed(1);

async function load(id: string, key: string, onProgress: (got: number, total: number) => void): Promise<State> {
  let res: Response;
  try {
    res = await fetch(`/v1/shares/${id}`, { credentials: 'omit', referrerPolicy: 'no-referrer' });
  } catch {
    return { kind: 'error', title: 'Could not load this page', detail: 'Check your connection and reload.' };
  }
  if (res.status === 410) {
    const why = ((await res.json().catch(() => ({}))) as { why?: string }).why;
    return why === 'taken_down'
      ? { kind: 'error', title: 'This link was removed', detail: 'It was taken down after a report.' }
      : { kind: 'error', title: 'This link was turned off', detail: 'The person who shared it revoked it.' };
  }
  if (res.status === 404) {
    return { kind: 'error', title: 'Nothing here', detail: 'The link is wrong, or it expired.' };
  }
  if (!res.ok) return { kind: 'error', title: 'Could not load this page', detail: `The server answered ${res.status}.` };
  let blob: Uint8Array;
  try {
    blob = await readBody(res, onProgress);
  } catch {
    return { kind: 'error', title: 'Could not load this page', detail: 'The download stopped. Check your connection and reload.' };
  }
  try {
    const snap = await openShare(blob, key);
    document.title = `${snap.title} · Stem`;
    return { kind: 'ready', snap };
  } catch (e) {
    if (e instanceof NewerShareError) {
      return { kind: 'error', title: 'Made by a newer Stem', detail: 'This page can’t show it yet. Try again later.' };
    }
    return {
      kind: 'error',
      title: 'This link is incomplete',
      detail: 'The part after # is the key that unlocks the page. Copy the whole link and try again.'
    };
  }
}

const REASONS: { id: string; label: string }[] = [
  { id: 'illegal', label: 'Illegal content' },
  { id: 'privacy', label: 'Shares someone’s private information' },
  { id: 'harassment', label: 'Harassment or threats' },
  { id: 'spam', label: 'Spam or scam' },
  { id: 'other', label: 'Something else' }
];

function ReportForm({ id, keyFragment, onDone }: { id: string; keyFragment: string; onDone: () => void }) {
  const [reason, setReason] = useState('illegal');
  const [detail, setDetail] = useState('');
  const [contact, setContact] = useState('');
  const [includeKey, setIncludeKey] = useState(true);
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'failed'>('idle');

  const send = async () => {
    setState('sending');
    try {
      const res = await fetch(`/v1/shares/${id}/report`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'omit',
        body: JSON.stringify({ reason, detail, contact, ...(includeKey ? { key: keyFragment } : {}) })
      });
      setState(res.ok ? 'sent' : 'failed');
    } catch {
      setState('failed');
    }
  };

  if (state === 'sent') {
    return (
      <div className="viewer-report">
        <p>Thank you. We review every report.</p>
        <button className="push" onClick={onDone}>
          Close
        </button>
      </div>
    );
  }
  return (
    <div className="viewer-report">
      <h2>Report this page</h2>
      <label>
        What is wrong?
        <select className="vfield" value={reason} onChange={(e) => setReason(e.target.value)}>
          {REASONS.map((r) => (
            <option key={r.id} value={r.id}>
              {r.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        Details (optional)
        <textarea className="vfield" rows={4} maxLength={4000} value={detail} onChange={(e) => setDetail(e.target.value)} />
      </label>
      <label>
        Your email, if you want an answer (optional)
        <input className="vfield" type="email" maxLength={256} value={contact} onChange={(e) => setContact(e.target.value)} />
      </label>
      <label className="viewer-check">
        <input type="checkbox" checked={includeKey} onChange={(e) => setIncludeKey(e.target.checked)} />
        Let the reviewers see this page. The page is encrypted, so without this we can’t read what you’re reporting.
      </label>
      {state === 'failed' && <p className="task-failed">Could not send the report. Try again in a moment.</p>}
      <div className="viewer-report-actions">
        <button className="push" onClick={onDone}>
          Cancel
        </button>
        <button className="push default" disabled={state === 'sending'} onClick={() => void send()}>
          Send report
        </button>
      </div>
    </div>
  );
}

class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <div className="viewer-message">
        <h1>Could not show this page</h1>
        <p className="muted">Part of it uses something this viewer can’t draw.</p>
      </div>
    ) : (
      this.props.children
    );
  }
}

function Viewer() {
  const [loc] = useState(parseLocation);
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [reporting, setReporting] = useState(false);

  useEffect(() => {
    if (!loc) {
      setState({ kind: 'error', title: 'Nothing here', detail: 'This address is not a shared page.' });
      return;
    }
    // Progress only matters once it's slow: small shares never show it.
    const progress = (got: number, total: number) => {
      if (total >= 512 << 10) setState((s) => (s.kind === 'loading' ? { kind: 'loading', got, total } : s));
    };
    void load(loc.id, loc.key, progress).then(setState);
  }, [loc]);

  return (
    <div className="viewer">
      <main className="viewer-main">
        {state.kind === 'loading' &&
          (state.total && state.got !== undefined && state.got < state.total ? (
            <div className="muted viewer-message">
              <p>
                Downloading {mb(state.got)} of {mb(state.total)} MB…
              </p>
              <progress className="viewer-progress" value={state.got} max={state.total} />
            </div>
          ) : (
            <p className="muted viewer-message">Unlocking…</p>
          ))}
        {state.kind === 'error' && (
          <div className="viewer-message">
            <h1>{state.title}</h1>
            <p className="muted">{state.detail}</p>
          </div>
        )}
        {state.kind === 'ready' && (
          <Boundary>
            <ShareView snapshot={state.snap} />
          </Boundary>
        )}
        {reporting && loc && <ReportForm id={loc.id} keyFragment={loc.key} onDone={() => setReporting(false)} />}
      </main>
      <footer className="viewer-foot">
        <span>
          <Lock size={12} /> Encrypted. Only people with the link can read it.
        </span>
        <span className="viewer-foot-links">
          <a href="https://heystem.app" rel="noopener">
            Made with Stem
          </a>
          {loc && state.kind !== 'loading' && !reporting && (
            <button type="button" className="viewer-link" onClick={() => setReporting(true)}>
              <Flag size={12} /> Report
            </button>
          )}
          <a href="mailto:abuse@heystem.app">abuse@heystem.app</a>
        </span>
      </footer>
    </div>
  );
}

// Pasting another link into the same tab may change only the fragment, which
// doesn't navigate: start over so the page never shows the old share.
window.addEventListener('hashchange', () => location.reload());

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Viewer />
  </StrictMode>
);
