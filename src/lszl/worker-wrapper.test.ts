import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageType } from '../types';
import WorkerWrapper from './worker-wrapper';

class MockWorker {
  public onmessage: ((ev: MessageEvent) => void) | null = null;
  public postMessage = vi.fn();
  public terminate = vi.fn();
  public url: string;
  public static instances: MockWorker[] = [];

  constructor(url: string) {
    this.url = url;
    MockWorker.instances.push(this);
  }

  public emit(data: unknown) {
    this.onmessage?.({ data } as MessageEvent);
  }
}

let originalWorker: unknown;
let hadWorker = false;

beforeEach(() => {
  hadWorker = 'Worker' in globalThis;
  originalWorker = (globalThis as any).Worker;
  MockWorker.instances = [];
  (globalThis as any).Worker = MockWorker;
});

afterEach(() => {
  if (hadWorker) {
    (globalThis as any).Worker = originalWorker;
  } else {
    delete (globalThis as any).Worker;
  }
});

function lastWorker(): MockWorker {
  return MockWorker.instances[MockWorker.instances.length - 1];
}

describe('WorkerWrapper constructor', () => {
  it('should spawn Worker at default url and post INIT with params payload', () => {
    const params = { url: 'https://example.com/file.zip', noUseCache: false };
    // biome-ignore lint/correctness/noUnusedVariables: 副作用のためのインスタンス化
    const wrapper = new WorkerWrapper(params);

    const worker = lastWorker();
    expect(worker.url).toBe('lszlw.js');
    expect(worker.postMessage).toHaveBeenCalledTimes(1);
    expect(worker.postMessage).toHaveBeenCalledWith({
      type: MessageType.INIT,
      payload: params,
    });
  });

  it('should spawn Worker at custom worker url when provided', () => {
    // biome-ignore lint/correctness/noUnusedVariables: 副作用のためのインスタンス化
    const wrapper = new WorkerWrapper({
      url: 'https://example.com/file.zip',
      worker: 'https://cdn.example.com/custom-worker.js',
    });
    expect(lastWorker().url).toBe('https://cdn.example.com/custom-worker.js');
  });
});

describe('WorkerWrapper.getState', () => {
  it('should resolve once INIT response arrives', async () => {
    const wrapper = new WorkerWrapper({ url: 'https://example.com/file.zip' });
    const worker = lastWorker();

    const state = { entryNames: ['a.txt', 'b.txt'], fallback: false };
    worker.emit({ type: MessageType.INIT, payload: state });

    await expect(wrapper.getState()).resolves.toEqual(state);
  });

  it('should reject when INIT response has error flag', async () => {
    const wrapper = new WorkerWrapper({ url: 'https://example.com/file.zip' });
    const worker = lastWorker();

    worker.emit({ type: MessageType.INIT, error: true, payload: 'init failed' });

    await expect(wrapper.getState()).rejects.toBe('init failed');
  });
});

describe('WorkerWrapper.getBuffer', () => {
  it('should post GET_DATA and resolve with matching GET_DATA response', async () => {
    const wrapper = new WorkerWrapper({ url: 'https://example.com/file.zip' });
    const worker = lastWorker();
    worker.postMessage.mockClear();

    const pending = wrapper.getBuffer('entry-a');

    expect(worker.postMessage).toHaveBeenCalledWith({
      type: MessageType.GET_DATA,
      payload: 'entry-a',
    });

    const buff = new ArrayBuffer(4);
    worker.emit({ type: MessageType.GET_DATA, payload: buff, meta: 'entry-a' });

    await expect(pending).resolves.toBe(buff);
  });

  it('should return the same promise for duplicated calls (dedupe)', () => {
    const wrapper = new WorkerWrapper({ url: 'https://example.com/file.zip' });
    const worker = lastWorker();
    worker.postMessage.mockClear();

    const first = wrapper.getBuffer('entry-a');
    const second = wrapper.getBuffer('entry-a');

    expect(second).toBe(first);
    expect(worker.postMessage).toHaveBeenCalledTimes(1);
  });

  it('should ignore responses whose meta does not match a known entry', async () => {
    const wrapper = new WorkerWrapper({ url: 'https://example.com/file.zip' });
    const worker = lastWorker();

    const pending = wrapper.getBuffer('entry-a');

    // 未知エントリの GET_DATA が来ても pending は resolve しない
    worker.emit({ type: MessageType.GET_DATA, payload: new ArrayBuffer(1), meta: 'entry-b' });

    let resolved = false;
    pending.then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);

    const buff = new ArrayBuffer(2);
    worker.emit({ type: MessageType.GET_DATA, payload: buff, meta: 'entry-a' });
    await expect(pending).resolves.toBe(buff);
  });

  it('should reject when the GET_DATA response carries an error', async () => {
    const wrapper = new WorkerWrapper({ url: 'https://example.com/file.zip' });
    const worker = lastWorker();

    const pending = wrapper.getBuffer('entry-a');
    worker.emit({ type: MessageType.GET_DATA, error: true, payload: 'boom', meta: 'entry-a' });

    await expect(pending).rejects.toBe('boom');
  });

  it('should remove resolver after resolution so a subsequent call re-posts', async () => {
    const wrapper = new WorkerWrapper({ url: 'https://example.com/file.zip' });
    const worker = lastWorker();
    worker.postMessage.mockClear();

    const first = wrapper.getBuffer('entry-a');
    worker.emit({ type: MessageType.GET_DATA, payload: new ArrayBuffer(1), meta: 'entry-a' });
    await first;
    await Promise.resolve(); // cleanup .then が走るのを待つ

    const second = wrapper.getBuffer('entry-a');
    expect(worker.postMessage).toHaveBeenCalledTimes(2);
    worker.emit({ type: MessageType.GET_DATA, payload: new ArrayBuffer(2), meta: 'entry-a' });
    await expect(second).resolves.toBeInstanceOf(ArrayBuffer);
  });

  it('should remove resolver after REJECTION so pending drops and re-request re-posts', async () => {
    // M7 対策: reject 経路で `delete this.resolvers.getData[entryName]` が消えると
    // 同名エントリは (a) getPendingCount が減らない (b) getExistsBuffer が過去の
    // 拒否済み Promise を返し続ける、というリークになる。
    const wrapper = new WorkerWrapper({ url: 'https://example.com/file.zip' });
    const worker = lastWorker();
    worker.postMessage.mockClear();

    const first = wrapper.getBuffer('entry-a');
    worker.emit({ type: MessageType.GET_DATA, error: true, payload: 'boom', meta: 'entry-a' });
    await expect(first).rejects.toBe('boom');
    await Promise.resolve();

    expect(wrapper.getPendingCount()).toBe(0);
    const second = wrapper.getBuffer('entry-a');
    expect(worker.postMessage).toHaveBeenCalledTimes(2);
    worker.emit({ type: MessageType.GET_DATA, payload: new ArrayBuffer(3), meta: 'entry-a' });
    await expect(second).resolves.toBeInstanceOf(ArrayBuffer);
  });
});

describe('WorkerWrapper.getExistsBuffer', () => {
  it('should return undefined before any getBuffer is called', () => {
    const wrapper = new WorkerWrapper({ url: 'https://example.com/file.zip' });
    expect(wrapper.getExistsBuffer('entry-a')).toBeUndefined();
  });

  it('should return the pending promise once getBuffer is issued', () => {
    const wrapper = new WorkerWrapper({ url: 'https://example.com/file.zip' });
    const pending = wrapper.getBuffer('entry-a');
    expect(wrapper.getExistsBuffer('entry-a')).toBe(pending);
  });
});

describe('WorkerWrapper.getPendingCount', () => {
  it('should reflect the number of unresolved getBuffer requests', async () => {
    const wrapper = new WorkerWrapper({ url: 'https://example.com/file.zip' });
    const worker = lastWorker();

    expect(wrapper.getPendingCount()).toBe(0);

    const p1 = wrapper.getBuffer('a');
    const p2 = wrapper.getBuffer('b');
    expect(wrapper.getPendingCount()).toBe(2);

    worker.emit({ type: MessageType.GET_DATA, payload: new ArrayBuffer(1), meta: 'a' });
    await p1;
    await Promise.resolve();
    expect(wrapper.getPendingCount()).toBe(1);

    worker.emit({ type: MessageType.GET_DATA, payload: new ArrayBuffer(1), meta: 'b' });
    await p2;
    await Promise.resolve();
    expect(wrapper.getPendingCount()).toBe(0);
  });
});

describe('WorkerWrapper.abort', () => {
  it('should post ABORT_DATA when the entry is pending', () => {
    const wrapper = new WorkerWrapper({ url: 'https://example.com/file.zip' });
    const worker = lastWorker();
    wrapper.getBuffer('entry-a');
    worker.postMessage.mockClear();

    wrapper.abort('entry-a');

    expect(worker.postMessage).toHaveBeenCalledWith({
      type: MessageType.ABORT_DATA,
      payload: 'entry-a',
    });
  });

  it('should not post ABORT_DATA when the entry is not pending', () => {
    const wrapper = new WorkerWrapper({ url: 'https://example.com/file.zip' });
    const worker = lastWorker();
    worker.postMessage.mockClear();

    wrapper.abort('entry-a');

    expect(worker.postMessage).not.toHaveBeenCalled();
  });
});

describe('WorkerWrapper.terminate', () => {
  it('should call worker.terminate when no requests are pending', () => {
    const wrapper = new WorkerWrapper({ url: 'https://example.com/file.zip' });
    const worker = lastWorker();

    wrapper.terminate();

    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  // 既知の実装バグ: terminate 内で `Object.keys(...).forEach(this.abort)` を
  // 通常メソッド `abort` に渡しており this が失われて TypeError で落ちる。
  // プロダクションコードは触らない方針のため現状挙動を固定する。
  it('should throw TypeError when pending entries exist (known bug: unbound abort)', () => {
    const wrapper = new WorkerWrapper({ url: 'https://example.com/file.zip' });
    wrapper.getBuffer('a');

    expect(() => wrapper.terminate()).toThrow(TypeError);
  });
});

describe('WorkerWrapper.onFallback', () => {
  // 既知の実装/型不整合: lszlw.ts 側は `{type, state, meta}` を送っているが
  // types.ts の UpdateStateMessage は `payload` を宣言している。
  // 実装 (worker-wrapper.ts:96-99) は payload/state のどちらでもハンドラを
  // 発火するので、実装が実際に送る形 (state) でテストする。後続 PR で
  // 実装側/型定義を統一する予定。
  it('should be invoked when an UPDATE_STATE message arrives', () => {
    const wrapper = new WorkerWrapper({ url: 'https://example.com/file.zip' });
    const worker = lastWorker();
    const cb = vi.fn();
    wrapper.onFallback = cb;

    worker.emit({ type: MessageType.UPDATE_STATE, state: { entryNames: [], fallback: true } });

    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('should not throw when onFallback is not set', () => {
    const wrapper = new WorkerWrapper({ url: 'https://example.com/file.zip' });
    const worker = lastWorker();
    expect(() => {
      worker.emit({ type: MessageType.UPDATE_STATE, state: { entryNames: [], fallback: true } });
    }).not.toThrow();
    expect(wrapper.getPendingCount()).toBe(0);
  });
});
