import { describe, expect, it, vi } from 'vitest';
import { waitForTurnReply } from '../../src/renderer/session/turnReply';
import type { BackendEventEnvelope } from '../../src/shared/types';

function bus() {
  const listeners = new Set<(e: BackendEventEnvelope) => void>();
  return {
    subscribe: (l: (e: BackendEventEnvelope) => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    emit: (method: string, params: unknown) => {
      for (const l of [...listeners]) l({ method, params, receivedAt: '' });
    },
    get size() {
      return listeners.size;
    }
  };
}
const msg = (turnId: string, text: string) => ({ threadId: 't', turnId, item: { type: 'agentMessage', id: 'i', text } });
const end = (turnId: string, extra: Record<string, unknown> = {}) => ({ threadId: 't', turn: { id: turnId, status: 'x' }, ...extra });

describe('waitForTurnReply', () => {
  it("settles with the watched turn's last reply text", async () => {
    const b = bus();
    const w = waitForTurnReply(b.subscribe);
    w.watch('turn-1');
    b.emit('item/completed', msg('other', 'not mine'));
    b.emit('item/completed', msg('turn-1', 'Checking.'));
    b.emit('item/completed', msg('turn-1', 'It is sunny.'));
    b.emit('turn/completed', end('other'));
    b.emit('turn/completed', end('turn-1'));
    await expect(w.promise).resolves.toBe('It is sunny.');
    expect(b.size).toBe(0);
  });

  it('keeps events that arrive before the turn is named', async () => {
    const b = bus();
    const w = waitForTurnReply(b.subscribe);
    b.emit('item/completed', msg('fast', 'Done already.'));
    b.emit('turn/completed', end('fast'));
    w.watch('fast');
    await expect(w.promise).resolves.toBe('Done already.');
  });

  it('rejects with the failure text, a stop, or a missing reply', async () => {
    const b = bus();
    const failed = waitForTurnReply(b.subscribe);
    failed.watch('a');
    b.emit('turn/failed', end('a', { error: 'model overloaded' }));
    await expect(failed.promise).rejects.toThrow('model overloaded');
    const aborted = waitForTurnReply(b.subscribe);
    aborted.watch('b');
    b.emit('turn/aborted', end('b'));
    await expect(aborted.promise).rejects.toThrow('stopped');
    const empty = waitForTurnReply(b.subscribe);
    empty.watch('c');
    b.emit('turn/completed', end('c'));
    await expect(empty.promise).rejects.toThrow('without a reply');
  });

  it('times out and unsubscribes', async () => {
    vi.useFakeTimers();
    try {
      const b = bus();
      const w = waitForTurnReply(b.subscribe, 1000);
      w.watch('slow');
      const settled = expect(w.promise).rejects.toThrow('too long');
      vi.advanceTimersByTime(1001);
      await settled;
      expect(b.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('waitForTurnReply worker exits', () => {
  it("fails when the watched chat's worker exits, and ignores other chats", async () => {
    const b = bus();
    const w = waitForTurnReply(b.subscribe);
    w.watch('t1');
    w.watchThread('chat-1');
    b.emit('process/exit', { threadId: 'chat-2' });
    b.emit('process/exit', { threadId: null });
    b.emit('process/exit', { threadId: 'chat-1' });
    await expect(w.promise).rejects.toThrow('worker stopped');
  });
});
