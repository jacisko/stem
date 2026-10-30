import { execFile } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { constants, existsSync, readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { mkdir, open, readdir, realpath, rmdir, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';
import { sandboxOf } from '../../shared/browser-native';

// Browser control for a browser packaged as a Snap or a Flatpak (Linux).
//
// The sandbox runs a native host only from inside its own folders, and that
// host cannot start Stem's binary, read Stem's state folder or reach its unix
// socket. What it can run is bash and coreutils from its own base, and what it
// can reach is the loopback network. So Set up writes a relay into the
// browser's own folder (~/snap/<name>/common/stem, ~/.var/app/<id>/data/stem):
// a bash script that connects to Stem over 127.0.0.1, does the token
// handshake, and then pipes native-messaging frames both ways unparsed.
//
// Its handshake is handshake.ts's in text lines, since bash cannot easily
// parse JSON frames:
//
//   relay → desktop   STEM-RELAY 1 <nonce h> <app>\n
//   desktop → relay   <nonce s> <mac("stem", h)>\n
//   relay → desktop   <mac("host", s)>\n
//
// The relay sends nothing more until the desktop has proved itself, so a
// process that took the port while Stem was closed learns nothing and cannot
// drive the browser. `app` is `snap:<name>` or `flatpak:<id>`, written into
// the script by Set up, and the desktop accepts only one it finds installed.
//
// Each relay holds its own key, derived from a secret only the desktop keeps
// (relayKey): the sandboxed browser can read its relay, and a compromised one
// must not be able to pose as another browser, nor as Stem to a Node host.
//
// The sandboxed browser is the party the sandbox distrusts, and it can write
// to its own folder. So the desktop works there only through folders it holds
// open (sandboxDir), and copies a download only when it is a plain file inside
// the user's Downloads folder (openDownload).
//
// The relay runs inside the sandbox, so what the Node host does beyond
// relaying moves to the desktop: it copies finished downloads out of
// ~/Downloads itself (Linux has no privacy prompt), and an upload's files go
// to the relay's folder, which the sandboxed browser can read.
//
// When Stem is not running the relay retries every two seconds, keeping the
// port open as the Node host does; once a connection drops it exits, and the
// extension reconnects with a fresh hello.

export const RELAY_PROTOCOL = 1;

/** The relay's first line, or null when it is not one. */
export function parseRelayHello(line: string): { nonce: string; app: string } | null {
  const m = /^STEM-RELAY (\d+) ([0-9a-f]{32}) (\S{1,300})$/.exec(line);
  if (!m || Number(m[1]) !== RELAY_PROTOCOL || !sandboxOf(m[3]!)) return null;
  return { nonce: m[2]!, app: m[3]! };
}

/** One sandboxed browser's relay key: an HMAC of its id under the desktop's relay secret, 64 hex characters. */
export function relayKey(secret: string, app: string): string {
  return createHmac('sha256', secret).update(`relay\0${app}`).digest('hex');
}

/** sh-quote, for values that go into the script. */
function q(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * The relay script. bash (not sh) for /dev/tcp and `wait -n`; every program it
 * runs (cat, od, tr, sleep, sha256sum) is one a strict snap may run from its
 * base. HMAC-SHA256 is built from sha256sum: the token, 64 hex characters, is
 * exactly one SHA-256 block, so it needs no padding or hashing first.
 */
export function relayScript(opts: { port: number; token: string; app: string; configPath: string }): string {
  if (!/^[0-9a-f]{64}$/.test(opts.token)) throw new Error('the relay needs a 64-character hex token');
  return `#!/bin/bash
# Stem browser control: the relay a sandboxed browser runs as its native host.
# Written by Stem (Settings → Features → Browser control → Set up) for the profile
# whose config is ${opts.configPath}
# Rewritten when Stem starts; it holds this profile's token, keep it private.
export LC_ALL=C
port=${opts.port}
token=${q(opts.token)}
app=${q(opts.app)}

log() { printf 'stem-browser-host: %s\\n' "$1" >&2; }

# hmac ROLE NONCE: HMAC-SHA256 under the token of ROLE, a NUL, and NONCE, in hex.
hmac() {
  local i c ipad='' opad='' inner bin=''
  for ((i = 0; i < 64; i++)); do
    printf -v c '%d' "'\${token:i:1}"
    printf -v ipad '%s\\\\x%02x' "$ipad" $((c ^ 0x36))
    printf -v opad '%s\\\\x%02x' "$opad" $((c ^ 0x5c))
  done
  inner=$({ printf "$ipad"; printf '%s\\0%s' "$1" "$2"; } | sha256sum)
  for ((i = 0; i < 64; i += 2)); do bin+="\\\\x\${inner:i:2}"; done
  inner=$({ printf "$opad"; printf "$bin"; } | sha256sum)
  printf '%s' "\${inner%% *}"
}

# The browser's port, kept on fd 4: a background job's stdin would be /dev/null.
exec 4<&0
while :; do
  if ! { exec 3<>"/dev/tcp/127.0.0.1/$port"; } 2>/dev/null; then
    sleep 2
    continue
  fi
  h=$(od -An -tx1 -N16 /dev/urandom | tr -d ' \\n')
  printf 'STEM-RELAY ${RELAY_PROTOCOL} %s %s\\n' "$h" "$app" >&3
  if read -r -t 10 s proof <&3 && [[ $s =~ ^[0-9a-f]{32}$ && $proof == "$(hmac stem "$h")" ]]; then
    printf '%s\\n' "$(hmac host "$s")" >&3
    cat <&3 &
    out=$!
    cat <&4 >&3 &
    in=$!
    # Either side closed: Stem quit, or the browser closed the port.
    wait -n
    kill "$out" "$in" 2>/dev/null
    exit 0
  fi
  log 'a peer on the port could not prove it is Stem; not relaying to it'
  exec 3>&-
  sleep 2
done
`;
}

/**
 * The part of a sandboxed browser's folder the browser cannot replace (snap
 * may write only below `common`; a Flatpak's own folder is its mount point),
 * and the path from there to Stem's folder, all of which it can.
 */
function sandboxBase(app: string, home: string): { base: string; below: string[] } | null {
  const s = sandboxOf(app);
  if (!s) return null;
  return s.kind === 'snap'
    ? { base: join(home, 'snap', s.id, 'common'), below: ['stem'] }
    : { base: join(home, '.var', 'app', s.id), below: ['data', 'stem'] };
}

/** Where a sandboxed browser's relay, extension copy and uploads live: a folder the browser may read. */
export function sandboxRoot(app: string, home = homedir()): string | null {
  const b = sandboxBase(app, home);
  return b ? join(b.base, ...b.below) : null;
}

/** A folder in a sandboxed browser's Stem folder, held open (sandboxDir). */
export interface SandboxDir {
  /**
   * The path to do things under: /proc/self/fd/<n>, the open folder itself,
   * so the browser swapping a part of the path for a link afterwards changes
   * nothing (openat by another name). Without /proc (only tests off Linux),
   * the real path.
   */
  at: string;
  /** Its real path, for telling the browser where a file is. */
  real: string;
  close(): Promise<void>;
}

const PROC_FD = existsSync('/proc/self/fd');

/**
 * Open a folder under a sandboxed browser's Stem folder, creating it as
 * needed, one part at a time from the base the browser cannot replace: each
 * part opened through the one above it, refusing a link (O_NOFOLLOW) or a
 * folder not this user's. The browser can write there, and must not be able
 * to send Stem's writes or deletes elsewhere. Throws otherwise.
 */
export async function sandboxDir(app: string, home: string, ...sub: string[]): Promise<SandboxDir> {
  const b = sandboxBase(app, home);
  if (!b) throw new Error(`${app} is not a sandboxed browser`);
  // snapd makes `common` itself; created here only when it has not yet.
  await mkdir(b.base, { recursive: true, mode: 0o700 });
  let real = await realpath(b.base);
  let handle = await open(real, constants.O_RDONLY | constants.O_DIRECTORY);
  const uid = process.getuid?.();
  try {
    for (const part of [...b.below, ...sub]) {
      const parent = PROC_FD ? `/proc/self/fd/${handle.fd}` : real;
      const path = join(parent, part);
      await mkdir(path, { mode: 0o700 }).catch((e: NodeJS.ErrnoException) => {
        if (e.code !== 'EEXIST') throw e;
      });
      real = join(real, part);
      const next = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW).catch(() => null);
      const st = await next?.stat();
      if (!next || !st?.isDirectory() || (uid !== undefined && st.uid !== uid)) {
        await next?.close();
        throw new Error(`${real} is not a folder of this user's (a link, or someone else's); Stem will not write there`);
      }
      await handle.close();
      handle = next;
    }
  } catch (e) {
    await handle.close();
    throw e;
  }
  const held = handle;
  return { at: PROC_FD ? `/proc/self/fd/${held.fd}` : real, real, close: () => held.close() };
}

/**
 * Delete `name` in a held-open sandbox folder (`parent` is a SandboxDir's
 * `at`), walking down through open folders rather than paths: each level is
 * opened O_NOFOLLOW and read through /proc/self/fd, so the browser swapping a
 * folder for a link mid-walk gets its link removed, never followed. A plain
 * recursive rm can be raced into deleting whatever the link points at.
 */
export async function removeInSandbox(parent: string, name: string): Promise<void> {
  const path = join(parent, name);
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW).catch((e: NodeJS.ErrnoException) => {
    if (e.code === 'ENOENT') return 'gone' as const;
    // A link or a file: unlink takes the entry itself away.
    return null;
  });
  if (handle === 'gone') return;
  if (!handle) {
    await unlink(path).catch(() => undefined);
    return;
  }
  try {
    const at = PROC_FD ? `/proc/self/fd/${handle.fd}` : path;
    for (const entry of await readdir(at, { withFileTypes: true })) {
      if (entry.isDirectory()) await removeInSandbox(at, entry.name);
      else await unlink(join(at, entry.name)).catch(() => undefined);
    }
  } finally {
    await handle.close();
  }
  await rmdir(path).catch(() => undefined);
}

/** Run `fn` with a sandbox folder held open, closing it after. */
export async function inSandboxDir<T>(app: string, home: string, sub: string[], fn: (dir: SandboxDir) => Promise<T>): Promise<T> {
  const dir = await sandboxDir(app, home, ...sub);
  try {
    return await fn(dir);
  } finally {
    await dir.close();
  }
}

/** The user's Downloads folder, from XDG user-dirs (what a sandboxed browser downloads into), else ~/Downloads. */
export function downloadsDir(home = homedir()): string {
  const config = home === homedir() && process.env.XDG_CONFIG_HOME ? process.env.XDG_CONFIG_HOME : join(home, '.config');
  try {
    const m = /^XDG_DOWNLOAD_DIR="([^"]*)"/m.exec(readFileSync(join(config, 'user-dirs.dirs'), 'utf8'));
    const dir = m?.[1]?.replace(/^\$HOME(?=\/|$)/, home);
    if (dir?.startsWith('/') && dir !== home) return dir;
  } catch {
    // quiet: no user-dirs file means the default folder.
  }
  return join(home, 'Downloads');
}

/**
 * Open a download a sandboxed browser reported, for reading: only a regular
 * file of this user's, one link only, somewhere inside the Downloads folder.
 * The relay's word is the sandbox's, and the desktop reads with the user's
 * full rights, so a path anywhere else — ~/.ssh/id_ed25519, or a link to it
 * in Downloads — is refused. The check runs on the opened file itself
 * (O_NOFOLLOW, then /proc/self/fd), so a swap after it changes nothing.
 */
export async function openDownload(path: string, home = homedir()) {
  const allowed = await realpath(downloadsDir(home));
  // O_NONBLOCK: a FIFO planted in Downloads must not hang the open; the stat below refuses it.
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const st = await handle.stat();
    const uid = process.getuid?.();
    if (!st.isFile() || st.nlink !== 1 || (uid !== undefined && st.uid !== uid)) throw new Error('not a plain file of this user');
    const real = readlinkSync(`/proc/self/fd/${handle.fd}`);
    if (!real.startsWith(`${allowed}${sep}`)) throw new Error('outside the Downloads folder');
    return handle;
  } catch (e) {
    await handle.close();
    throw e;
  }
}

/** The command that starts a sandboxed browser with these arguments. */
export function sandboxCommand(app: string, args: string[]): { command: string; args: string[] } | null {
  const s = sandboxOf(app);
  if (!s) return null;
  if (s.kind === 'snap') return { command: join('/snap/bin', s.id), args };
  return { command: 'flatpak', args: ['run', s.id, ...args] };
}

/** Is the sandboxed browser running? A snap's processes run from /snap/<name>/; Flatpak lists its instances. */
export function sandboxRunning(app: string): Promise<boolean> {
  const s = sandboxOf(app);
  if (!s) return Promise.resolve(false);
  if (s.kind === 'snap') {
    const prefix = `/snap/${s.id}/`;
    let pids: string[] = [];
    try {
      pids = readdirSync('/proc').filter((n) => /^\d+$/.test(n));
    } catch {
      // quiet: no /proc reads as not running, and starting it again opens a window at worst.
    }
    for (const pid of pids) {
      try {
        if (readlinkSync(`/proc/${pid}/exe`).startsWith(prefix)) return Promise.resolve(true);
      } catch {
        // quiet: another user's process, or one that just exited.
      }
    }
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    execFile('flatpak', ['ps', '--columns=application'], { timeout: 5000 }, (error, stdout) =>
      resolve(!error && String(stdout).split('\n').some((l) => l.trim() === s.id))
    );
  });
}
