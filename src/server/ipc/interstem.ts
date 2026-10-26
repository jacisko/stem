import { registerServer } from './guard';
import type { InterStemService } from '../interstem/service';
import type { MailRouter } from '../mail/router';
import { readMail, releaseExternalItems } from '../workspace/mail';
import { isExternalAddress, type TurnAttachment } from '../../shared/types';
import { transportedRawPath } from '../files/staging';
import { normalizeAddress, validAddress } from '../interstem/proto';
import { contactSource, recallStore } from '../recall/store';

/**
 * Inter-Stem mail (docs/inter-stem-mail-design.md): this Stem's addresses and
 * contacts, plus the mail actions only external conversations have — compose
 * to an address, release held mail to agents, ask a persona for a draft.
 */
export function registerInterStemIpc(deps: { service(): InterStemService | null; router(): MailRouter | null }): void {
  const service = (): InterStemService => {
    const s = deps.service();
    if (!s) throw new Error('Mail to other Stems is not running on this server.');
    return s;
  };
  const router = (): MailRouter => {
    const r = deps.router();
    if (!r) throw new Error('Mail is not ready yet — the backend is still starting.');
    return r;
  };
  registerServer('interstem:status', () => service().status());
  registerServer('interstem:addAddress', (_e, address: string) => service().addAddress(address));
  registerServer('interstem:verifyAddress', (_e, address: string, code: string) => service().verifyAddress(address, code));
  registerServer('interstem:checkLink', (_e, address: string) => service().checkLinkVerified(address));
  registerServer('interstem:removeAddress', (_e, address: string) => service().removeAddress(address));
  registerServer('interstem:setUnlisted', (_e, unlisted: boolean) => service().setUnlisted(unlisted));
  registerServer('interstem:contact', (_e, op: 'accept' | 'block' | 'unblock' | 'verify' | 'unverify' | 'ackKey', address: string) => {
    const s = service();
    switch (op) {
      case 'accept':
        return s.acceptContact(address);
      case 'block':
        return s.blockContact(address);
      case 'unblock':
        return s.unblockContact(address);
      case 'verify':
        return s.markVerified(address, true);
      case 'unverify':
        return s.markVerified(address, false);
      case 'ackKey':
        return s.acknowledgeKeyChange(address);
    }
  });
  registerServer('interstem:setContact', (_e, address: string, patch: { name?: string | null; autoDraft?: boolean }) =>
    service().setContact(address, {
      ...(patch.name === null || typeof patch.name === 'string' ? { name: patch.name } : {}),
      ...(typeof patch.autoDraft === 'boolean' ? { autoDraft: patch.autoDraft } : {})
    })
  );
  // What Stem learned from mail with them (interstem/contact-memory.ts): count, and forget it all.
  registerServer('interstem:contactMemory', (_e, address: string) => ({
    facts: recallStore.countFactsBySource(contactSource(normalizeAddress(address)))
  }));
  registerServer('interstem:forgetContact', (_e, address: string) => {
    const n = recallStore.forgetFactsBySource(contactSource(normalizeAddress(address)));
    return { forgotten: n };
  });
  registerServer('interstem:lookup', (_e, address: string) => service().lookup(address));
  registerServer('mail:resendExternal', async (_e, conversationId: string, itemId: string) => {
    await service().resend(conversationId, itemId);
    return readMail();
  });
  registerServer('interstem:invite', async (_e, address: string) => {
    await service().invite(address);
    return { ok: true };
  });
  registerServer('mail:composeExternal', async (e, input: { to: string; subject?: string; body: string; self?: string; attachments?: TurnAttachment[] }) => {
    // SEC-002, as mail:compose: a transported client names upload handles or inline bytes, never server paths.
    const attachments = Array.isArray(input.attachments) ? input.attachments : [];
    if (await transportedRawPath(e, attachments.map((att) => att.path))) {
      throw new Error('Attachments over the transport carry upload handles or inline bytes, never server paths — POST the file to /upload first.');
    }
    const to = normalizeAddress(String(input.to ?? ''));
    if (!validAddress(to) || !isExternalAddress(to)) throw new Error('Write the email address of the person to mail.');
    const self = input.self ? normalizeAddress(input.self) : await service().defaultSelf();
    if (!self) throw new Error('Connect one of your email addresses to Stem first (Settings → Features → Your email address).');
    return router().composeExternal({
      to,
      self,
      subject: typeof input.subject === 'string' ? input.subject : '',
      body: String(input.body ?? ''),
      ...(attachments.length ? { attachments } : {})
    });
  });
  registerServer('mail:release', (_e, conversationId: string, itemId: string) => releaseExternalItems(conversationId, itemId));
  registerServer('mail:draftExternal', async (_e, conversationId: string, personaId: string, instructions?: string, release?: boolean) => {
    const result = await router().draftExternal(conversationId, personaId, instructions ?? '', { release: release === true });
    const address = result.conversations.find((c) => c.id === conversationId)?.external?.address;
    // quiet: the default persona for next time is a convenience; the draft is under way.
    if (address) await deps.service()?.recordDraftPersona(address, personaId).catch(() => undefined);
    return result;
  });
}
