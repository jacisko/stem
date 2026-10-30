// Two Stems talking through the real Go relay (relay/). Skipped when Go is
// not installed. Each Stem gets its own interstem store and an in-memory mail
// port, so both live in this one process.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MailConversation, MailExternal, MailItem, MailListResult } from '../../src/shared/types';
import { InterStemService, type InterStemMailPort } from '../../src/server/interstem/service';
import { interStemStore } from '../../src/server/interstem/store';
import { putMailFile, readMailFile } from '../../src/server/interstem/mail-files';

const hasGo = (() => {
  try {
    execFileSync('go', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const relayDir = join(__dirname, '../../relay');
let relay: ChildProcess | undefined;
let relayLog = '';
let relayUrl = '';

async function waitFor<T>(fn: () => Promise<T | undefined> | T | undefined, what: string, ms = 10_000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    try {
      const v = await fn();
      if (v !== undefined && v !== false) return v as T;
    } catch {
      // keep waiting
    }
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

function lastCode(address: string): string | undefined {
  const re = new RegExp(`mail to ${address.replace(/[.]/g, '\\.')}:[\\s\\S]*?code (?:to connect \\S+ to Stem )?is (\\d{6})`, 'g');
  let m: RegExpExecArray | null;
  let code: string | undefined;
  while ((m = re.exec(relayLog))) code = m[1];
  return code;
}

/** A minimal in-memory stand-in for the mail store. */
function memoryMail(): InterStemMailPort & { conversations: MailConversation[]; items: MailItem[] } {
  const conversations: MailConversation[] = [];
  const items: MailItem[] = [];
  const result = (): MailListResult => ({ conversations, items, inbox: { baseline: 0, entries: {} } });
  return {
    conversations,
    items,
    async createConversation(subject, participants, _body, opts = {}) {
      const c: MailConversation = {
        id: randomUUID(),
        subject,
        participants,
        sessions: {},
        ...(opts.external ? { external: opts.external } : {}),
        status: 'idle',
        exchangeCount: 0,
        sendCounts: {},
        updatedAt: Date.now(),
        userUpdatedAt: 0,
        userSentAt: 0,
        createdAt: Date.now()
      };
      conversations.push(c);
      return c;
    },
    async appendMailItem(input) {
      const fields = { ...input } as Partial<typeof input>;
      delete fields.guard;
      delete fields.staleIfUserSentAfter;
      items.push({ ...fields, id: randomUUID(), at: input.at ?? Date.now() } as MailItem);
      return result();
    },
    async findExternalConversation(thread, address, self) {
      return conversations.find((c) => c.external?.thread === thread && c.external.address === address && c.external.self === self) ?? null;
    },
    async hasExternalEnvelope(id) {
      return items.some((i) => i.external?.envelopeId === id);
    },
    async setExternalStatus(itemId, patch: Partial<MailExternal>) {
      const item = items.find((i) => i.id === itemId);
      if (item) item.external = { ...item.external, ...patch };
      return result();
    },
    async readMail() {
      return result();
    }
  };
}

const noDns = async () => {
  throw Object.assign(new Error('no record'), { code: 'ENOTFOUND' });
};

function makeStem(name: string, opts: Partial<ConstructorParameters<typeof InterStemService>[0]> = {}) {
  const dir = mkdtempSync(join(tmpdir(), `stem-is-${name}-`));
  const mail = memoryMail();
  const svc = new InterStemService({ store: interStemStore(join(dir, 'interstem.json')), mail, txt: noDns, ...opts });
  return { svc, mail };
}

async function verify(stem: ReturnType<typeof makeStem>, address: string): Promise<void> {
  await stem.svc.addAddress(address);
  const code = await waitFor(() => lastCode(address), `code for ${address}`);
  await stem.svc.verifyAddress(address, code);
}

async function startConversation(stem: ReturnType<typeof makeStem>, self: string, to: string, body: string) {
  const conv = await stem.mail.createConversation('Podcast', [], body, {
    external: { address: to, thread: randomUUID().replace(/-/g, ''), self }
  });
  await stem.mail.appendMailItem({ conversationId: conv.id, from: 'user', to: [to], body, external: { status: 'queued' } });
  const item = stem.mail.items.at(-1)!;
  await stem.svc.send(conv.id, item.id);
  return { conv, item };
}

describe.skipIf(!hasGo)('inter-Stem mail through the real relay', () => {
  const vlado = makeStem('vlado');
  const martin = makeStem('martin');

  beforeAll(async () => {
    const work = mkdtempSync(join(tmpdir(), 'stem-relay-'));
    const bin = join(work, 'stem-relay');
    execFileSync('go', ['build', '-o', bin, './cmd/stem-relay'], { cwd: relayDir, stdio: 'inherit' });
    const port = 20000 + Math.floor(Math.random() * 20000);
    relayUrl = `http://127.0.0.1:${port}`;
    writeFileSync(
      join(work, 'relay.toml'),
      `url = "${relayUrl}"\nglobal = true\ndata_dir = "${join(work, 'data')}"\nlisten = "127.0.0.1:${port}"\n` +
        `[limits]\npow_bits = 4\n[invites]\nenabled = true\n`
    );
    relay = spawn(bin, ['serve', '-config', join(work, 'relay.toml')], { stdio: ['ignore', 'pipe', 'pipe'] });
    relay.stdout!.on('data', (d) => (relayLog += d));
    relay.stderr!.on('data', (d) => (relayLog += d));
    process.env.STEM_GLOBAL_RELAY_URL = relayUrl;
    // A plain-http relay on loopback: test only.
    process.env.STEM_INTERSTEM_INSECURE = '1';
    delete process.env.STEM_GLOBAL_RELAY_KEYS;
    await waitFor(async () => (await fetch(`${relayUrl}/v1/info`)).ok || undefined, 'relay to start');
    await verify(vlado, 'vlado@gmail.test');
    await verify(martin, 'martin@gmail.test');
    await vlado.svc.start();
    await martin.svc.start();
  }, 120_000);

  afterAll(() => {
    vlado.svc.stop();
    martin.svc.stop();
    relay?.kill();
    delete process.env.STEM_GLOBAL_RELAY_URL;
    delete process.env.STEM_INTERSTEM_INSECURE;
  });

  it('delivers a first mail held, as a Request, and the reply back into the same conversation', async () => {
    const { conv, item } = await startConversation(vlado, 'vlado@gmail.test', 'martin@gmail.test', 'Shall we record on Sunday?');
    expect(item.external?.status).toBe('sent');

    const got = await waitFor(() => martin.mail.items.find((i) => i.from === 'vlado@gmail.test'), 'martin to receive');
    expect(got.body).toBe('Shall we record on Sunday?');
    expect(got.external?.held).toBe(true);
    const mConv = martin.mail.conversations.find((c) => c.id === got.conversationId)!;
    expect(mConv.external).toMatchObject({ address: 'vlado@gmail.test', self: 'martin@gmail.test', thread: conv.external!.thread });
    expect(mConv.subject).toBe('Podcast');
    expect((await martin.svc.status()).contacts.find((c) => c.address === 'vlado@gmail.test')?.state).toBe('request');

    // Vlado wrote first, so to him Martin is a contact already.
    expect((await vlado.svc.status()).contacts.find((c) => c.address === 'martin@gmail.test')?.state).toBe('accepted');

    await martin.mail.appendMailItem({ conversationId: mConv.id, from: 'user', to: ['vlado@gmail.test'], body: 'Sunday works.', external: { status: 'queued' } });
    await martin.svc.send(mConv.id, martin.mail.items.at(-1)!.id);

    // Replying is accepting: no separate Accept needed.
    await waitFor(
      async () => (await martin.svc.status()).contacts.find((c) => c.address === 'vlado@gmail.test')?.state === 'accepted' || undefined,
      'the reply to accept vlado'
    );
    const reply = await waitFor(() => vlado.mail.items.find((i) => i.from === 'martin@gmail.test'), 'vlado to receive the reply');
    expect(reply.conversationId).toBe(conv.id);
    expect(reply.external?.held).toBe(true);

    // Martin allowed Vlado, so Vlado may learn his first mail was delivered.
    await vlado.svc.pollStatuses();
    expect(vlado.mail.items.find((i) => i.id === item.id)?.external?.status).toBe('delivered');
  }, 30_000);

  it('keeps mail to someone not on Stem, says when they join, and sends it on the user’s click', async () => {
    let offset = 0;
    const joined: string[] = [];
    const zoe = makeStem('zoe', { now: () => Date.now() + offset, onJoined: (j) => joined.push(j.address) });
    await verify(zoe, 'zoe@gmail.test');
    expect(await zoe.svc.lookup('late@gmail.test')).toEqual({ state: 'unreachable' });
    expect(await zoe.svc.lookup('zoe@gmail.test')).toEqual({ state: 'self' });
    expect(await zoe.svc.lookup('martin@gmail.test')).toEqual({ state: 'reachable' });

    const { conv, item } = await startConversation(zoe, 'zoe@gmail.test', 'late@gmail.test', 'Hello?');
    expect(zoe.mail.items.find((i) => i.id === item.id)!.external?.status).toBe('waiting');
    // Looked up again only after a while: lookups are rate-limited.
    await zoe.svc.checkWaiting();
    expect(zoe.mail.items.find((i) => i.id === item.id)!.external?.status).toBe('waiting');

    const late = makeStem('late');
    await verify(late, 'late@gmail.test');
    await late.svc.start();
    offset = 7 * 3_600_000;
    await zoe.svc.checkWaiting();
    expect(zoe.mail.items.find((i) => i.id === item.id)!.external?.status).toBe('joined');
    expect(joined).toEqual(['late@gmail.test']);
    // Never sent blind: it waits for the user.
    expect(late.mail.items).toHaveLength(0);

    offset = 0; // the relay refuses envelopes stamped in the future
    await zoe.svc.resend(conv.id, item.id);
    expect(zoe.mail.items.find((i) => i.id === item.id)!.external?.status).toBe('sent');
    await waitFor(() => late.mail.items.find((i) => i.body === 'Hello?'), 'late to receive');
    await expect(zoe.svc.resend(conv.id, item.id)).rejects.toThrow(/already on its way/);
    late.svc.stop();
  }, 30_000);

  it('takes the first key from a contact blocked before they ever wrote, without a key-changed alarm', async () => {
    const eva = makeStem('eva');
    await verify(eva, 'eva@gmail.test');
    await eva.svc.start();
    await martin.svc.blockContact('eva@gmail.test');
    await martin.svc.unblockContact('eva@gmail.test');
    // No key pinned yet: nothing to have checked in person.
    await expect(martin.svc.markVerified('eva@gmail.test', true)).rejects.toThrow(/no key to check/);
    await expect(martin.svc.setContact('nobody-yet@gmail.test', { name: 'X' })).rejects.toThrow(/Write to them first/);

    await startConversation(eva, 'eva@gmail.test', 'martin@gmail.test', 'Hi from Eva');
    const got = await waitFor(() => martin.mail.items.find((i) => i.from === 'eva@gmail.test'), 'martin to receive from eva');
    expect(got.external?.keyChanged).toBeFalsy();
    const contact = (await martin.svc.status()).contacts.find((c) => c.address === 'eva@gmail.test');
    expect(contact?.keyChanged).toBeFalsy();
    expect(contact?.keyFp).toBeTruthy();
    eva.svc.stop();
  }, 30_000);

  it('seals files into the mail and keeps them on the other side', async () => {
    const bytes = Buffer.from('%PDF-1.4 episode notes');
    const file = await putMailFile(bytes, 'notes.pdf', 'application/pdf');
    const conv = await vlado.mail.createConversation('Notes', [], 'x', {
      external: { address: 'martin@gmail.test', thread: randomUUID().replace(/-/g, ''), self: 'vlado@gmail.test' }
    });
    await vlado.mail.appendMailItem({
      conversationId: conv.id,
      from: 'user',
      to: ['martin@gmail.test'],
      body: 'Notes attached.',
      attachments: [{ kind: 'file', name: 'notes.pdf', mime: 'application/pdf', fileId: file.id, size: bytes.length }],
      external: { status: 'queued' }
    });
    await vlado.svc.send(conv.id, vlado.mail.items.at(-1)!.id);
    const got = await waitFor(() => martin.mail.items.find((i) => i.body === 'Notes attached.'), 'martin to receive the file');
    const att = got.attachments?.[0];
    expect(att).toMatchObject({ kind: 'file', name: 'notes.pdf', mime: 'application/pdf', size: bytes.length });
    expect(att?.fileId).toBeTruthy();
    expect(att?.fileId).not.toBe(file.id);
    expect((await readMailFile(att!.fileId!))?.bytes.equals(bytes)).toBe(true);
  }, 30_000);

  it('auto-drafts only for a contact the user verified in person', async () => {
    const drafts: string[] = [];
    const ida = makeStem('ida', { onAutoDraft: (conversationId) => drafts.push(conversationId) });
    await verify(ida, 'ida@gmail.test');
    await ida.svc.start();
    await startConversation(vlado, 'vlado@gmail.test', 'ida@gmail.test', 'First');
    await waitFor(() => ida.mail.items.find((i) => i.body === 'First'), 'ida to receive');
    await new Promise((r) => setTimeout(r, 100)); // the receive hooks run just after filing
    await expect(ida.svc.setContact('vlado@gmail.test', { autoDraft: true })).rejects.toThrow(/Check their key/);
    await ida.svc.acceptContact('vlado@gmail.test');
    await ida.svc.markVerified('vlado@gmail.test', true);
    await ida.svc.setContact('vlado@gmail.test', { autoDraft: true, name: '  Vlado  ' });
    const c = (await ida.svc.status()).contacts.find((x) => x.address === 'vlado@gmail.test');
    expect(c).toMatchObject({ autoDraft: true, name: 'Vlado' });
    expect(drafts).toHaveLength(0);

    await startConversation(vlado, 'vlado@gmail.test', 'ida@gmail.test', 'Second');
    await waitFor(() => ida.mail.items.find((i) => i.body === 'Second'), 'ida to receive again');
    await waitFor(() => drafts.length === 1 || undefined, 'the automatic draft');
    // Unverifying turns it off.
    await ida.svc.markVerified('vlado@gmail.test', false);
    expect((await ida.svc.status()).contacts.find((x) => x.address === 'vlado@gmail.test')?.autoDraft).toBeUndefined();
    ida.svc.stop();
  }, 30_000);

  it('stops sending when a contact’s key changes until the user acknowledges it', async () => {
    const laptop2 = makeStem('martin2');
    await verify(laptop2, 'martin@gmail.test');
    await laptop2.svc.start();
    const { item } = await startConversation(vlado, 'vlado@gmail.test', 'martin@gmail.test', 'Are you there?');
    expect(vlado.mail.items.find((i) => i.id === item.id)?.external?.status).toBe('key-changed');
    expect((await vlado.svc.status()).contacts.find((c) => c.address === 'martin@gmail.test')?.keyChanged).toBe(true);

    await vlado.svc.acknowledgeKeyChange('martin@gmail.test');
    expect(vlado.mail.items.find((i) => i.id === item.id)?.external?.status).toBe('sent');
    const got = await waitFor(() => laptop2.mail.items.find((i) => i.body === 'Are you there?'), 'the new laptop to receive');
    expect(got.external?.held).toBe(true);
    // The old laptop lost the address and gets nothing new.
    expect(martin.mail.items.some((i) => i.body === 'Are you there?')).toBe(false);
    laptop2.svc.stop();
  }, 30_000);
});
