// interstem.json: this Stem's inter-Stem identity, addresses, contacts and
// outbound queue. Keys are encrypted at rest with the same wrapped data key
// as MCP credentials (pi/secrets.ts); the file is 0600 either way.
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { degrade } from '../degrade';
import { decryptSecretValue, encryptSecretValue } from '../pi/secrets';
import { interStemStorePath } from '../workspace/paths';
import type { InterStemAddress, InterStemContact } from '../../shared/types';
import { newSeed, newX25519Raw, type Cert } from './proto';
import { replaceFile } from '../replace-file';

export interface StoredAddress extends InterStemAddress {
  cert?: Cert;
  addedAt: number;
}

export interface StoredContact extends InterStemContact {
  /** b64 Ed25519 identity key, pinned on first contact. */
  authKey: string;
  /** b64 X25519 encryption key from their key blob (known once we looked them up). */
  encKey?: string;
  /** A newer key seen for them, waiting for the user to acknowledge it. */
  pendingAuthKey?: string;
  pendingEncKey?: string;
}

/** A send waiting to go out (offline, relay unreachable). */
export interface OutboxEntry {
  id: string;
  mailItemId: string;
  conversationId: string;
  from: string;
  to: string;
  /** Inner payload JSON (sealed at send time, so a key change re-checks). */
  inner: string;
  tries: number;
  nextAt: number;
  createdAt: number;
}

/** A mail to someone not (yet) on Stem: looked up now and then until they join. */
export interface WaitingEntry {
  mailItemId: string;
  conversationId: string;
  from: string;
  to: string;
  since: number;
  checkedAt: number;
}

/** A sent envelope whose delivery status we may still learn (contacts only). */
export interface SentEntry {
  envelopeId: string;
  mailItemId: string;
  from: string;
  to: string;
  at: number;
}

interface FileShape {
  version: 1;
  /** Encrypted (or plaintext in no-keyring mode) hex seeds. */
  identitySeed: string;
  encPriv: string;
  addresses: StoredAddress[];
  unlisted: boolean;
  contacts: Record<string, StoredContact>;
  outbox: OutboxEntry[];
  sent: SentEntry[];
  waiting?: WaitingEntry[];
  /** Relay signing keys learned from /.well-known (kid → b64) when none ship built in. */
  relayKeys: Record<string, Record<string, string>>;
}

export interface InterStemState {
  identitySeed: Buffer;
  encPriv: Buffer;
  addresses: StoredAddress[];
  unlisted: boolean;
  contacts: Record<string, StoredContact>;
  outbox: OutboxEntry[];
  sent: SentEntry[];
  waiting: WaitingEntry[];
  relayKeys: Record<string, Record<string, string>>;
}

function freshFile(): FileShape {
  return {
    version: 1,
    identitySeed: encryptSecretValue(newSeed().toString('hex')),
    encPriv: encryptSecretValue(newX25519Raw().toString('hex')),
    addresses: [],
    unlisted: false,
    contacts: {},
    outbox: [],
    sent: [],
    relayKeys: {}
  };
}

function decodeKey(stored: string, what: string): Buffer {
  const hex = decryptSecretValue(stored);
  if (!hex || !/^[0-9a-f]{64}$/.test(hex)) {
    // The data key is gone (keychain reset, copied profile). The identity is
    // unrecoverable: the user re-verifies their addresses with a new one.
    throw new Error(`inter-Stem ${what} key is unreadable`);
  }
  return Buffer.from(hex, 'hex');
}

function toState(f: FileShape): InterStemState {
  return {
    identitySeed: decodeKey(f.identitySeed, 'identity'),
    encPriv: decodeKey(f.encPriv, 'encryption'),
    addresses: Array.isArray(f.addresses) ? f.addresses : [],
    unlisted: f.unlisted === true,
    contacts: f.contacts && typeof f.contacts === 'object' ? f.contacts : {},
    outbox: Array.isArray(f.outbox) ? f.outbox : [],
    sent: Array.isArray(f.sent) ? f.sent : [],
    waiting: Array.isArray(f.waiting) ? f.waiting : [],
    relayKeys: f.relayKeys && typeof f.relayKeys === 'object' ? f.relayKeys : {}
  };
}

export interface InterStemStore {
  read(): Promise<InterStemState>;
  update<T>(mutate: (s: InterStemState) => T | false): Promise<T | false>;
  resetIdentity(): Promise<void>;
}

/** The store at `path` (default: interstem.json in the state dir). */
export function interStemStore(path: string = interStemStorePath()): InterStemStore {
  let chain: Promise<unknown> = Promise.resolve();
  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = chain.then(task, task);
    chain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  async function readRaw(): Promise<FileShape | null> {
    try {
      return JSON.parse(await readFile(path, 'utf8')) as FileShape;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
      degrade('interstem', 'could not read interstem.json', err);
      throw err;
    }
  }

  async function writeRaw(f: FileShape): Promise<void> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const tmp = `${path}.${randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify(f, null, 2), {
      encoding: 'utf8',
      mode: 0o600
    });
    await replaceFile(tmp, path);
    // quiet: a filesystem without permissions (some mounts) still keeps the file.
    await chmod(path, 0o600).catch(() => undefined);
  }

  /** Read the state, creating the identity on first use. */
  function read(): Promise<InterStemState> {
    return enqueue(async () => {
      let f = await readRaw();
      if (!f) {
        f = freshFile();
        await writeRaw(f);
      }
      return toState(f);
    });
  }

  /**
   * Mutate atomically. Keys are never rewritten by a mutation; everything else
   * is saved back. A mutator returning false skips the write.
   */
  function update<T>(mutate: (s: InterStemState) => T | false): Promise<T | false> {
    return enqueue(async () => {
      const f = (await readRaw()) ?? freshFile();
      const s = toState(f);
      const out = mutate(s);
      if (out === false) return false;
      await writeRaw({
        ...f,
        addresses: s.addresses,
        unlisted: s.unlisted,
        contacts: s.contacts,
        outbox: s.outbox,
        sent: s.sent.slice(-2000),
        waiting: s.waiting,
        relayKeys: s.relayKeys
      });
      return out;
    });
  }

  /** Replace the identity (after an unreadable key, or on the user's request). */
  function resetIdentity(): Promise<void> {
    return enqueue(async () => {
      // quiet: an unreadable old file is exactly why the identity is being reset; start clean.
      const prev = await readRaw().catch(() => null);
      const f = freshFile();
      // Keep contacts and the user's settings; addresses must be verified again.
      if (prev) {
        f.contacts = prev.contacts ?? {};
        f.unlisted = prev.unlisted === true;
      }
      await writeRaw(f);
    });
  }

  return { read, update, resetIdentity };
}
