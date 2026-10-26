// Files in mail with other people: the bytes of what the user sent and what
// arrived, kept in Stem's private state (never a folder an agent can read), one
// file per id with its name and type beside it. A device fetches one on the
// existing GET /files/ route under MAIL_FILE_PREFIX; the id is 128 random bits.
// A persona reads one only when the user asks it to draft after releasing the
// mail it came with (router draftExternal).
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { mailFilesRoot } from '../workspace/paths';
import type { DownloadTarget } from '../transport/server';

/** GET /files/<MAIL_FILE_PREFIX><id> fetches one mail file. */
export const MAIL_FILE_PREFIX = 'stem-mailfile:';
/**
 * All files of one mail, before sealing. The relay takes 25 MB of sealed
 * payload, and the files ride it base64-encoded (4/3) beside a body of up to 1 MB.
 */
export const MAIL_FILES_MAX_BYTES = 17 * 1024 * 1024;
export const MAIL_FILES_MAX_COUNT = 20;

export interface MailFileMeta {
  name: string;
  mime: string;
  size: number;
}

const ID = /^[0-9a-f]{32}$/;

function safeName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex -- control characters are exactly what a file name must not carry
  const clean = base.replace(/[\u0000-\u001f]/g, '').trim().slice(0, 200);
  return clean || 'file';
}

export async function putMailFile(bytes: Buffer, name: string, mime?: string): Promise<{ id: string } & MailFileMeta> {
  const root = mailFilesRoot();
  await mkdir(root, { recursive: true, mode: 0o700 });
  const id = randomBytes(16).toString('hex');
  const meta: MailFileMeta = { name: safeName(name), mime: mime && /^[\w.+-]+\/[\w.+-]+$/.test(mime) ? mime : 'application/octet-stream', size: bytes.length };
  await writeFile(join(root, id), bytes, { mode: 0o600, flag: 'wx' });
  await writeFile(join(root, `${id}.json`), JSON.stringify(meta), { mode: 0o600 });
  return { id, ...meta };
}

export function mailFilePath(id: string): string | null {
  return ID.test(id) ? join(mailFilesRoot(), id) : null;
}

export async function readMailFile(id: string): Promise<({ bytes: Buffer } & MailFileMeta) | null> {
  const path = mailFilePath(id);
  if (!path) return null;
  try {
    const meta = JSON.parse(await readFile(`${path}.json`, 'utf8')) as MailFileMeta;
    return { ...meta, bytes: await readFile(path) };
  } catch {
    // quiet: a missing file reads as none; callers say so.
    return null;
  }
}

/** A deleted conversation's files. Best-effort: a file left behind only costs disk. */
export async function removeMailFiles(ids: string[]): Promise<void> {
  for (const id of ids) {
    const path = mailFilePath(id);
    if (!path) continue;
    // quiet: a file left behind only costs disk.
    await rm(path, { force: true }).catch(() => undefined);
    // quiet: the same for its name and type.
    await rm(`${path}.json`, { force: true }).catch(() => undefined);
  }
}

/** For the /files/ route. */
export async function mailFileDownload(id: string): Promise<DownloadTarget | null> {
  const path = mailFilePath(id);
  if (!path) return null;
  try {
    const meta = JSON.parse(await readFile(`${path}.json`, 'utf8')) as MailFileMeta;
    return { path, name: meta.name, size: (await stat(path)).size };
  } catch {
    // quiet: no such file — the route answers 404 like any other.
    return null;
  }
}
