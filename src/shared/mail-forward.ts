import type { MailComposeInput, MessageAttachment, TurnAttachment } from './types';

// Forwarding a mail: the original lands in a NEW conversation, quoted under the
// user's note, through the ordinary compose path — so it needs no server
// support, and a client talking to an older server forwards just the same.
//
// What can travel with it is what the store kept. An image attachment is kept
// whole as a data URL (server/pi/attachments attachmentPreviews, up to 2 MB),
// so it goes back out as inline bytes and the persona sees the picture itself.
// A file attachment is kept as a name only — its bytes rode the delivery turn
// and were never persisted — so all a forward can carry is that name, said
// plainly in the quote rather than silently dropped.

const FORWARD_PREFIX = 'Fwd: ';

/** The quote block's opening line, email-style. */
export const FORWARD_MARKER = '---------- Forwarded message ----------';

/** "Fwd: <subject>", without stacking a second prefix on a forward of a forward. */
export function forwardSubject(subject: string): string {
  const base = subject.trim();
  return /^fwd:/i.test(base) ? base : `${FORWARD_PREFIX}${base}`;
}

/** What the quote says about the mail being forwarded. Names, not ids: the reader is a persona. */
export interface ForwardSource {
  from: string;
  to: string[];
  /** ms. */
  at: number;
  subject: string;
  body: string;
  attachments?: MessageAttachment[];
}

/** The attachments a forward can carry, and the names of those it cannot. */
export interface ForwardAttachments {
  attachments: TurnAttachment[];
  /** Names of attachments whose bytes the store never kept. */
  omitted: string[];
}

/** `data:<mime>;base64,<bytes>` → its parts, or null for anything else. */
function parseDataUrl(dataUrl: string): { mime: string; dataBase64: string } | null {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(dataUrl);
  return match && match[2] ? { mime: match[1], dataBase64: match[2] } : null;
}

const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp'
};

/**
 * The stored attachments as sendable ones: images re-sent from their kept
 * bytes (no upload — the data URL already is the file), everything else named
 * in `omitted`.
 */
export function forwardAttachments(attachments: MessageAttachment[] | undefined): ForwardAttachments {
  const out: ForwardAttachments = { attachments: [], omitted: [] };
  (attachments ?? []).forEach((att, i) => {
    const parsed = att.kind === 'image' && att.dataUrl ? parseDataUrl(att.dataUrl) : null;
    if (!parsed) {
      out.omitted.push(att.name || `attachment ${i + 1}`);
      return;
    }
    const name = att.name || `image-${i + 1}.${EXT_BY_MIME[parsed.mime] ?? 'png'}`;
    out.attachments.push({ name, mime: parsed.mime, dataBase64: parsed.dataBase64 });
  });
  return out;
}

/**
 * The forwarded mail as quoted text: who, when, what about, then the body
 * verbatim. `formatDate` is the caller's (a renderer formats for its locale).
 */
export function forwardQuote(
  source: ForwardSource,
  formatDate: (at: number) => string = (at) => new Date(at).toLocaleString()
): string {
  const { omitted } = forwardAttachments(source.attachments);
  const carried = (source.attachments ?? []).length - omitted.length;
  const lines = [
    FORWARD_MARKER,
    `From: ${source.from}`,
    `Date: ${formatDate(source.at)}`,
    `Subject: ${source.subject}`,
    `To: ${source.to.join(', ')}`,
    '',
    source.body.trim()
  ];
  if (carried > 0) lines.push('', `(${carried === 1 ? 'Its image is' : `Its ${carried} images are`} attached to this mail.)`);
  if (omitted.length) {
    lines.push('', `(Also attached to the original, not forwardable — only the name was kept: ${omitted.join(', ')}.)`);
  }
  return lines.join('\n');
}

/** The note the user wrote, then the quote. A forward with no note is the quote alone. */
export function forwardBody(note: string, quote: string): string {
  const text = note.trim();
  return text ? `${text}\n\n${quote}` : quote;
}

/**
 * Everything a forward sends, as a plain compose: a new conversation to `to`,
 * the "Fwd:" subject (which, being typed rather than derived, the subject
 * writer never replaces), the note over the quote, and the carried images
 * after whatever the user attached in the composer.
 */
export function forwardCompose(input: {
  to: string[];
  subject: string;
  note: string;
  quote: string;
  attachments?: TurnAttachment[];
  private?: boolean;
  /** The forwarded item: the server carries another person's mark from it. */
  forwardOf?: string;
}): MailComposeInput {
  return {
    to: input.to,
    subject: input.subject,
    body: forwardBody(input.note, input.quote),
    ...(input.private ? { private: true } : {}),
    ...(input.forwardOf ? { forwardOf: input.forwardOf } : {}),
    ...(input.attachments?.length ? { attachments: input.attachments } : {})
  };
}
