import { registerServer } from './guard';
import type { IpcDeps } from './deps';
import { readSettings } from '../workspace/settings';
import { log } from '../log';
import { openVoiceCall, planAllowance, type PlanAllowance } from '../voice/realtime';

const PROVIDER = 'openai-codex';
// A WebRTC offer is a few KB; anything far bigger is not one.
const MAX_OFFER_CHARS = 64_000;

/**
 * Voice chat (server/voice/realtime.ts). `voice:connect` answers the client's
 * WebRTC offer after the same gate `voice:check` runs alone during a call:
 * the Features switch, a ChatGPT sign-in, and room left in the plan.
 */
export function registerVoiceIpc(deps: Pick<IpcDeps, 'providerAuth'>): void {
  const gate = async (): Promise<{ ok: true; token: string } | { ok: false; reason: string }> => {
    const settings = await readSettings();
    if (settings.chatFeatures.voice?.allow === false) {
      return { ok: false, reason: 'Voice chat is switched off in Settings → Features.' };
    }
    const token = await deps
      .providerAuth()
      ?.accessToken(PROVIDER)
      // quiet: a refresh that fails is a signed-out answer, and the refusal below says so.
      .catch(() => undefined);
    if (!token) return { ok: false, reason: 'Voice chat needs a ChatGPT sign-in (Settings → Models).' };
    const allowance = await planAllowance(token);
    return allowance.ok ? { ok: true, token } : allowance;
  };

  registerServer('voice:check', async (): Promise<PlanAllowance> => {
    const g = await gate();
    return g.ok ? { ok: true } : g;
  });

  registerServer('voice:connect', async (_e, offerSdp: string): Promise<{ sdp: string }> => {
    if (!offerSdp.startsWith('v=') || offerSdp.length > MAX_OFFER_CHARS) throw new Error('Not a WebRTC offer.');
    const started = Date.now();
    const g = await gate();
    if (!g.ok) {
      log('voice', 'refused a call', { reason: g.reason });
      throw new Error(g.reason);
    }
    const sdp = await openVoiceCall(g.token, offerSdp);
    log('voice', 'started a call', { ms: Date.now() - started });
    return { sdp };
  });
}
