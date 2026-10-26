// Public share links (docs/public-share-design.md): build a snapshot of a chat
// or mail conversation (or one answer of it), encrypt it here, upload the blob to the global relay under
// the user's verified address, and keep the link so it can be copied again
// or revoked.
import type { ChatBackend } from '../backend';
import { CLOSED_DOMAIN_SHARE, ShareUnavailableError, type InterStemService } from '../interstem/service';
import { deleteShare, postShare, RelayError, type Identity } from '../interstem/relay-client';
import { degrade } from '../degrade';
import { readMailConversation } from '../workspace/mail';
import { listPersonas } from '../workspace/personas';
import type { Persona } from '../../shared/types';
import {
  SHARE_CARD_DESC_MAX,
  SHARE_CARD_TITLE_MAX,
  SHARE_MAX_LINKS,
  SHARE_MAX_TTL_DAYS,
  type ShareOptions,
  type SharePreview,
  type ShareCard,
  type SharedLink,
  type ShareSource,
  type ShareStatus
} from '../../shared/share';
import { buildSnapshot, chatMessages, mailMessages, ShareInputError, type SnapshotSource } from './snapshot';
import { keyFragment, sealShare } from './seal';
import { ShareStore } from './store';

/** The relay's default blob cap; a bigger snapshot fails before upload. */
export const MAX_SHARE_BYTES = 12 << 20;

export interface ShareDeps {
  runtime(): ChatBackend;
  interStem(): InterStemService | null;
  store?: ShareStore;
  /** Tests swap the relay calls. */
  upload?: typeof postShare;
  remove?: typeof deleteShare;
  /** Tests swap the mail store and the persona list. */
  readMail?: typeof readMailConversation;
  personas?: () => Promise<Persona[]>;
  now?: () => number;
}

/** One line each, within the relay's limits; nothing left = no card. */
function cleanCard(card: ShareOptions['card']): ShareCard | null {
  if (!card) return null;
  const line = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
  const out = { title: line(card.title, SHARE_CARD_TITLE_MAX), description: line(card.description, SHARE_CARD_DESC_MAX) };
  return out.title || out.description ? out : null;
}

/** A persona id as the user knows it (renderer/mail/useMail.ts personaName). */
function personaName(personas: Persona[], id: string): string {
  if (id.startsWith('task:')) return 'Scheduled task';
  const at = id.lastIndexOf('~');
  if (at > 0) {
    const role = personas.find((p) => p.id === id.slice(0, at))?.name;
    return role ? `${id.slice(at + 1)} (${role})` : id.slice(at + 1);
  }
  return personas.find((p) => p.id === id)?.name ?? 'Stem';
}

function relayMessage(err: unknown): Error {
  if (!(err instanceof RelayError)) return err instanceof Error ? err : new Error(String(err));
  switch (err.code) {
    case 'too_large':
      return new Error('This is too big to share. Leave out the pictures, or share one answer instead of the whole chat.');
    case 'rate_limited':
      return new Error('You have shared a lot today. Try again tomorrow.');
    case 'quota_full':
      return new Error('Your shared links are using all their space. Revoke some old ones in Settings and try again.');
    case 'too_many_links':
      return new Error(
        `You already have ${SHARE_MAX_LINKS} working links. Revoke some in Settings → Features → Shared links, or wait for old ones to expire.`
      );
    case 'bad_ttl':
      return new Error(`A link can last at most ${SHARE_MAX_TTL_DAYS} days.`);
    case 'suspended':
      return new Error('Sharing is suspended for your address. Write to the Stem team if you think this is a mistake.');
    case 'closed_relay':
      return new Error(CLOSED_DOMAIN_SHARE);
    case 'share_disabled':
      return new Error('The share service is not available right now.');
    default:
      return new Error(`The share service refused the upload (${err.code}).`);
  }
}

export class ShareService {
  private readonly store: ShareStore;
  private readonly upload: typeof postShare;
  private readonly remove: typeof deleteShare;
  private readonly readMail: typeof readMailConversation;
  private readonly personas: () => Promise<Persona[]>;
  private readonly now: () => number;

  constructor(private readonly deps: ShareDeps) {
    this.store = deps.store ?? new ShareStore();
    this.upload = deps.upload ?? postShare;
    this.remove = deps.remove ?? deleteShare;
    this.readMail = deps.readMail ?? readMailConversation;
    this.personas = deps.personas ?? listPersonas;
    this.now = deps.now ?? Date.now;
  }

  private async identity(): Promise<{ relay: string; address: string; identity: Identity }> {
    const s = this.deps.interStem();
    if (!s) throw new ShareUnavailableError('no_address', 'Mail with other Stems is not running on this server.');
    return s.shareIdentity();
  }

  async status(): Promise<ShareStatus> {
    const s = this.deps.interStem();
    if (!s) return { available: false, code: 'not_running', message: 'Mail with other Stems is not running on this server.' };
    try {
      const st = await s.status();
      if (st.policy) {
        return { available: false, code: 'policy', message: 'Your organization has turned off sharing outside the company.' };
      }
      const address = await s.defaultSelf();
      if (!address) {
        return {
          available: false,
          code: 'no_address',
          message: 'Sharing needs a verified email address, so every public link traces back to a real person.'
        };
      }
      if (await s.closedDomain(address)) return { available: false, code: 'policy', message: CLOSED_DOMAIN_SHARE };
      return { available: true, address };
    } catch (err) {
      degrade('share', 'could not read the share status', err);
      return { available: false, code: 'not_running', message: 'Could not check your address. Try again in a moment.' };
    }
  }

  private async source(source: ShareSource): Promise<SnapshotSource> {
    const rt = this.deps.runtime();
    if (source.kind === 'chat') {
      const h = await rt.readThread(source.threadId);
      return {
        title: h.title,
        messages: chatMessages(h.messages),
        image: (id, threadId) => rt.findThreadImage(threadId ?? source.threadId, id)
      };
    }
    const { conversation, items } = await this.readMail(source.conversationId);
    if (!conversation) throw new ShareInputError('That mail conversation is gone.');
    // Another person's mail is theirs to publish, not ours; the memory check is the user's memory.
    if (conversation.external || conversation.outside) throw new ShareInputError('Mail with another person can’t be shared publicly.');
    if (conversation.owner) throw new ShareInputError('This conversation can’t be shared.');
    const personas = await this.personas();
    return {
      title: conversation.subject,
      messages: mailMessages(items, (id) => personaName(personas, id)),
      image: (id, threadId) => (threadId ? rt.findThreadImage(threadId, id) : Promise.resolve(null))
    };
  }

  async preview(source: ShareSource, opts: ShareOptions = {}): Promise<SharePreview> {
    return buildSnapshot(await this.source(source), opts, this.now());
  }

  async create(source: ShareSource, opts: ShareOptions = {}): Promise<SharedLink> {
    const ttlDays = Math.min(SHARE_MAX_TTL_DAYS, Math.max(1, Math.floor(opts.ttlDays ?? SHARE_MAX_TTL_DAYS)));
    const { snapshot } = await this.preview(source, opts);
    const { blob, key } = sealShare(JSON.stringify(snapshot));
    if (blob.length > MAX_SHARE_BYTES) throw relayMessage(new RelayError(413, 'too_large'));
    const { relay, identity } = await this.identity();
    let made;
    try {
      made = await this.upload(relay, identity, blob, ttlDays, cleanCard(opts.card));
    } catch (err) {
      throw relayMessage(err);
    }
    const link: SharedLink = {
      id: made.id,
      url: `${made.url}#${keyFragment(key)}`,
      source,
      scope: opts.scope ?? 'thread',
      kind: snapshot.kind,
      title: snapshot.title,
      createdAt: this.now(),
      expiresAt: made.expires || this.now() + ttlDays * 86_400_000,
      size: blob.length
    };
    await this.store.add(link);
    return link;
  }

  list(): Promise<SharedLink[]> {
    return this.store.list(this.now());
  }

  /** Take the link down on the relay, then forget it here. */
  async revoke(id: string): Promise<SharedLink[]> {
    const { relay, identity } = await this.identity();
    try {
      await this.remove(relay, identity, id);
    } catch (err) {
      if (!(err instanceof RelayError && err.status === 404)) throw relayMessage(err);
    }
    await this.store.remove(id);
    return this.list();
  }
}
