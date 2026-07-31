import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkerState } from '../types';

// window.location.href をテスト実行環境で使えるようにする
(globalThis as any).window = { location: { href: 'https://example.com/' } };

// Mocking WorkerWrapper before LSZL import
type WorkerWrapperMock = {
  getState: ReturnType<typeof vi.fn>;
  getBuffer: ReturnType<typeof vi.fn>;
  getExistsBuffer: ReturnType<typeof vi.fn>;
  getPendingCount: ReturnType<typeof vi.fn>;
  abort: ReturnType<typeof vi.fn>;
  terminate: ReturnType<typeof vi.fn>;
  onFallback?: () => void;
  __params: Record<string, unknown>;
  __triggerFallback: () => void;
};

const wrappers: WorkerWrapperMock[] = [];
const stateOverrides: Array<Partial<WorkerState> | undefined> = [];

vi.mock('./worker-wrapper', () => {
  class MockWorkerWrapper {
    public onFallback?: () => void;
    public getState: ReturnType<typeof vi.fn>;
    public getBuffer: ReturnType<typeof vi.fn>;
    public getExistsBuffer: ReturnType<typeof vi.fn>;
    public getPendingCount: ReturnType<typeof vi.fn>;
    public abort: ReturnType<typeof vi.fn>;
    public terminate: ReturnType<typeof vi.fn>;
    public __params: Record<string, unknown>;
    public __triggerFallback: () => void;

    constructor(params: Record<string, unknown>) {
      const idx = wrappers.length;
      const override = stateOverrides[idx];
      const state: WorkerState = {
        entryNames: ['a.txt', 'b.txt', 'c.txt'],
        fallback: false,
        ...(override ?? {}),
      };
      this.getState = vi.fn().mockResolvedValue(state);
      this.getBuffer = vi.fn();
      this.getExistsBuffer = vi.fn().mockReturnValue(undefined);
      this.getPendingCount = vi.fn().mockReturnValue(0);
      this.abort = vi.fn();
      this.terminate = vi.fn();
      this.__params = params;
      this.__triggerFallback = () => this.onFallback?.();
      wrappers.push(this as unknown as WorkerWrapperMock);
    }
  }
  return { default: MockWorkerWrapper };
});

// Dynamically import AFTER the mock is registered
let LSZL: typeof import('./lszl').default;
beforeEach(async () => {
  wrappers.length = 0;
  stateOverrides.length = 0;
  const mod = await import('./lszl');
  LSZL = mod.default;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('LSZL constructor', () => {
  it('resolves URL against window.location.href', () => {
    const lszl = new LSZL({ url: '/foo.zip' });
    expect(lszl.url).toBe('https://example.com/foo.zip');
  });

  it('starts a single worker when initial state has fallback=true', async () => {
    stateOverrides[0] = { fallback: true };
    const lszl = new LSZL({ url: 'https://example.com/file.zip' });
    await lszl.getEntryNames();
    expect(wrappers).toHaveLength(1);
    // fallback状態の場合、後続のcoworkerは作らない
    expect(wrappers[0].onFallback).toBeUndefined();
  });

  it('starts multiple workers when initial state is not fallback (default 4)', async () => {
    const lszl = new LSZL({ url: 'https://example.com/file.zip' });
    await lszl.getEntryNames();
    expect(wrappers).toHaveLength(4);
    expect(wrappers[0].__params.forceKeepCache).toBeUndefined();
    // co-workers use forceKeepCache=true
    for (let i = 1; i < 4; i++) {
      expect(wrappers[i].__params.forceKeepCache).toBe(true);
    }
  });

  it('honors params.multiply and clamps to at least 1', async () => {
    const lszl = new LSZL({ url: 'https://example.com/file.zip', multiply: 2 });
    await lszl.getEntryNames();
    expect(wrappers).toHaveLength(2);
  });

  it('clamps multiply=0 to LANE_MULTIPLY default (4)', async () => {
    const lszl = new LSZL({ url: 'https://example.com/file.zip', multiply: 0 });
    await lszl.getEntryNames();
    // multiply=0 falsy → default 4
    expect(wrappers).toHaveLength(4);
  });

  it('passes worker override to WorkerWrapper', async () => {
    const lszl = new LSZL({ url: 'https://example.com/file.zip', worker: 'custom.js', multiply: 1 });
    await lszl.getEntryNames();
    expect(wrappers[0].__params.worker).toBe('custom.js');
  });
});

describe('LSZL.getEntryNames', () => {
  it('returns entry names from the first worker state', async () => {
    stateOverrides[0] = { entryNames: ['x', 'y'] };
    const lszl = new LSZL({ url: 'https://example.com/file.zip', multiply: 1 });
    await expect(lszl.getEntryNames()).resolves.toEqual(['x', 'y']);
  });
});

describe('LSZL.getBuffer', () => {
  it('returns already-existing buffer from any worker without spawning a new request', async () => {
    const lszl = new LSZL({ url: 'https://example.com/file.zip', multiply: 3 });
    await lszl.getEntryNames();

    const existing = Promise.resolve(new ArrayBuffer(4));
    wrappers[2].getExistsBuffer.mockImplementation((n: string) => (n === 'a.txt' ? existing : undefined));

    const result = await lszl.getBuffer('a.txt');
    expect(result).toBeInstanceOf(ArrayBuffer);
    // No worker should have getBuffer called
    for (const w of wrappers) {
      expect(w.getBuffer).not.toHaveBeenCalled();
    }
  });

  it('selects the most-free worker (lowest pending count) when no existing buffer', async () => {
    const lszl = new LSZL({ url: 'https://example.com/file.zip', multiply: 3 });
    await lszl.getEntryNames();

    wrappers[0].getPendingCount.mockReturnValue(5);
    wrappers[1].getPendingCount.mockReturnValue(1);
    wrappers[2].getPendingCount.mockReturnValue(3);

    const buff = new ArrayBuffer(8);
    wrappers[1].getBuffer.mockResolvedValue(buff);

    await expect(lszl.getBuffer('a.txt')).resolves.toBe(buff);
    expect(wrappers[1].getBuffer).toHaveBeenCalledWith('a.txt');
    expect(wrappers[0].getBuffer).not.toHaveBeenCalled();
    expect(wrappers[2].getBuffer).not.toHaveBeenCalled();
  });

  it('falls back to first worker on ties (strict >, not >=)', async () => {
    const lszl = new LSZL({ url: 'https://example.com/file.zip', multiply: 3 });
    await lszl.getEntryNames();

    wrappers[0].getPendingCount.mockReturnValue(2);
    wrappers[1].getPendingCount.mockReturnValue(2);
    wrappers[2].getPendingCount.mockReturnValue(2);

    wrappers[0].getBuffer.mockResolvedValue(new ArrayBuffer(1));
    await lszl.getBuffer('a.txt');
    expect(wrappers[0].getBuffer).toHaveBeenCalled();
  });
});

describe('LSZL.abort', () => {
  it('calls abort on every worker', async () => {
    const lszl = new LSZL({ url: 'https://example.com/file.zip', multiply: 3 });
    await lszl.getEntryNames();

    await lszl.abort('a.txt');

    for (const w of wrappers) {
      expect(w.abort).toHaveBeenCalledWith('a.txt');
    }
  });
});

describe('LSZL fallback', () => {
  it('drops co-workers via terminate when first worker triggers onFallback', async () => {
    const lszl = new LSZL({ url: 'https://example.com/file.zip', multiply: 3 });
    await lszl.getEntryNames();
    expect(wrappers).toHaveLength(3);

    wrappers[0].__triggerFallback();
    // Wait for microtasks (fallback は setupWorkers を Promise chain で書き換える)
    await new Promise((r) => setTimeout(r, 0));

    // After fallback, calling getBuffer should route to the surviving worker
    wrappers[0].getPendingCount.mockReturnValue(0);
    wrappers[0].getBuffer.mockResolvedValue(new ArrayBuffer(3));
    await lszl.getBuffer('a.txt');
    expect(wrappers[0].getBuffer).toHaveBeenCalled();

    // Co-workers must have been terminated
    expect(wrappers[1].terminate).toHaveBeenCalled();
    expect(wrappers[2].terminate).toHaveBeenCalled();
  });
});

describe('LSZL.prefetchAll', () => {
  it('sequentially fetches all entries', async () => {
    stateOverrides[0] = { entryNames: ['a', 'b'] };
    const lszl = new LSZL({ url: 'https://example.com/file.zip', multiply: 1 });
    wrappers.length; // ensure not touched yet
    await lszl.getEntryNames();

    wrappers[0].getBuffer.mockImplementation((name: string) => Promise.resolve(new ArrayBuffer(name.length)));

    await lszl.prefetchAll();

    expect(wrappers[0].getBuffer).toHaveBeenCalledWith('a');
    expect(wrappers[0].getBuffer).toHaveBeenCalledWith('b');
  });

  it('returns the same in-flight promise when called twice (dedupe)', async () => {
    stateOverrides[0] = { entryNames: ['a'] };
    const lszl = new LSZL({ url: 'https://example.com/file.zip', multiply: 1 });
    await lszl.getEntryNames();

    let resolveBuf!: (v: ArrayBuffer) => void;
    wrappers[0].getBuffer.mockReturnValue(
      new Promise<ArrayBuffer>((r) => {
        resolveBuf = r;
      }),
    );

    const first = lszl.prefetchAll();
    const second = lszl.prefetchAll();
    expect(second).toBe(first);

    resolveBuf(new ArrayBuffer(1));
    await first;
  });
});
