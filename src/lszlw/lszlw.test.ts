import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageType } from '../types';

// worker 本体は self.onmessage / postMessage / new LSZRWrapper に依存する。
// self, postMessage をテスト側で差し替え、LSZRWrapper は vi.mock で置換する。

type OnMessage = (ev: MessageEvent) => void;
const selfObj: { onmessage: OnMessage | null } = { onmessage: null };
const postMessageSpy = vi.fn();

let hadSelf = false;
let hadPostMessage = false;
let originalSelf: unknown;
let originalPostMessage: unknown;

// LSZRWrapper の挙動をテスト毎に差し替えるための共有ハンドル
type MockConfig = {
  state?: { entryNames: string[]; fallback: boolean };
  buffers?: Record<string, Uint8Array>;
  getBufferImpl?: (name: string, signal: AbortSignal) => Promise<Uint8Array>;
  getStateImpl?: () => Promise<{ entryNames: string[]; fallback: boolean }>;
  onConstruct?: (params: { onUpdateState: (s: unknown) => void }) => void;
};
const mockConfig: MockConfig = {};

vi.mock('./lszr-wrapper', () => {
  class MockLSZRWrapper {
    constructor(params: any) {
      mockConfig.onConstruct?.(params);
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
  selfObj.onmessage = null;
  vi.resetModules();
  await import('./lszlw');
}

beforeEach(async () => {
  postMessageSpy.mockClear();
  mockConfig.state = undefined;
  mockConfig.buffers = undefined;
  mockConfig.getBufferImpl = undefined;
  mockConfig.getStateImpl = undefined;
  mockConfig.onConstruct = undefined;

  hadSelf = 'self' in globalThis;
  originalSelf = (globalThis as any).self;
  hadPostMessage = 'postMessage' in globalThis;
  originalPostMessage = (globalThis as any).postMessage;

  (globalThis as any).self = selfObj;
  (globalThis as any).postMessage = postMessageSpy;

  await loadWorker();
});

afterEach(() => {
  if (hadSelf) {
    (globalThis as any).self = originalSelf;
  } else {
    delete (globalThis as any).self;
  }
  if (hadPostMessage) {
    (globalThis as any).postMessage = originalPostMessage;
  } else {
    delete (globalThis as any).postMessage;
  }
});

function send(message: any) {
  selfObj.onmessage?.({ data: message } as MessageEvent);
}

async function flush() {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

describe('lszlw worker: INIT', () => {
  it('should set self.onmessage on module load', () => {
    expect(typeof selfObj.onmessage).toBe('function');
  });

  it('should post INIT response with WorkerState on success', async () => {
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

  it('should post INIT error when state resolution rejects', async () => {
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

  it('should wire onUpdateState so state changes are posted as UPDATE_STATE', async () => {
    // 既知の実装/型不整合: lszlw.ts の UPDATE_STATE 送信形は `{type, state, meta}` だが
    // types.ts の UpdateStateMessage は `payload` を宣言している。
    // ここでは実装が実際に送る形 (state) で受信を検証する。後続 PR で
    // 実装/型定義を統一予定。
    let capturedOnUpdate: ((s: unknown) => void) | undefined;
    mockConfig.onConstruct = (params) => {
      capturedOnUpdate = params.onUpdateState;
    };
    mockConfig.state = { entryNames: [], fallback: false };

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
  });
});

describe('lszlw worker: GET_DATA', () => {
  beforeEach(async () => {
    mockConfig.state = { entryNames: ['a', 'b'], fallback: false };
    send({ type: MessageType.INIT, payload: { url: 'https://example.com/a.zip' } });
    await flush();
    postMessageSpy.mockClear();
  });

  it('should post data with Transferable when getBuffer resolves', async () => {
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

  it('should post error when getBuffer rejects', async () => {
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

  it('should ignore duplicate GET_DATA for the same entry while first is in flight', async () => {
    let calls = 0;
    mockConfig.getBufferImpl = () => {
      calls++;
      return new Promise(() => {}); // 未解決
    };

    send({ type: MessageType.GET_DATA, payload: 'a' });
    send({ type: MessageType.GET_DATA, payload: 'a' });
    send({ type: MessageType.GET_DATA, payload: 'a' });
    await flush();

    expect(calls).toBe(1);
  });

  it('should accept new GET_DATA for the same entry after previous resolved', async () => {
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

  it('should accept a re-request for the same entry after previous REJECTED', async () => {
    // M9 対策: reject 経路で `delete dataHandlers[entryName]` が消えると、
    // 同名エントリは以降ずっと重複判定に引っかかって無視され続けるデッドロック。
    let count = 0;
    mockConfig.getBufferImpl = () => {
      count++;
      if (count === 1) return Promise.reject(new Error('first-fail'));
      return Promise.resolve(new Uint8Array([count]));
    };

    send({ type: MessageType.GET_DATA, payload: 'a' });
    await flush();
    // 1 回目の失敗レスポンスが返っていること
    const firstResp = postMessageSpy.mock.calls.filter(([msg]) => msg?.type === MessageType.GET_DATA);
    expect(firstResp).toHaveLength(1);
    expect(firstResp[0][0].error).toBe(true);

    // 同名エントリを再送 → getBuffer が再度呼ばれる (dataHandlers から削除済み)
    send({ type: MessageType.GET_DATA, payload: 'a' });
    await flush();
    expect(count).toBe(2);
    const respCount = postMessageSpy.mock.calls.filter(([msg]) => msg?.type === MessageType.GET_DATA).length;
    expect(respCount).toBe(2);
  });
});

describe('lszlw worker: ABORT_DATA', () => {
  beforeEach(async () => {
    mockConfig.state = { entryNames: ['a'], fallback: false };
    send({ type: MessageType.INIT, payload: { url: 'https://example.com/a.zip' } });
    await flush();
    postMessageSpy.mockClear();
  });

  it('should call abort on the pending controller for the entry', async () => {
    let receivedSignal: AbortSignal | undefined;
    mockConfig.getBufferImpl = (_name, signal) => {
      receivedSignal = signal;
      return new Promise(() => {}); // 未解決
    };

    send({ type: MessageType.GET_DATA, payload: 'a' });
    await Promise.resolve();
    expect(receivedSignal?.aborted).toBe(false);

    send({ type: MessageType.ABORT_DATA, payload: 'a' });
    expect(receivedSignal?.aborted).toBe(true);

    const abortResponses = postMessageSpy.mock.calls.filter(([msg]) => msg?.type === MessageType.ABORT_DATA);
    expect(abortResponses).toHaveLength(0);
  });

  it('should be a no-op when the entry is not pending', () => {
    expect(() => send({ type: MessageType.ABORT_DATA, payload: 'not-there' })).not.toThrow();
  });
});
