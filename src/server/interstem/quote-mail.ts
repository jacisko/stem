// Quoting another person's mail into a prompt. Each mail sits inside a fence
// named with a fresh random token, so text from outside can't close it or
// forge a mail "from the user" (the draft brief, router draftExternal, does
// the same); tag- and header-like runs in the bodies are defused as well.
import { randomBytes } from 'node:crypto';

export function mailFence(): string {
  return `outside-mail-${randomBytes(6).toString('hex')}`;
}

export function defuseMailText(text: string): string {
  return text.replace(/<(\s*\/?\s*(?:outside-mail|mail)\b)/gi, '‹$1').replace(/\[(\s*mail from\b)/gi, '‹$1');
}

/**
 * `who` is a fixed role, never an address: an address is the sender's own
 * text, and in an attribute it could close the quote and add one.
 */
export function quoteMail(fence: string, who: 'the user' | 'them', at: number, body: string, extra = ''): string {
  return `<${fence} from="${who}" date="${new Date(at).toISOString().slice(0, 10)}"${extra}>\n${defuseMailText(body)}\n</${fence}>`;
}
