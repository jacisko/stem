import { useCallback, useEffect, useState } from 'react';
import {
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Plus,
  Download,
  FolderOpen,
  FolderPlus,
  Trash2,
  Package,
  File as FileIcon
} from 'lucide-react';
import {
  FILES_CONTEXT_LIMIT,
  FILES_LISTING_CAP,
  type FileEntry,
  type FilesListing,
  type SkippedFilesDir
} from '../../../shared/types';
import { useRemoteServer } from '../../hooks/useRemoteServer';
import { InfoTip } from '../../ui/InfoTip';

// ---- Files sub-tab: the persistent drop-place inside Stem's own workspace ----
// Unlike a connected folder (a reference to files that stay where they live),
// Files holds copies, and every name is listed to the assistant each turn — so
// this surface is a plain file browser, not a settings list: what's in there,
// how big, and a way to take something back out. Subfolders are one level deep
// on purpose — each one becomes a band in the drag-to-place overlay.

/** "1.2 MB" / "834 KB" / "512 B" — one significant decimal above KB. */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** How the subfolder groups are ordered. Top level always comes first. */
type GroupSort = 'name' | 'size' | 'recent';

interface Group {
  dir: string;
  files: FileEntry[];
  /** Tool folders inside it, named but not walked (server/files/bulky.ts). */
  skipped: SkippedFilesDir[];
  bytes: number;
  /** Newest file mtime in ms; 0 when unknown (empty, or an older server). */
  newestMs: number;
}

/**
 * One section per top-level subfolder, root first, then by `sort`. Driven by
 * `dirs` (not just the dirs that happen to hold files) so a folder you just
 * created stays on screen while it is still empty.
 */
function buildGroups(listing: FilesListing | null, sort: GroupSort): Group[] {
  if (!listing) return [];
  const groups = new Map<string, Group>();
  const group = (dir: string) => {
    let g = groups.get(dir);
    if (!g) groups.set(dir, (g = { dir, files: [], skipped: [], bytes: 0, newestMs: 0 }));
    return g;
  };
  group('');
  for (const d of listing.dirs) group(d);
  for (const f of listing.files) {
    const g = group(f.dir); // creates a dir that appeared between list and render
    g.files.push(f);
    g.bytes += f.size;
    g.newestMs = Math.max(g.newestMs, f.mtimeMs ?? 0);
  }
  for (const s of listing.skipped ?? []) group(s.dir).skipped.push(s);
  const order = (a: Group, b: Group) =>
    sort === 'size' ? b.bytes - a.bytes : sort === 'recent' ? b.newestMs - a.newestMs : 0;
  return [...groups.values()]
    .filter((g) => g.dir !== '' || g.files.length > 0 || g.skipped.length > 0) // no empty "Top level"
    .sort((a, b) => (a.dir === '' ? -1 : b.dir === '' ? 1 : order(a, b) || a.dir.localeCompare(b.dir)));
}

/** "12 Oct" this year, "12 Oct 2025" before it. */
function formatDay(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    ...(d.getFullYear() === new Date().getFullYear() ? {} : { year: 'numeric' })
  });
}

export function FilesTab() {
  const [listing, setListing] = useState<FilesListing | null>(null);
  const [sort, setSort] = useState<GroupSort>('name');
  const [busy, setBusy] = useState(false);
  // Non-null while the inline "new folder" row is open; holds its draft name.
  const [newDir, setNewDir] = useState<string | null>(null);
  const [dirError, setDirError] = useState<string | null>(null);
  /** What a download said when it went wrong; cleared by the next attempt. */
  const [error, setError] = useState<string | null>(null);
  // The Files folder is the server's. On a machine that isn't the server's, a
  // file manager here cannot open it — so Download replaces "reveal" rather than
  // sitting beside a button that could only ever fail.
  const remote = useRemoteServer();
  // Subfolder groups folded shut. Every group starts open; the header's
  // chevrons fold or unfold them all at once.
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const toggleGroup = (dir: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(dir)) next.delete(dir);
      else next.add(dir);
      return next;
    });

  const refresh = useCallback(() => {
    window.stem.listFiles().then(setListing).catch(() => undefined);
  }, []);

  useEffect(refresh, [refresh]);

  // The drop overlay writes into files/ without going through this tab, and the
  // folder is a real directory the user can also edit in Finder — so re-read on
  // an overlay drop and whenever the window regains focus.
  useEffect(() => {
    window.addEventListener('stem:files-changed', refresh);
    window.addEventListener('focus', refresh);
    return () => {
      window.removeEventListener('stem:files-changed', refresh);
      window.removeEventListener('focus', refresh);
    };
  }, [refresh]);

  async function add() {
    setBusy(true);
    try {
      const paths = await window.stem.openFiles();
      // Picked files land at the root; the drop overlay is how you target a
      // subfolder (it turns each one into a band).
      if (paths.length) setListing(await window.stem.addFiles(paths));
    } finally {
      setBusy(false);
    }
  }

  /** Save a copy where downloads go and show it there. */
  async function download(f: FileEntry) {
    setBusy(true);
    setError(null);
    try {
      await window.stem.downloadFile(f.rel);
    } catch (e) {
      setError(String((e as Error)?.message ?? e).replace(/^Error:\s*/, ''));
    } finally {
      setBusy(false);
    }
  }

  async function remove(f: FileEntry) {
    if (!window.confirm(`Delete “${f.name}” from your Files folder?\n\nThis removes it from disk.`)) return;
    setListing(await window.stem.removeFile(f.rel));
  }

  async function removeSkipped(s: SkippedFilesDir) {
    if (!window.confirm(`Delete “${s.rel}” (${s.kind}) from your Files folder?\n\nIt and everything inside it are removed from disk.`)) return;
    setListing(await window.stem.removeFile(s.rel));
  }

  async function removeDir(dir: string, count: number) {
    const contents =
      count === 0
        ? '\n\nIt is empty.'
        : `\n\nThe ${count} file${count === 1 ? '' : 's'} inside ${count === 1 ? 'is' : 'are'} removed from disk with it.`;
    if (!window.confirm(`Delete the “${dir}” subfolder?${contents}`)) return;
    setListing(await window.stem.removeFilesSubdir(dir));
  }

  async function commitNewDir() {
    const name = (newDir ?? '').trim();
    if (!name) {
      setNewDir(null);
      setDirError(null);
      return;
    }
    // Main rejects these too (files/store.ts) — checking here turns a thrown IPC
    // error into an inline message instead of a silently dropped click.
    if (name.includes('/') || name.includes('\\') || name.startsWith('.')) {
      setDirError('Use a plain name — no slashes, and not starting with a dot.');
      return;
    }
    try {
      setListing(await window.stem.createFilesSubdir(name));
      setNewDir(null);
      setDirError(null);
    } catch {
      setDirError("That name can't be used as a folder.");
    }
  }

  const files = listing?.files ?? [];
  const groups = buildGroups(listing, sort);
  const skippedCount = listing?.skipped?.length ?? 0;
  const empty = files.length === 0 && skippedCount === 0 && (listing?.dirs.length ?? 0) === 0;
  // Groups only get a foldable head when there is more than the top level.
  const headed = groups.some((g) => g.dir !== '') || groups.length > 1;
  const allCollapsed = headed && groups.every((g) => collapsed.has(g.dir));
  /** Show a file or subfolder in Finder (only when the Files folder is on this disk). */
  const reveal = (rel: string) => {
    setError(null);
    window.stem.revealFiles(rel).catch((e: unknown) => setError(String((e as Error)?.message ?? e).replace(/^Error:\s*/, '')));
  };

  return (
    <div>
      <div className="grp-head cfolders-head">
        Files
        <span className="grp-head-actions">
          {headed && (
            <button
              className="grp-head-add"
              onClick={() => setCollapsed(allCollapsed ? new Set() : new Set(groups.map((g) => g.dir)))}
              title={allCollapsed ? 'Expand all folders' : 'Collapse all folders'}
              aria-label={allCollapsed ? 'Expand all folders' : 'Collapse all folders'}
            >
              {allCollapsed ? <ChevronsUpDown size={14} /> : <ChevronsDownUp size={14} />}
            </button>
          )}
          {!remote && (
            <button
              className="grp-head-add"
              onClick={() => window.stem.revealFiles()}
              title="Open the Files folder in Finder"
              aria-label="Open Files folder"
            >
              <FolderOpen size={14} />
            </button>
          )}
          <button
            className={`grp-head-add${newDir !== null ? ' active' : ''}`}
            onClick={() => {
              setNewDir(newDir === null ? '' : null);
              setDirError(null);
            }}
            title="Create a subfolder (it also becomes a drop destination)"
            aria-label="New subfolder"
          >
            <FolderPlus size={14} />
          </button>
          <button
            className="grp-head-add"
            onClick={add}
            disabled={busy}
            title="Copy files into your Files folder"
            aria-label="Add files"
          >
            <Plus size={14} />
          </button>
        </span>
      </div>

      {newDir !== null && (
        <div className="files-newdir">
          <input
            className="ifield"
            autoFocus
            placeholder="Subfolder name"
            aria-label="New subfolder name"
            value={newDir}
            onChange={(e) => {
              setNewDir(e.target.value);
              setDirError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void commitNewDir();
              else if (e.key === 'Escape') {
                setNewDir(null);
                setDirError(null);
              }
            }}
          />
          <button type="button" className="push default" onClick={() => void commitNewDir()}>
            Create
          </button>
          {dirError && <span className="files-newdir-error">{dirError}</span>}
        </div>
      )}

      {error && <p className="files-error">{error}</p>}

      {groups.length > 1 && (
        <div className="files-sort">
          <select className="vfield" aria-label="Order subfolders by" value={sort} onChange={(e) => setSort(e.target.value as GroupSort)}>
            <option value="name">By name</option>
            <option value="size">Largest first</option>
            <option value="recent">Recently changed first</option>
          </select>
        </div>
      )}

      {empty ? (
        <p className="muted">
          Drop a file anywhere on the Stem window and choose “Add to Files”, and a copy is kept
          here for good. Stem is told the name of every file in this folder at the start of each
          turn, and reads the ones it needs — so keep it to things worth having on hand.
        </p>
      ) : (
        <>
          {groups.map(({ dir, files: entries, skipped, bytes, newestMs }) => (
            <div key={dir || '__root__'}>
              {headed && (
                <div className="grp-head files-group-head">
                  <button
                    className="files-group-toggle"
                    onClick={() => toggleGroup(dir)}
                    aria-expanded={!collapsed.has(dir)}
                  >
                    <ChevronRight size={12} className={`chat-caret${collapsed.has(dir) ? '' : ' open'}`} />
                    <span>{dir === '' ? 'Top level' : dir}</span>
                    <em className="files-group-count">
                      {entries.length.toLocaleString()} · {formatSize(bytes)}
                      {newestMs > 0 && ` · ${formatDay(newestMs)}`}
                    </em>
                  </button>
                  {dir !== '' && (
                    <span className="files-group-actions">
                      {!remote && (
                        <button
                          className="grp-head-add"
                          onClick={() => reveal(dir)}
                          title="Open in Finder"
                          aria-label={`Open subfolder ${dir} in Finder`}
                        >
                          <FolderOpen size={13} />
                        </button>
                      )}
                      <button
                        className="grp-head-add"
                        onClick={() => void removeDir(dir, entries.length)}
                        title={`Delete the ${dir} subfolder`}
                        aria-label={`Delete subfolder ${dir}`}
                      >
                        <Trash2 size={13} />
                      </button>
                    </span>
                  )}
                </div>
              )}
              {!(headed && collapsed.has(dir)) && (
                <div className="group">
                  {skipped.map((sk) => (
                    <div key={sk.rel} className="group-row files-row">
                      <span className="row-icon">
                        <Package size={14} />
                      </span>
                      <span className="row-main">
                        <strong title={sk.rel}>{dir ? sk.rel.slice(dir.length + 1) || sk.rel : sk.rel}</strong>
                        <em>{sk.kind} · not listed to the assistant</em>
                      </span>
                      <button
                        className="icon-action sm row-action"
                        onClick={() => void removeSkipped(sk)}
                        title="Delete from Files"
                        aria-label={`Delete ${sk.rel}`}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  ))}
                  {entries.length === 0 && skipped.length === 0 ? (
                    <div className="group-row files-row">
                      <span className="muted">Empty — drop files here to fill it.</span>
                    </div>
                  ) : (
                    entries.map((f) => (
                      <div key={f.rel} className="group-row files-row">
                        <span className="row-icon">
                          <FileIcon size={14} />
                        </span>
                        <span className="row-main">
                          <strong title={f.rel}>{f.name}</strong>
                          <em>{formatSize(f.size)}</em>
                        </span>
                        {!remote && (
                          <button
                            className="icon-action sm row-action"
                            onClick={() => reveal(f.rel)}
                            title="Show in Finder"
                            aria-label={`Show ${f.name} in Finder`}
                          >
                            <FolderOpen size={14} />
                          </button>
                        )}
                        <button
                          className="icon-action sm row-action"
                          onClick={() => void download(f)}
                          disabled={busy}
                          title="Save a copy to your Downloads folder"
                          aria-label={`Download ${f.name}`}
                        >
                          <Download size={14} />
                        </button>
                        <button
                          className="icon-action sm row-action"
                          onClick={() => void remove(f)}
                          title="Delete from Files"
                          aria-label={`Delete ${f.name}`}
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>
          ))}
          <p className="muted files-foot">
            {listing?.truncated && 'At least '}
            {files.length.toLocaleString()} file{files.length === 1 ? '' : 's'}
            {listing?.truncated && ` (the listing stops at ${FILES_LISTING_CAP.toLocaleString()})`}
            {skippedCount > 0 && ` · ${skippedCount} tool folder${skippedCount === 1 ? '' : 's'} not listed`}
            {files.length > FILES_CONTEXT_LIMIT && (
              <>
                {' · '}
                large subfolders are summarized for the assistant
                <InfoTip label="How the assistant sees a big folder">
                  Every turn, Stem lists the names of the files in this folder so the assistant
                  knows what it can read. Past {FILES_CONTEXT_LIMIT} files, a subfolder with more
                  than a handful becomes one line with a count and a few names, and the whole list
                  is capped at {FILES_CONTEXT_LIMIT} lines. Everything is still on disk and readable;
                  the assistant looks inside a folder when it needs to. Tool folders such as
                  virtualenvs and node_modules are named but never listed. For a pile this size, a
                  connected folder with indexing on is the better fit.
                </InfoTip>
              </>
            )}
          </p>
        </>
      )}
    </div>
  );
}
