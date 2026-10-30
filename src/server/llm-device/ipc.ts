import { registerServer, type CallerContext } from '../ipc/guard';
import { llmRelay } from './router';
import type { DeviceLlmAck } from '../../shared/types';

// The channel a computer that runs a model server answers on. Device-scoped
// like the other host channels: the caller IS the device, and the relay checks
// the request was addressed to it.
export function registerLlmHostIpc(): void {
  registerServer('llmHost:chunk', (caller: CallerContext, chunk: unknown): DeviceLlmAck => {
    if (!caller) throw new Error('llmHost:chunk needs a paired device — it answers for the CALLER’s machine.');
    return llmRelay().onChunk(caller.deviceId, chunk);
  });
}
