import { eventTurnId, isSettledMethod } from '../../shared/settledTurns';
import type { BackendEventEnvelope, ItemEventParams, TurnCompletedParams } from '../../shared/types';

/** Ten minutes: a long tool turn, but not a call left waiting forever. */
export const TURN_REPLY_TIMEOUT_MS = 10 * 60_000;

export interface TurnReplyWaiter {
  /** Settles with the turn's final reply text, or rejects with why it has none. */
  promise: Promise<string>;
  /** Name the turn to wait for. Events seen before it was named still count. */
  watch(turnId: string): void;
  /** Name its chat too, once known: a worker that exits there ends the wait. */
  watchThread(threadId: string): void;
  /** Resolve without a turn: the backend answered the input itself. */
  answer(text: string): void;
  fail(error: Error): void;
}

/**
 * Wait for one turn's final reply off the backend event stream — the voice
 * call's `ask_stem` hands its question to an ordinary turn and speaks what this
 * settles with. Subscribe BEFORE the turn starts: a fast turn can finish before
 * its start call returns, so events are kept per turn until the id is known.
 */
export function waitForTurnReply(
  subscribe: (listener: (event: BackendEventEnvelope) => void) => () => void,
  timeoutMs = TURN_REPLY_TIMEOUT_MS
): TurnReplyWaiter {
  const texts = new Map<string, string>();
  const settled = new Map<string, { method: string; error?: string }>();
  let watched: string | null = null;
  let watchedThread: string | null = null;
  let resolve!: (text: string) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<string>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  let done = false;
  const finish = (fn: () => void): void => {
    if (done) return;
    done = true;
    unsubscribe();
    clearTimeout(timer);
    fn();
  };
  const settle = (turnId: string): void => {
    const end = settled.get(turnId);
    if (!end) return;
    if (end.method === 'turn/completed') {
      const text = texts.get(turnId)?.trim();
      finish(() => (text ? resolve(text) : reject(new Error('Stem finished without a reply.'))));
    } else if (end.method === 'turn/aborted') {
      finish(() => reject(new Error('The reply was stopped.')));
    } else {
      finish(() => reject(new Error(end.error || 'Stem could not answer.')));
    }
  };
  const unsubscribe = subscribe((event) => {
    if (event.method === 'process/exit') {
      const threadId = (event.params as { threadId?: unknown } | null)?.threadId;
      if (watchedThread && threadId === watchedThread) finish(() => reject(new Error("Stem's worker stopped before it answered.")));
      return;
    }
    const turnId = eventTurnId(event.params);
    if (!turnId) return;
    if (event.method === 'item/completed') {
      const item = (event.params as ItemEventParams).item;
      // The last completed agent message is the reply; earlier ones are
      // commentary between tool calls.
      if (item?.type === 'agentMessage' && typeof item.text === 'string') texts.set(turnId, item.text);
    } else if (isSettledMethod(event.method)) {
      settled.set(turnId, { method: event.method, error: (event.params as TurnCompletedParams).error });
      if (turnId === watched) settle(turnId);
    }
  });
  const timer = setTimeout(() => finish(() => reject(new Error('Stem took too long to answer.'))), timeoutMs);
  return {
    promise,
    watch(turnId) {
      watched = turnId;
      settle(turnId);
    },
    watchThread(threadId) {
      watchedThread = threadId;
    },
    answer(text) {
      finish(() => resolve(text));
    },
    fail(error) {
      finish(() => reject(error));
    }
  };
}
