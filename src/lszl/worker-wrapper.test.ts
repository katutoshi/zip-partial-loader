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

const originalWorker = (globalThis as any).Worker;

beforeEach(() => {
  MockWorker.instances = [];
  (globalThis as any).Worker = MockWorker;
});

afterEach(() => {
  (globalThis as any).Worker = originalWorker;
});

function lastWorker(): MockWorker {
  return MockWorker.instances[MockWorker.instances.length - 1];
}

describe('WorkerWrapper constructor', () => {
  it('spawns Worker at default url and posts INIT with params payload', () => {
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

  it('spawns Worker at custom worker url when provided', () => {
    // biome-ignore lint/correctness/noUnusedVariables: 副作用のためのインスタンス化
    const wrapper = new WorkerWrapper({
      url: 'https://example.com/file.zip',
      worker: 'https://cdn.example.com/custom-worker.js',
    });
    expect(lastWorker().url).toBe('https://cdn.example.com/custom-worker.js');
  });
});

describe('WorkerWrapper.getState', () => {
  it('resolves once INIT response arrives', async () => {
    const wrapper = new WorkerWrapper({ url: 'https://example.com/file.zip' });
    const worker = lastWorker();

    const state = { entryNames: ['a.txt', 'b.txt'], fallback: false };
    worker.emit({ type: MessageType.INIT, payload: state });

    await expect(wrapper.getState()).resolves.toEqual(state);
  });

  it('rejects when INIT response has error flag', async () => {
    const wrapper = new WorkerWrapper({ url: 'https://example.com/file.zip' });
    const worker = lastWorker();

    worker.emit({ type: MessageType.INIT, error: true, payload: 'init failed' });

    await expect(wrapper.getState()).rejects.toBe('init failed');
  });
});

describe('WorkerWrapper.getBuffer', () => {
  it('posts GET_DATA and resolves with matching GET_DATA response', async () => {
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

  it('returns the same promise instance for duplicated calls (dedupe)', () => {
    const wrapper = new WorkerWrapper({ url: 'https://example.com/file.zip' });
    const worker = lastWorker();
    worker.postMessage.mockClear();

    const first = wrapper.getBuffer('entry-a');
    const second = wrapper.getBuffer('entry-a');

    expect(second).toBe(first);
    expect(worker.postMessage).toHaveBeenCalledTimes(1);
  });

  it('ignores responses whose meta does not match a known entry', async () => {
    const wrapper = new WorkerWrapper({ url: 'https://example.com/file.zip' });
    const worker = lastWorker();

    const pending = wrapper.getBuffer('entry-a');

    // Emit a GET_DATA for an unknown entry: should not resolve pending
    worker.emit({ type: MessageType.GET_DATA, payload: new ArrayBuffer(1), meta: 'entry-b' });

    let resolved = false;
    pending.then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);

    // Now actually resolve
    const buff = new ArrayBuffer(2);
    worker.emit({ type: MessageType.GET_DATA, payload: buff, meta: 'entry-a' });
    await expect(pending).resolves.toBe(buff);
  });

  it('rejects when the GET_DATA response carries an error', async () => {
    const wrapper = new WorkerWrapper({ url: 'https://example.com/file.zip' });
    const worker = lastWorker();

    const pending = wrapper.getBuffer('entry-a');
    worker.emit({ type: MessageType.GET_DATA, error: true, payload: 'boom', meta: 'entry-a' });

    await expect(pending).rejects.toBe('boom');
  });

  it('removes resolver after resolution so a subsequent call re-posts', async () => {
    const wrapper = new WorkerWrapper({ url: 'https://example.com/file.zip' });
    const worker = lastWorker();
    worker.postMessage.mockClear();

    const first = wrapper.getBuffer('entry-a');
    worker.emit({ type: MessageType.GET_DATA, payload: new ArrayBuffer(1), meta: 'entry-a' });
    await first;

    // Allow the .then cleanup callback to run
    await Promise.resolve();

    const second = wrapper.getBuffer('entry-a');
    // 2 posts total: initial + this new call
    expect(worker.postMessage).toHaveBeenCalledTimes(2);
    worker.emit({ type: MessageType.GET_DATA, payload: new ArrayBuffer(2), meta: 'entry-a' });
    await expect(second).resolves.toBeInstanceOf(ArrayBuffer);
  });
});

describe('WorkerWrapper.getExistsBuffer', () => {
  it('returns undefined before any getBuffer is called', () => {
    const wrapper = new WorkerWrapper({ url: 'https://example.com/file.zip' });
    expect(wrapper.getExistsBuffer('entry-a')).toBeUndefined();
  });

  it('returns the pending promise once getBuffer is issued', () => {
    const wrapper = new WorkerWrapper({ url: 'https://example.com/file.zip' });
    const pending = wrapper.getBuffer('entry-a');
    expect(wrapper.getExistsBuffer('entry-a')).toBe(pending);
  });
});

describe('WorkerWrapper.getPendingCount', () => {
  it('reflects the number of unresolved getBuffer requests', async () => {
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
  it('posts ABORT_DATA when the entry is pending', () => {
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

  it('does not post ABORT_DATA when the entry is not pending', () => {
    const wrapper = new WorkerWrapper({ url: 'https://example.com/file.zip' });
    const worker = lastWorker();
    worker.postMessage.mockClear();

    wrapper.abort('entry-a');

    expect(worker.postMessage).not.toHaveBeenCalled();
  });
});

describe('WorkerWrapper.terminate', () => {
  it('calls worker.terminate when no requests are pending', () => {
    const wrapper = new WorkerWrapper({ url: 'https://example.com/file.zip' });
    const worker = lastWorker();

    wrapper.terminate();

    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  // 既知の実装バグ: terminate() 内で `Object.keys(...).forEach(this.abort)` を
  // 通常メソッド `abort` に対して呼ぶと this が失われ TypeError で落ちる。
  // プロダクションコードを触らない方針なので、現状挙動を固定する
  // (壊れていることを可視化するテスト)。
  it('throws when pending entries exist because abort is not bound (known bug)', () => {
    const wrapper = new WorkerWrapper({ url: 'https://example.com/file.zip' });
    wrapper.getBuffer('a');

    expect(() => wrapper.terminate()).toThrow(TypeError);
  });
});

describe('WorkerWrapper.onFallback', () => {
  it('is invoked when UPDATE_STATE message arrives', () => {
    const wrapper = new WorkerWrapper({ url: 'https://example.com/file.zip' });
    const worker = lastWorker();
    const cb = vi.fn();
    wrapper.onFallback = cb;

    worker.emit({ type: MessageType.UPDATE_STATE, payload: { entryNames: [], fallback: true } });

    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('does nothing if onFallback is not set', () => {
    const wrapper = new WorkerWrapper({ url: 'https://example.com/file.zip' });
    const worker = lastWorker();
    expect(() => {
      worker.emit({ type: MessageType.UPDATE_STATE, payload: { entryNames: [], fallback: true } });
    }).not.toThrow();
    // just to satisfy the linter about unused variable
    expect(wrapper.getPendingCount()).toBe(0);
  });
});
