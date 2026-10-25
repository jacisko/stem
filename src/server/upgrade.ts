import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { host } from './host';
import { liveTurnCount } from './live-turns';
import { log } from './log';
import { replaceFileSync } from './replace-file';
import { compareVersions } from '../shared/versions';
import type { ServerUpgradeStatus } from '../shared/types';

// A server that upgrades itself to the version its clients run.
//
// The desktop app updates itself; the server in a container cannot — nothing
// inside it can replace the image it runs from, and it is not given the docker
// socket that could. So the work is split in two:
//
//   this module  knows the server's version and hears the clients' (every
//                client calls serverUpgrade:status with its own version), picks
//                the newest as the target, and asks for it when no turn is
//                running.
//   the updater  the sidecar in docker-compose.yml (deploy/updater/), which has
//                the docker socket and nothing else: it pulls the release image
//                for the requested version, backs the state up with the old
//                image, swaps the container, and rolls back if the new one does
//                not come up as the version asked for.
//
// They talk through files in one shared volume (STEM_UPDATER_DIR): this side
// writes request.json and server.json, the updater writes status.json with a
// heartbeat. No socket and no port between them, so the only thing the server
// can say to the process that holds the docker socket is a version string —
// which the updater re-validates before it uses it.
//
// Upgrades only ever go up, and only to the version a client actually runs: a
// server never pulls ahead of every client it has, and a client older than the
// server is the client's problem (the desktop updates itself).

const DEFAULT_DIR = '/run/stem-updater';
/** The updater writes status.json every few seconds; older than this, it is gone. */
const HEARTBEAT_STALE_MS = 90_000;
const CHECK_INTERVAL_MS = 60_000;
/** Only a release-shaped version is ever requested; dev suffixes are not published. */
const RELEASE_VERSION = /^\d+\.\d+\.\d+$/;

interface UpdaterStatusFile {
  state?: unknown;
  version?: unknown;
  detail?: unknown;
  heartbeat?: unknown;
}

interface Prefs {
  auto: boolean;
}

export interface UpgradeDeps {
  /** Tell every client the status changed. */
  emit: (status: ServerUpgradeStatus) => void;
  dir?: string;
  now?: () => number;
  isIdle?: () => boolean;
  /** Whether this server runs a published release image (STEM_RELEASE_IMAGE). */
  releaseImage?: boolean;
}

export interface ServerUpgrader {
  noteClientVersion(version: string): void;
  status(): ServerUpgradeStatus;
  /** Ask for the newest client version now, turns or not. Throws when that is not possible. */
  start(): ServerUpgradeStatus;
  setAuto(auto: boolean): ServerUpgradeStatus;
  /** One pass of the automatic check; exported so tests need no timers. */
  tick(): void;
  stop(): void;
}

export function createServerUpgrader(deps: UpgradeDeps): ServerUpgrader {
  const dir = deps.dir ?? process.env.STEM_UPDATER_DIR ?? DEFAULT_DIR;
  const now = deps.now ?? Date.now;
  const isIdle = deps.isIdle ?? (() => liveTurnCount() === 0);
  const releaseImage = deps.releaseImage ?? process.env.STEM_RELEASE_IMAGE === '1';
  const serverVersion = host().appVersion();
  const prefsPath = join(host().stateRoot(), 'server-upgrade.json');

  let newestClient: string | null = null;
  // Set when a request is written, cleared when the updater answers it. Covers
  // the seconds between the two so a status read in between says "working".
  let requested: string | null = null;
  // Automatic upgrades wait for two idle checks in a row, so a gap between two
  // turns of the same conversation is not mistaken for a quiet server.
  let idleChecks = 0;
  let lastSent = '';

  const hasDir = existsSync(dir);
  if (hasDir) {
    try {
      writeJson(join(dir, 'server.json'), { version: serverVersion, release: releaseImage, startedAt: now() });
    } catch (e) {
      log('upgrade', 'could not write server.json', { error: String((e as Error)?.message ?? e) });
    }
  }

  function readPrefs(): Prefs {
    try {
      const raw = JSON.parse(readFileSync(prefsPath, 'utf8')) as Partial<Prefs>;
      return { auto: raw.auto !== false };
    } catch {
      // quiet: no file yet is the default, and a damaged one means the same.
      return { auto: true };
    }
  }

  function readUpdater(): { state: string; version: string | null; detail: string | null } | null {
    if (!hasDir) return null;
    try {
      const raw = JSON.parse(readFileSync(join(dir, 'status.json'), 'utf8')) as UpdaterStatusFile;
      const beat = typeof raw.heartbeat === 'number' ? raw.heartbeat * 1000 : 0;
      if (now() - beat > HEARTBEAT_STALE_MS) return null;
      return {
        state: typeof raw.state === 'string' ? raw.state : 'idle',
        version: typeof raw.version === 'string' ? raw.version : null,
        detail: typeof raw.detail === 'string' ? raw.detail : null
      };
    } catch {
      // quiet: no status.json is what "no updater" looks like.
      return null;
    }
  }

  function target(): string | null {
    if (!newestClient || compareVersions(newestClient, serverVersion) <= 0) return null;
    return newestClient;
  }

  function status(): ServerUpgradeStatus {
    const auto = readPrefs().auto;
    const base = { serverVersion, newestClient, auto };
    const updater = readUpdater();
    if (!updater) return { ...base, updater: 'absent', target: null, detail: null };
    if (!releaseImage) return { ...base, updater: 'source', target: null, detail: null };
    if (updater.state === 'working') {
      requested = null;
      return { ...base, updater: 'working', target: updater.version, detail: updater.detail };
    }
    if (requested) return { ...base, updater: 'working', target: requested, detail: 'Waiting for the updater' };
    // A failure only matters while it is still ahead of us: once a later
    // attempt has put this server on that version, it is history.
    if (updater.state === 'failed' && updater.version && compareVersions(updater.version, serverVersion) > 0) {
      return { ...base, updater: 'failed', target: updater.version, detail: updater.detail };
    }
    return { ...base, updater: 'ready', target: null, detail: null };
  }

  function publish(): ServerUpgradeStatus {
    const s = status();
    const key = JSON.stringify(s);
    if (key !== lastSent) {
      lastSent = key;
      deps.emit(s);
    }
    return s;
  }

  function request(version: string, why: 'auto' | 'manual'): void {
    writeJson(join(dir, 'request.json'), { version, requestedAt: now() });
    requested = version;
    idleChecks = 0;
    log('upgrade', 'asked the updater for a new version', { from: serverVersion, to: version, why });
  }

  function tick(): void {
    const s = status();
    const t = target();
    // A version that failed is not retried on its own — the person can press
    // Upgrade once they have read why — but a newer one is a new attempt.
    const free = s.updater === 'ready' || (s.updater === 'failed' && !!t && !!s.target && compareVersions(t, s.target) > 0);
    if (!s.auto || !free || !t || !RELEASE_VERSION.test(t)) {
      idleChecks = 0;
      publish();
      return;
    }
    idleChecks = isIdle() ? idleChecks + 1 : 0;
    if (idleChecks >= 2) request(t, 'auto');
    publish();
  }

  const timer = hasDir ? setInterval(tick, CHECK_INTERVAL_MS) : null;
  timer?.unref?.();

  return {
    noteClientVersion(version: string): void {
      if (!RELEASE_VERSION.test(version)) return;
      if (!newestClient || compareVersions(version, newestClient) > 0) newestClient = version;
    },
    status: publish,
    start(): ServerUpgradeStatus {
      const s = status();
      const t = target();
      if (s.updater === 'absent') throw new Error('This server has no updater. Upgrade it by hand.');
      if (s.updater === 'source') throw new Error('This server was built from source, so it is not upgraded automatically.');
      if (s.updater === 'working') throw new Error('An upgrade is already running.');
      if (!t) throw new Error('No client is newer than this server.');
      if (!RELEASE_VERSION.test(t)) throw new Error(`${t} is not a release version.`);
      request(t, 'manual');
      return publish();
    },
    setAuto(auto: boolean): ServerUpgradeStatus {
      mkdirSync(host().stateRoot(), { recursive: true });
      writeJson(prefsPath, { auto } satisfies Prefs);
      return publish();
    },
    tick,
    stop(): void {
      if (timer) clearInterval(timer);
    }
  };
}

function writeJson(path: string, value: unknown): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value));
  replaceFileSync(tmp, path);
}
