import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageType } from '../types';

// self / postMessage をテスト環境向けに用意
const globalAny = globalThis as any;

type OnMessage = (ev: MessageEvent) => void;
const selfObj: { onmessage: OnMessage | null } = { onmessage: null };
const postMessageSpy = vi.fn();

const originalSelf = globalAny.self;
const originalPostMessage = globalAny.postMessage;

// LSZRWrapperMock: getState / getBuffer / onUpdateState 呼び出しの経路を実装
type LSZRWrapperMockConfig = {
  state?: { entryNames: string[]; fallback: boolean };
  buffers?: Record<string, Uint8Array>;
  getBufferImpl?: (name: string, signal: AbortSignal) => Promise<Uint8Array>;
  getStateImpl?: () => Promise<{ entryNames: string[]; fallback: boolean }>;
};
const mockConfig: LSZRWrapperMockConfig = {};

vi.mock('./lszr-wrapper', () => {
  class MockLSZRWrapper {
    public params: any;
    constructor(params: any) {
      this.params = params;
    }
    getState() {
      if (mockConfig.getStateImpl) return mockConfig.getStateImpl();
      return Promise.resolve(mockConfig.state ?? { entryNames: ['a'], fallback: false });
    }
    getBuffer(name: string, signal: AbortSignal): Promise<Uint8Array> {
      if (mockConfig.getBufferImpl) return mockConfig.getBufferImpl(name, signal);
      const buf = mockConfig.buffers?.[name];
      if (buf) return Promise.resolve(buf);
      return Promise.reject(new Error(`no buffer for ${name}`));
    }
  }
  return { default: MockLSZRWrapper };
});

async function loadWorker() {
  // Reset self.onmessage and reload module
  selfObj.onmessage = null;
  vi.resetModules();
  await import('./lszlw');
}

beforeEach(async () => {
  postMessageSpy.mockClear();
  // Clean state
  mockConfig.state = undefined;
  mockConfig.buffers = undefined;
  mockConfig.getBufferImpl = undefined;
  mockConfig.getStateImpl = undefined;

  globalAny.self = selfObj;
  globalAny.postMessage = postMessageSpy;
  await loadWorker();
});

afterEach(() => {
  globalAny.self = originalSelf;
  globalAny.postMessage = originalPostMessage;
});

function send(message: any) {
  selfObj.onmessage?.({ data: message } as MessageEvent);
}

async function flush() {
  // 数マイクロタスク実行する
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
}

describe('lszlw worker: INIT', () => {
  it('sets self.onmessage on module load', () => {
    expect(typeof selfObj.onmessage).toBe('function');
  });

  it('posts INIT response with WorkerState on success', async () => {
    mockConfig.state = { entryNames: ['x', 'y'], fallback: false };

    send({
      type: MessageType.INIT,
      payload: { url: 'https://example.com/a.zip' },
      meta: 'init-meta',
    });

    await flush();

    const initCalls = postMessageSpy.mock.calls.filter(([msg]) => msg?.type === MessageType.INIT);
    expect(initCalls).toHaveLength(1);
    const [msg] = initCalls[0];
    expect(msg.payload).toEqual({ entryNames: ['x', 'y'], fallback: false });
    expect(msg.meta).toBe('init-meta');
    expect(msg.error).toBeUndefined();
  });

  it('posts INIT error when state resolution rejects', async () => {
    mockConfig.getStateImpl = () => Promise.reject(new Error('init boom'));

    send({
      type: MessageType.INIT,
      payload: { url: 'https://example.com/a.zip' },
    });

    await flush();

    const initCalls = postMessageSpy.mock.calls.filter(([msg]) => msg?.type === MessageType.INIT);
    expect(initCalls).toHaveLength(1);
    const [msg] = initCalls[0];
    expect(msg.error).toBe(true);
    expect(msg.payload).toContain('init boom');
  });

  it('wires onUpdateState so state changes are posted as UPDATE_STATE', async () => {
    // Capture onUpdateState by not resolving getState quickly
    let capturedOnUpdate: ((s: unknown) => void) | undefined;
    mockConfig.getStateImpl = () => new Promise(() => {}); // never resolves

    // We need access to the constructor params; peek via a custom impl of the mock
    // The mock stores params on `this.params`, but since we don't have a handle,
    // use side-effect trick: re-mock via getStateImpl to capture from constructor path.
    // Simpler: patch the mock class directly here.
    const mod = await import('./lszr-wrapper');
    const OriginalMock = mod.default as any;
    class Spy extends OriginalMock {
      constructor(params: any) {
        super(params);
        capturedOnUpdate = params.onUpdateState;
      }
    }
    (mod as any).default = Spy;

    // Reload the worker module to use the new mock
    vi.resetModules();
    postMessageSpy.mockClear();
    await import('./lszlw');

    send({
      type: MessageType.INIT,
      payload: { url: 'https://example.com/a.zip' },
      meta: 'm',
    });

    await flush();

    expect(typeof capturedOnUpdate).toBe('function');
    capturedOnUpdate?.({ entryNames: [], fallback: true });

    const updates = postMessageSpy.mock.calls.filter(([msg]) => msg?.type === MessageType.UPDATE_STATE);
    expect(updates).toHaveLength(1);
    expect(updates[0][0].state).toEqual({ entryNames: [], fallback: true });
    expect(updates[0][0].meta).toBe('m');

    // Restore
    (mod as any).default = OriginalMock;
  });
});

describe('lszlw worker: GET_DATA', () => {
  beforeEach(async () => {
    mockConfig.state = { entryNames: ['a', 'b'], fallback: false };
    send({ type: MessageType.INIT, payload: { url: 'https://example.com/a.zip' } });
    await flush();
    postMessageSpy.mockClear();
  });

  it('posts data with Transferable when getBuffer resolves', async () => {
    const u8 = new Uint8Array([1, 2, 3, 4]);
    mockConfig.buffers = { a: u8 };

    send({ type: MessageType.GET_DATA, payload: 'a' });
    await flush();

    const calls = postMessageSpy.mock.calls.filter(([msg]) => msg?.type === MessageType.GET_DATA);
    expect(calls).toHaveLength(1);
    const [msg, transferables] = calls[0];
    expect(msg.payload).toBe(u8.buffer);
    expect(msg.meta).toBe('a');
    expect(transferables).toEqual([u8.buffer]);
  });

  it('posts error when getBuffer rejects', async () => {
    mockConfig.getBufferImpl = () => Promise.reject(new Error('bad'));

    send({ type: MessageType.GET_DATA, payload: 'a' });
    await flush();

    const calls = postMessageSpy.mock.calls.filter(([msg]) => msg?.type === MessageType.GET_DATA);
    expect(calls).toHaveLength(1);
    const [msg, transferables] = calls[0];
    expect(msg.error).toBe(true);
    expect(msg.payload).toContain('bad');
    expect(msg.meta).toBe('a');
    expect(transferables).toBeUndefined();
  });

  it('ignores duplicate GET_DATA for the same entry while first is in flight', async () => {
    let calls = 0;
    mockConfig.getBufferImpl = () => {
      calls++;
      return new Promise(() => {}); // never resolves
    };

    send({ type: MessageType.GET_DATA, payload: 'a' });
    send({ type: MessageType.GET_DATA, payload: 'a' });
    send({ type: MessageType.GET_DATA, payload: 'a' });
    await flush();

    // getBuffer should be invoked exactly once
    expect(calls).toBe(1);
  });

  it('accepts new GET_DATA for the same entry after previous resolved', async () => {
    let count = 0;
    mockConfig.getBufferImpl = () => {
      count++;
      return Promise.resolve(new Uint8Array([count]));
    };

    send({ type: MessageType.GET_DATA, payload: 'a' });
    await flush();
    send({ type: MessageType.GET_DATA, payload: 'a' });
    await flush();

    expect(count).toBe(2);
  });
});

describe('lszlw worker: ABORT_DATA', () => {
  beforeEach(async () => {
    mockConfig.state = { entryNames: ['a'], fallback: false };
    send({ type: MessageType.INIT, payload: { url: 'https://example.com/a.zip' } });
    await flush();
    postMessageSpy.mockClear();
  });

  it('calls abort on the pending controller for the entry', async () => {
    let receivedSignal: AbortSignal | undefined;
    mockConfig.getBufferImpl = (_name, signal) => {
      receivedSignal = signal;
      return new Promise(() => {}); // never resolves
    };

    send({ type: MessageType.GET_DATA, payload: 'a' });
    await Promise.resolve();
    expect(receivedSignal?.aborted).toBe(false);

    send({ type: MessageType.ABORT_DATA, payload: 'a' });
    expect(receivedSignal?.aborted).toBe(true);

    // no response is posted for ABORT_DATA itself
    const abortResponses = postMessageSpy.mock.calls.filter(([msg]) => msg?.type === MessageType.ABORT_DATA);
    expect(abortResponses).toHaveLength(0);
  });

  it('is a no-op when the entry is not pending', () => {
    expect(() => send({ type: MessageType.ABORT_DATA, payload: 'not-there' })).not.toThrow();
  });
});
