// The realtime voice model's side of a voice call, without the WebRTC: what
// to do with each event on the `oai-events` data channel. Kept apart from the
// peer connection (chat/voice.tsx) so it runs in unit tests.

import { ASK_STEM_TOOL } from '../../shared/voice';

/** What the voice model is handed back at most; the rest is for reading in the chat. */
export const MAX_SPOKEN_REPLY_CHARS = 6000;

/** What the call is doing now, for the button and its tooltip. */
export type VoiceActivity = 'listening' | 'hearing' | 'working' | 'speaking';

export interface VoiceEventsDeps {
  /** Send a client event on the data channel. */
  send(event: Record<string, unknown>): void;
  /** Run the request as a Stem turn; settles with its reply text. */
  ask(request: string): Promise<string>;
  onActivity(activity: VoiceActivity): void;
  /** A non-fatal problem worth showing (an error event, a failed request). */
  onProblem(message: string): void;
}

interface RealtimeEvent {
  type?: string;
  name?: string;
  call_id?: string;
  arguments?: string;
  error?: { message?: string; code?: string };
}

export class VoiceEvents {
  private responseActive = false;
  /** A response.create held back until the model's current response ends. */
  private responseWanted = false;
  private speaking = false;
  private hearing = false;
  private working = 0;
  /** Stem runs one turn at a time per chat, so requests queue in order. */
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;

  constructor(private readonly deps: VoiceEventsDeps) {}

  close(): void {
    this.closed = true;
  }

  handle(raw: string): void {
    let event: RealtimeEvent;
    try {
      event = JSON.parse(raw) as RealtimeEvent;
    } catch {
      // quiet: the channel only ever carries JSON; a broken frame has nothing to act on.
      return;
    }
    switch (event.type) {
      case 'input_audio_buffer.speech_started':
        this.hearing = true;
        break;
      case 'input_audio_buffer.speech_stopped':
        this.hearing = false;
        break;
      case 'output_audio_buffer.started':
        this.speaking = true;
        break;
      case 'output_audio_buffer.stopped':
      case 'output_audio_buffer.cleared':
        this.speaking = false;
        break;
      case 'response.created':
        this.responseActive = true;
        break;
      case 'response.done':
        this.responseActive = false;
        if (this.responseWanted) this.requestResponse();
        break;
      case 'response.function_call_arguments.done':
        if (event.name === ASK_STEM_TOOL && event.call_id) this.runAsk(event.call_id, event.arguments ?? '');
        break;
      case 'error':
        // A response.create racing the model's own response is expected and retried at response.done.
        if (event.error?.code !== 'conversation_already_has_active_response') {
          this.deps.onProblem(event.error?.message ?? 'The voice model reported an error.');
        }
        break;
      default:
        return;
    }
    this.report();
  }

  private report(): void {
    this.deps.onActivity(
      this.hearing ? 'hearing' : this.speaking ? 'speaking' : this.working > 0 ? 'working' : 'listening'
    );
  }

  private requestResponse(): void {
    if (this.responseActive) {
      this.responseWanted = true;
      return;
    }
    this.responseWanted = false;
    this.responseActive = true;
    this.deps.send({ type: 'response.create' });
  }

  private runAsk(callId: string, args: string): void {
    let request = '';
    try {
      const parsed = JSON.parse(args) as { request?: unknown };
      if (typeof parsed.request === 'string') request = parsed.request.trim();
    } catch {
      // quiet: unparsable arguments read as an empty request, answered below.
    }
    this.working += 1;
    this.report();
    const run = async (): Promise<Record<string, string>> => {
      if (!request) return { error: 'The request was empty.' };
      try {
        const reply = await this.deps.ask(request);
        return {
          reply:
            reply.length > MAX_SPOKEN_REPLY_CHARS
              ? `${reply.slice(0, MAX_SPOKEN_REPLY_CHARS)}… (the full reply is in the chat)`
              : reply
        };
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        this.deps.onProblem(message);
        return { error: message };
      }
    };
    this.queue = this.queue.then(run).then((output) => {
      this.working -= 1;
      if (this.closed) return;
      this.deps.send({
        type: 'conversation.item.create',
        item: { type: 'function_call_output', call_id: callId, output: JSON.stringify(output) }
      });
      this.requestResponse();
      this.report();
    });
  }
}
