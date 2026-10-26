import { describe, expect, it, vi } from 'vitest';
import {
  PLAN_USAGE_URL,
  REALTIME_CALLS_URL,
  accountIdFromToken,
  openVoiceCall,
  planAllowance,
  voiceSession
} from '../../src/server/voice/realtime';

function jwt(claims: Record<string, unknown>): string {
  return `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;
}
const TOKEN = jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-1' } });

function respond(status: number, body: unknown) {
  return vi.fn(async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }));
}

describe('voice realtime', () => {
  it('reads the account id from the token and sends it', async () => {
    expect(accountIdFromToken(TOKEN)).toBe('acct-1');
    expect(accountIdFromToken('garbage')).toBeNull();
    const fetchImpl = respond(200, { rate_limit: { allowed: true, limit_reached: false } });
    await planAllowance(TOKEN, fetchImpl);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(PLAN_USAGE_URL);
    expect(init.headers).toMatchObject({ Authorization: `Bearer ${TOKEN}`, 'chatgpt-account-id': 'acct-1' });
  });

  it('allows a call only while the plan window has room', async () => {
    expect(await planAllowance(TOKEN, respond(200, { rate_limit: { allowed: true, limit_reached: false } }))).toEqual({ ok: true });
    const reached = await planAllowance(TOKEN, respond(200, { rate_limit: { allowed: true, limit_reached: true } }));
    expect(reached.ok).toBe(false);
    expect((await planAllowance(TOKEN, respond(200, { rate_limit: { allowed: false } }))).ok).toBe(false);
  });

  it('refuses when the usage cannot be read, rather than risk paid credits', async () => {
    expect((await planAllowance(TOKEN, respond(500, 'boom'))).ok).toBe(false);
    expect((await planAllowance(TOKEN, respond(200, { credits: {} }))).ok).toBe(false);
    const offline = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    const r = await planAllowance(TOKEN, offline);
    expect(r).toMatchObject({ ok: false });
    expect(!r.ok && r.reason).toContain('fetch failed');
  });

  it('posts the offer with the session and returns the SDP answer', async () => {
    const fetchImpl = respond(201, 'v=0\r\nanswer');
    expect(await openVoiceCall(TOKEN, 'v=0\r\noffer', fetchImpl)).toBe('v=0\r\nanswer');
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(REALTIME_CALLS_URL);
    const form = init.body as FormData;
    expect(form.get('sdp')).toBe('v=0\r\noffer');
    expect(JSON.parse(String(form.get('session')))).toEqual(voiceSession());
  });

  it("surfaces OpenAI's refusal message", async () => {
    await expect(openVoiceCall(TOKEN, 'v=0', respond(403, { error: { message: 'no realtime for you' } }))).rejects.toThrow(
      'no realtime for you'
    );
  });

  it('starts the session with the ask_stem tool and Stem-first instructions', () => {
    const session = voiceSession() as { tools: { name: string }[]; instructions: string };
    expect(session.tools.map((t) => t.name)).toEqual(['ask_stem']);
    expect(session.instructions).toContain('ask_stem');
  });
});
