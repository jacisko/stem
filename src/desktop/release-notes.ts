import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { host } from '../server/host';
import { compareVersions } from '../shared/versions';
import type { ReleaseNoteEntry, ReleaseNotesSnapshot } from '../shared/types';
import { readClientSettings, updateClientReleaseNotes } from './settings';

// The "what's new" popup's data layer. RELEASE_NOTES.md ships with the app (it
// is in electron-builder's `files`), so it is read from the app root — the same
// place server/index.ts reads build/icon.png from. asar is off, so this is a plain
// file read in both dev (repo root) and a packaged build.
//
// This is a CLIENT concern, and Phase 2 moved it here from src/server/workspace
// to say so. Every input is a fact about the machine the popup would appear on:
// the version installed here, the RELEASE_NOTES.md shipped with it, and how much
// of it this person has already read. A server answering two Macs on two builds
// has no single correct answer to give, and the one it used to give was whichever
// client asked last.
//
// The parse is deliberately dumb: split on `## ` headings, take the first token
// as the version. Anything that isn't a dotted-numeric version (a prose heading,
// the file's title) is not a release section and is skipped, so the file stays
// editable as ordinary Markdown.

/** A heading like `## 0.3.0 — 2026-07-29`, `## v0.3.0 - Unreleased`, `## 0.3.0`. */
const HEADING = /^##\s+v?(\d+(?:\.\d+)*)\s*(?:[—–-]\s*(.*))?$/;

export { compareVersions };

/**
 * Split RELEASE_NOTES.md into its version sections, newest first (i.e. the file
 * order is preserved — the file is written newest-first and we don't re-sort, so
 * a hand-written ordering quirk shows up as written rather than being hidden).
 * Fenced code blocks are tracked so a `## ` inside one can't split a section.
 */
export function parseReleaseNotes(md: string): ReleaseNoteEntry[] {
  const entries: ReleaseNoteEntry[] = [];
  let current: { version: string; label: string; lines: string[] } | null = null;
  let fenced = false;
  const flush = () => {
    if (current) entries.push({ version: current.version, label: current.label, body: current.lines.join('\n').trim() });
  };
  for (const line of md.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    const m = fenced ? null : HEADING.exec(line);
    if (m) {
      flush();
      current = { version: m[1], label: (m[2] ?? '').trim(), lines: [] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  flush();
  return entries;
}

/**
 * The sections to show now: everything above `lastSeenVersion`, capped at the
 * running version. A null `lastSeenVersion` on an install that is already past
 * onboarding means "we've never recorded anything" — show just the version they
 * are running, not the whole history.
 */
export function selectUnseen(
  entries: ReleaseNoteEntry[],
  lastSeenVersion: string | null,
  appVersion: string
): ReleaseNoteEntry[] {
  const available = entries.filter((e) => compareVersions(e.version, appVersion) <= 0);
  if (lastSeenVersion === null) return available.filter((e) => compareVersions(e.version, appVersion) === 0);
  return available.filter((e) => compareVersions(e.version, lastSeenVersion) > 0);
}

async function readNotesFile(): Promise<string> {
  try {
    return await readFile(join(host().appRoot(), 'RELEASE_NOTES.md'), 'utf8');
  } catch {
    // Missing/unreadable notes are not an error worth surfacing — the popup just
    // never appears and Settings shows an empty history.
    return '';
  }
}

/**
 * The snapshot the renderer drives the popup from. `onboardingCompleted` is the
 * one input that is not this machine's to know — the wizard is about the Stem
 * account, not the laptop — so it is passed in by the handler that already has
 * the server's settings document.
 *
 * Two side effects live here rather than in the renderer, because they must hold
 * whether or not anyone is looking:
 * - onboarding not finished → nothing is unseen (a brand-new user never gets a
 *   wall of history; the marker is seeded when they finish the wizard).
 * - popup switched off → the marker still advances, so re-enabling it later
 *   stays quiet until the *next* release.
 */
export async function releaseNotesSnapshot(onboardingCompleted: boolean): Promise<ReleaseNotesSnapshot> {
  const appVersion = host().appVersion();
  const { releaseNotes } = await readClientSettings();
  const entries = parseReleaseNotes(await readNotesFile()).filter(
    (e) => compareVersions(e.version, appVersion) <= 0
  );
  if (!onboardingCompleted) return { appVersion, entries, unseen: [] };
  if (!releaseNotes.showOnUpdate) {
    if (releaseNotes.lastSeenVersion !== appVersion) await updateClientReleaseNotes({ lastSeenVersion: appVersion });
    return { appVersion, entries, unseen: [] };
  }
  const unseen = selectUnseen(entries, releaseNotes.lastSeenVersion, appVersion);
  return { appVersion, entries, unseen: unseen.map((e) => e.version) };
}

/** Record the running version as shown (called when the popup is dismissed). */
export function markReleaseNotesRead(): Promise<unknown> {
  return updateClientReleaseNotes({ lastSeenVersion: host().appVersion() });
}
