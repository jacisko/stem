import { describe, expect, it } from 'vitest';
import { MAX_SPOKEN_REPLY_CHARS, VoiceEvents, type VoiceActivity } from '../../src/renderer/chat/voiceEvents';

function harness(ask: (request: string) => Promise<string>) {
  const sent: Record<string, unknown>[] = [];
  const activity: VoiceActivity[] = [];
  const problems: string[] = [];
  const events = new VoiceEvents({
    send: (e) => sent.push(e),
    ask,
    onActivity: (a) => activity.push(a),
    onProblem: (m) => problems.push(m)
  });
  const emit = (e: Record<string, unknown>) => events.handle(JSON.stringify(e));
  return { events, sent, activity, problems, emit };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function call(id: string, request: string) {
  return { type: 'response.function_call_arguments.done', name: 'ask_stem', call_id: id, arguments: JSON.stringify({ request }) };
}

describe('voice events', () => {
  it('runs ask_stem as a request and hands the reply back', async () => {
    const asked: string[] = [];
    const h = harness(async (r) => {
      asked.push(r);
      return 'Bratislava.';
    });
    h.emit(call('c1', 'What is the capital of Slovakia?'));
    expect(h.activity.at(-1)).toBe('working');
    await flush();
    expect(asked).toEqual(['What is the capital of Slovakia?']);
    expect(h.sent).toEqual([
      { type: 'conversation.item.create', item: { type: 'function_call_output', call_id: 'c1', output: JSON.stringify({ reply: 'Bratislava.' }) } },
      { type: 'response.create' }
    ]);
    expect(h.activity.at(-1)).toBe('listening');
  });

  it('holds response.create until the model finishes its current response', async () => {
    const h = harness(async () => 'ok');
    h.emit({ type: 'response.created' });
    h.emit(call('c1', 'x'));
    await flush();
    expect(h.sent.map((e) => e.type)).toEqual(['conversation.item.create']);
    h.emit({ type: 'response.done' });
    expect(h.sent.map((e) => e.type)).toEqual(['conversation.item.create', 'response.create']);
  });

  it('answers requests in order, one at a time', async () => {
    const order: string[] = [];
    let release!: () => void;
    const first = new Promise<void>((r) => (release = r));
    const h = harness(async (r) => {
      order.push(`start ${r}`);
      if (r === 'one') await first;
      order.push(`end ${r}`);
      return r;
    });
    h.emit(call('c1', 'one'));
    h.emit(call('c2', 'two'));
    await flush();
    expect(order).toEqual(['start one']);
    release();
    await flush();
    await flush();
    expect(order).toEqual(['start one', 'end one', 'start two', 'end two']);
  });

  it('turns a failed request into an error output and a problem', async () => {
    const h = harness(async () => {
      throw new Error('Stem is busy');
    });
    h.emit(call('c1', 'x'));
    await flush();
    expect((h.sent[0] as { item: { output: string } }).item.output).toBe(JSON.stringify({ error: 'Stem is busy' }));
    expect(h.problems).toEqual(['Stem is busy']);
  });

  it('caps a long reply for speaking', async () => {
    const h = harness(async () => 'a'.repeat(MAX_SPOKEN_REPLY_CHARS + 50));
    h.emit(call('c1', 'x'));
    await flush();
    const output = JSON.parse((h.sent[0] as { item: { output: string } }).item.output) as { reply: string };
    expect(output.reply.length).toBeLessThan(MAX_SPOKEN_REPLY_CHARS + 50);
    expect(output.reply).toContain('in the chat');
  });

  it('sends nothing once the call is closed', async () => {
    const h = harness(async () => 'late');
    h.emit(call('c1', 'x'));
    h.events.close();
    await flush();
    expect(h.sent).toEqual([]);
  });

  it('tracks who is talking', () => {
    const h = harness(async () => '');
    h.emit({ type: 'input_audio_buffer.speech_started' });
    expect(h.activity.at(-1)).toBe('hearing');
    h.emit({ type: 'input_audio_buffer.speech_stopped' });
    h.emit({ type: 'output_audio_buffer.started' });
    expect(h.activity.at(-1)).toBe('speaking');
    h.emit({ type: 'output_audio_buffer.stopped' });
    expect(h.activity.at(-1)).toBe('listening');
  });

  it('ignores the expected active-response race but reports other errors', () => {
    const h = harness(async () => '');
    h.emit({ type: 'error', error: { code: 'conversation_already_has_active_response', message: 'busy' } });
    h.emit({ type: 'error', error: { message: 'bad thing' } });
    expect(h.problems).toEqual(['bad thing']);
  });
});
