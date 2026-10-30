import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { log } from '../log';
import { readDevices } from '../transport/auth';
import { connectedDeviceIds, pushToDevice } from '../startup/transport';
import {
  LLM_CANCEL_FRAME,
  LLM_REQUEST_FRAME,
  type DeviceLlmAck,
  type DeviceLlmChunk,
  type DeviceLlmRequest
} from '../../shared/types';

// A model server (LM Studio, Ollama, a custom endpoint) that runs on a paired
// computer instead of beside stem-server.
//
// pi only speaks HTTP to a base URL, and it reads that URL from models.json, so
// the server gives it one: a listener on loopback, a path per provider, and
// behind it the same rails the exec and harness paths ride. A request goes out
// to the device as an addressed control frame; the device makes it against its
// own localhost and streams the answer back as ordered `llmHost:chunk` RPCs,
// which are written into the held response as they land. pi never learns the
// server is somewhere else, which is the point: tool calls, streaming,
// reasoning, every flavor pi already handles works unchanged.
//
// The listener is loopback-only and every path starts with a per-process
// random token, so another process on this machine cannot use a paired Mac as
// its proxy without first reading models.json — which is the same file that
// already holds the providers' keys.

/** First sign of life after the frame goes out: the device's head or heartbeat. */
const FIRST_LIFE_TIMEOUT_MS = 30_000;
/** Rolling idle bound; the device heartbeats every 10s while a model loads. */
const IDLE_TIMEOUT_MS = 60_000;
/** pi's requests carry the whole conversation, pictures included. */
const MAX_REQUEST_BYTES = 24 * 1024 * 1024;

/** The headers pi's clients set that the model server needs. Everything else stays here. */
const FORWARDED_REQUEST_HEADERS = ['authorization', 'x-api-key', 'anthropic-version', 'anthropic-beta', 'content-type', 'accept'];
/** And the ones that describe the answer. Lengths and encodings are this hop's own business. */
const FORWARDED_RESPONSE_HEADERS = ['content-type', 'cache-control', 'x-request-id'];

interface Route {
  deviceId: string;
  /** Normalized server root as the DEVICE sees it, no trailing slash, no /v1. */
  baseUrl: string;
}

interface Pending {
  deviceId: string;
  res: ServerResponse;
  nextSeq: number;
  /** Batches that arrived ahead of their turn (each POST is its own connection). */
  early: Map<number, DeviceLlmChunk>;
  timer: NodeJS.Timeout;
}

export interface LlmRelayDeps {
  pushTo(deviceId: string, name: string, data: unknown): number;
  connectedDevices(): Set<string>;
  deviceLabel(deviceId: string): Promise<string | null>;
}

export interface LlmRelay {
  /** The base URL pi is given for `routeId` (no /v1). Starts the listener on first use. */
  baseFor(routeId: string): Promise<string>;
  setRoute(routeId: string, route: Route): void;
  clearRoute(routeId: string): void;
  /** Why a request to that device cannot go out right now, or null when it can. */
  unavailable(deviceId: string): Promise<string | null>;
  /** `llmHost:chunk` — one batch of a response, from the device that owns it. */
  onChunk(deviceId: string, chunk: unknown): DeviceLlmAck;
  close(): void;
}

function sendError(res: ServerResponse, status: number, message: string): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  // The OpenAI error shape: it is what pi's clients surface as the turn's error text.
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { message, type: 'stem_relay_error' } }));
}

function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_REQUEST_BYTES) {
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function createLlmRelay(deps: LlmRelayDeps): LlmRelay {
  const token = randomBytes(16).toString('hex');
  const routes = new Map<string, Route>();
  const pending = new Map<string, Pending>();
  let listening: Promise<number> | null = null;
  let server: Server | null = null;

  function finish(requestId: string, held: Pending): void {
    pending.delete(requestId);
    clearTimeout(held.timer);
  }

  function arm(requestId: string, held: Pending, ms: number): void {
    clearTimeout(held.timer);
    held.timer = setTimeout(() => {
      if (pending.get(requestId) !== held) return;
      finish(requestId, held);
      log('llm-device', 'a relayed model request went silent', { deviceId: held.deviceId });
      deps.pushTo(held.deviceId, LLM_CANCEL_FRAME, { requestId });
      sendError(held.res, 504, 'The computer running this model server stopped answering.');
    }, ms);
  }

  async function unavailable(deviceId: string): Promise<string | null> {
    if (deps.connectedDevices().has(deviceId)) return null;
    const label = await deps.deviceLabel(deviceId);
    if (!label) return 'This model server is set to run on a computer that is no longer paired with Stem.';
    return `This model server runs on ${label}, and that computer is not connected to Stem right now.`;
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // /<token>/<routeId>/<rest>
    const url = new URL(req.url ?? '/', 'http://relay');
    const [, gotToken, routeId, ...rest] = url.pathname.split('/');
    const route = gotToken === token ? routes.get(decodeURIComponent(routeId ?? '')) : undefined;
    if (!route) return sendError(res, 404, 'Unknown model route.');
    const path = `/${rest.join('/')}`;
    const method = req.method === 'GET' || req.method === 'POST' || req.method === 'OPTIONS' ? req.method : null;
    if (!method) return sendError(res, 405, 'Method not allowed.');
    const refusal = await unavailable(route.deviceId);
    if (refusal) return sendError(res, 503, refusal);
    const body = method === 'POST' ? await readBody(req) : undefined;
    if (body === null) return sendError(res, 413, 'That request is too large to send to the model server.');

    const headers: Record<string, string> = {};
    for (const name of FORWARDED_REQUEST_HEADERS) {
      const value = req.headers[name];
      if (typeof value === 'string') headers[name] = value;
    }
    const requestId = randomBytes(16).toString('hex');
    const frame: DeviceLlmRequest = {
      requestId,
      url: `${route.baseUrl}${path}${url.search}`,
      method,
      headers,
      ...(body !== undefined ? { body } : {})
    };
    const held: Pending = { deviceId: route.deviceId, res, nextSeq: 0, early: new Map(), timer: setTimeout(() => {}, 0) };
    pending.set(requestId, held);
    arm(requestId, held, FIRST_LIFE_TIMEOUT_MS);
    // pi hung up (the user stopped the turn): stop the generation on the Mac too.
    res.on('close', () => {
      if (pending.get(requestId) !== held) return;
      finish(requestId, held);
      deps.pushTo(route.deviceId, LLM_CANCEL_FRAME, { requestId });
    });
    if (deps.pushTo(route.deviceId, LLM_REQUEST_FRAME, frame) === 0) {
      finish(requestId, held);
      sendError(res, 503, (await unavailable(route.deviceId)) ?? 'The computer running this model server could not be reached.');
    }
  }

  function apply(requestId: string, held: Pending, chunk: DeviceLlmChunk): void {
    const { res } = held;
    if (!res.headersSent && chunk.status !== undefined) {
      const headers: Record<string, string> = {};
      for (const name of FORWARDED_RESPONSE_HEADERS) {
        const value = chunk.headers?.[name];
        if (typeof value === 'string') headers[name] = value;
      }
      res.writeHead(chunk.status, headers);
    }
    if (chunk.data) {
      if (!res.headersSent) res.writeHead(200);
      res.write(chunk.data);
    }
    if (chunk.error) {
      finish(requestId, held);
      sendError(res, 502, chunk.error);
      return;
    }
    if (chunk.done) {
      finish(requestId, held);
      if (!res.headersSent) res.writeHead(204);
      res.end();
    }
  }

  return {
    async baseFor(routeId) {
      listening ??= new Promise<number>((resolve, reject) => {
        server = createServer((req, res) => {
          handle(req, res).catch((e) => {
            log('llm-device', 'the relay failed a request', { error: String(e) });
            sendError(res, 500, 'Stem could not relay that request.');
          });
        });
        // Generations run as long as they run; the idle timer above is the bound.
        server.requestTimeout = 0;
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => resolve((server!.address() as AddressInfo).port));
        server.unref();
      });
      const port = await listening;
      return `http://127.0.0.1:${port}/${token}/${encodeURIComponent(routeId)}`;
    },
    setRoute(routeId, route) {
      routes.set(routeId, { deviceId: route.deviceId, baseUrl: route.baseUrl.replace(/\/+$/, '') });
    },
    clearRoute(routeId) {
      routes.delete(routeId);
    },
    unavailable,
    onChunk(deviceId, raw) {
      const chunk = raw as Partial<DeviceLlmChunk> | null;
      if (!chunk || typeof chunk.requestId !== 'string' || typeof chunk.seq !== 'number') return { live: false };
      const held = pending.get(chunk.requestId);
      // Unknown, finished, or another device's: the answer is the same, stop.
      if (!held || held.deviceId !== deviceId) return { live: false };
      arm(chunk.requestId, held, IDLE_TIMEOUT_MS);
      const clean: DeviceLlmChunk = {
        requestId: chunk.requestId,
        seq: chunk.seq,
        ...(typeof chunk.status === 'number' && chunk.status >= 100 && chunk.status < 600 ? { status: chunk.status } : {}),
        ...(chunk.headers && typeof chunk.headers === 'object' ? { headers: chunk.headers } : {}),
        ...(typeof chunk.data === 'string' ? { data: chunk.data } : {}),
        ...(chunk.done === true ? { done: true as const } : {}),
        ...(typeof chunk.error === 'string' ? { error: chunk.error.slice(0, 500) } : {})
      };
      if (clean.seq < held.nextSeq) return { live: true }; // a retried POST
      held.early.set(clean.seq, clean);
      while (held.early.has(held.nextSeq) && pending.get(chunk.requestId) === held) {
        const next = held.early.get(held.nextSeq)!;
        held.early.delete(held.nextSeq);
        held.nextSeq++;
        apply(chunk.requestId, held, next);
      }
      return { live: true };
    },
    close() {
      for (const [requestId, held] of pending) {
        finish(requestId, held);
        sendError(held.res, 503, 'Stem is shutting down.');
      }
      server?.close();
      server = null;
      listening = null;
    }
  };
}

let relay: LlmRelay | null = null;

/** The process-wide relay, wired to the transport and the device registry. */
export function llmRelay(): LlmRelay {
  relay ??= createLlmRelay({
    pushTo: pushToDevice,
    connectedDevices: connectedDeviceIds,
    deviceLabel: async (deviceId) => {
      // quiet: an unreadable registry names the id rather than claiming an unpairing.
      const devices = await readDevices().catch(() => null);
      if (!devices) return `the device ${deviceId}`;
      const device = devices.find((d) => d.id === deviceId);
      return device ? `“${device.label}”` : null;
    }
  });
  return relay;
}

export function closeLlmRelay(): void {
  relay?.close();
  relay = null;
}
