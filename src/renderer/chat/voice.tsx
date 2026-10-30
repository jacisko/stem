import { useCallback, useEffect, useRef, useState } from 'react';
import { AudioLines, Loader2 } from 'lucide-react';
import { VoiceEvents, type VoiceActivity } from './voiceEvents';

// Voice chat: a WebRTC call to OpenAI's realtime voice model, which answers
// small talk itself and hands every real request to `ask` — an ordinary turn
// in the open chat (server/voice/realtime.ts has the session it starts with).
// The browser does the hard audio parts: echo cancellation keeps the model
// from hearing itself, so the user can talk over it, and the model stops.

/** How often a live call re-checks that the plan still has room. */
export const VOICE_CHECK_INTERVAL_MS = 2 * 60_000;

export type VoicePhase = 'idle' | 'connecting' | 'live';

export interface VoiceCall {
  /** False when this window cannot place a call (no WebRTC or bridge). */
  available: boolean;
  phase: VoicePhase;
  activity: VoiceActivity;
  /** Why the last call ended or failed; cleared by the next start. */
  error: string | null;
  start(): void;
  stop(): void;
  toggle(): void;
}

interface Live {
  pc: RTCPeerConnection;
  mic: MediaStream | null;
  audio: HTMLAudioElement;
  events: VoiceEvents | null;
  timer: ReturnType<typeof setInterval> | null;
}

function micError(e: unknown): string {
  const name = e instanceof DOMException ? e.name : '';
  if (name === 'NotAllowedError') return 'Stem may not use the microphone. Allow it in System Settings → Privacy & Security → Microphone.';
  if (name === 'NotFoundError') return 'No microphone found.';
  return e instanceof Error ? e.message : String(e);
}

const CAN_CALL = typeof window !== 'undefined' && typeof RTCPeerConnection !== 'undefined' && !!window.stem?.voiceConnect;

/** One voice call at a time per window; `ask` is read at call time, so it may change between renders. */
export function useVoiceCall(ask: (request: string) => Promise<string>): VoiceCall {
  const [phase, setPhase] = useState<VoicePhase>('idle');
  const [activity, setActivity] = useState<VoiceActivity>('listening');
  const [error, setError] = useState<string | null>(null);
  const live = useRef<Live | null>(null);
  const askRef = useRef(ask);
  askRef.current = ask;

  const end = useCallback((reason: string | null) => {
    const cur = live.current;
    live.current = null;
    if (cur) {
      cur.events?.close();
      if (cur.timer) clearInterval(cur.timer);
      cur.mic?.getTracks().forEach((t) => t.stop());
      cur.pc.close();
      cur.audio.srcObject = null;
    }
    setPhase('idle');
    setActivity('listening');
    setError(reason);
  }, []);

  const start = useCallback(() => {
    if (live.current || !CAN_CALL) return;
    setError(null);
    setPhase('connecting');
    const pc = new RTCPeerConnection();
    const audio = new Audio();
    audio.autoplay = true;
    const cur: Live = { pc, mic: null, audio, events: null, timer: null };
    live.current = cur;
    const stillMine = (): boolean => live.current === cur;
    pc.ontrack = (e) => {
      audio.srcObject = e.streams[0] ?? new MediaStream([e.track]);
      void audio.play().catch(() => undefined);
    };
    pc.onconnectionstatechange = () => {
      if (stillMine() && (pc.connectionState === 'failed' || pc.connectionState === 'disconnected')) {
        end('The voice connection dropped.');
      }
    };
    void (async () => {
      try {
        const mic = await navigator.mediaDevices
          .getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
          .catch((e: unknown) => {
            throw new Error(micError(e));
          });
        if (!stillMine()) {
          mic.getTracks().forEach((t) => t.stop());
          return;
        }
        cur.mic = mic;
        for (const track of mic.getAudioTracks()) pc.addTrack(track, mic);
        const channel = pc.createDataChannel('oai-events');
        const events = new VoiceEvents({
          send: (event) => {
            if (channel.readyState === 'open') channel.send(JSON.stringify(event));
          },
          ask: (request) => askRef.current(request),
          onActivity: (a) => {
            if (stillMine()) setActivity(a);
          },
          onProblem: (message) => {
            if (stillMine()) setError(message);
          }
        });
        cur.events = events;
        channel.onmessage = (e) => events.handle(String(e.data));
        channel.onopen = () => {
          if (stillMine()) setPhase('live');
        };
        await pc.setLocalDescription(await pc.createOffer());
        const { sdp } = await window.stem.voiceConnect(pc.localDescription?.sdp ?? '');
        if (!stillMine()) return;
        await pc.setRemoteDescription({ type: 'answer', sdp });
        // Past the plan's limit OpenAI bills credits; hang up instead.
        cur.timer = setInterval(() => {
          void window.stem.voiceCheck().then(
            (allowed) => {
              if (stillMine() && !allowed.ok) end(allowed.reason);
            },
            () => undefined
          );
        }, VOICE_CHECK_INTERVAL_MS);
      } catch (e) {
        if (stillMine()) end(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e));
      }
    })();
  }, [end]);

  const stop = useCallback(() => end(null), [end]);
  const toggle = useCallback(() => (live.current ? stop() : start()), [start, stop]);

  useEffect(() => () => end(null), [end]);

  return { available: CAN_CALL, phase, activity, error, start, stop, toggle };
}

const ACTIVITY_LABEL: Record<VoiceActivity, string> = {
  listening: 'Listening',
  hearing: 'Hearing you',
  working: 'Stem is working on it',
  speaking: 'Speaking'
};

/** The composer's voice-chat button: starts a call, shows what it is doing, ends it. */
export function VoiceButton({ voice, disabled }: { voice: VoiceCall; disabled?: boolean }) {
  if (!voice.available) return null;
  const live = voice.phase === 'live';
  const label =
    voice.phase === 'connecting'
      ? 'Connecting voice chat…'
      : live
        ? `${ACTIVITY_LABEL[voice.activity]} — click to end voice chat`
        : voice.error
          ? `Voice chat: ${voice.error}`
          : 'Voice chat';
  return (
    <button
      type="button"
      className={`composer-attach voice${live ? ` live ${voice.activity}` : ''}${voice.error && !live ? ' failed' : ''}`}
      aria-label={live || voice.phase === 'connecting' ? 'End voice chat' : 'Voice chat'}
      aria-pressed={live}
      title={label}
      disabled={disabled && !live}
      onMouseDown={(e) => e.preventDefault()}
      onClick={voice.toggle}
    >
      {voice.phase === 'connecting' ? <Loader2 size={17} className="spin" /> : <AudioLines size={17} />}
    </button>
  );
}
