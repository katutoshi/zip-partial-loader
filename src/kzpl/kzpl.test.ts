import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkerState } from '../types';

// WorkerWrapper のモック共有ストア (Kzpl のコンストラクタ経由で追加される)
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

let Kzpl: typeof import('./kzpl').default;

// window は Kzpl コンストラクタで URL 解決に使われるため beforeAll で用意する
let hadWindow = false;
let originalWindow: unknown;

beforeAll(async () => {
  hadWindow = 'window' in globalThis;
  originalWindow = (globalThis as any).window;
  (globalThis as any).window = { location: { href: 'https://example.com/' } };
  const mod = await import('./kzpl');
  Kzpl = mod.default;
});

afterAll(() => {
  if (hadWindow) {
    (globalThis as any).window = originalWindow;
  } else {
    delete (globalThis as any).window;
  }
});

beforeEach(() => {
  wrappers.length = 0;
  stateOverrides.length = 0;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('Kzpl constructor', () => {
  it('should resolve URL against window.location.href for relative paths', () => {
    const kzpl = new Kzpl({ url: '/foo.zip' });
    expect(kzpl.url).toBe('https://example.com/foo.zip');
  });

  it('should start only one worker when initial state has fallback=true', async () => {
    stateOverrides[0] = { fallback: true };
    const kzpl = new Kzpl({ url: 'https://example.com/file.zip' });
    await kzpl.getEntryNames();
    expect(wrappers).toHaveLength(1);
    // fallback 状態では co-worker を作らず、onFallback ハンドラも未セット
    expect(wrappers[0].onFallback).toBeUndefined();
  });

  it('should pass noUseCache=false explicitly to the first worker', async () => {
    // M5 対策: 先頭 worker に対する noUseCache: false が失われる (=true になる) と
    // キャッシュを一切使わない worker になってしまう。
    const kzpl = new Kzpl({ url: 'https://example.com/file.zip', multiply: 1 });
    await kzpl.getEntryNames();
    expect(wrappers[0].__params.noUseCache).toBe(false);
  });

  it('should start LANE_MULTIPLY (4) workers by default when not fallback', async () => {
    const kzpl = new Kzpl({ url: 'https://example.com/file.zip' });
    await kzpl.getEntryNames();
    expect(wrappers).toHaveLength(4);
    expect(wrappers[0].__params.forceKeepCache).toBeUndefined();
    // co-worker たちは forceKeepCache=true
    for (let i = 1; i < 4; i++) {
      expect(wrappers[i].__params.forceKeepCache).toBe(true);
    }
  });

  it('should honor params.multiply when >= 2', async () => {
    const kzpl = new Kzpl({ url: 'https://example.com/file.zip', multiply: 2 });
    await kzpl.getEntryNames();
    expect(wrappers).toHaveLength(2);
  });

  it('should preserve legacy fractional-multiply behavior: 2.5 spawns 3 workers (ceil)', async () => {
    // レガシー挙動の保全: 旧実装の for (index = 1; index < multiply; index++) は
    // ceil(multiply) - 1 回回るため、小数 multiply でも worker 総数は ceil(multiply) 個になる。
    // これは意図的仕様ではなく偶発的な挙動なので、テストは「保全」目的であることを明示する
    // (将来 floor/round に変えたくなった場合、このテストがブロッカーになるのは意図どおり)。
    const kzpl = new Kzpl({ url: 'https://example.com/file.zip', multiply: 2.5 });
    await kzpl.getEntryNames();
    expect(wrappers).toHaveLength(3);
  });

  it('should preserve legacy fractional-multiply behavior: 3.5 spawns 4 workers (ceil)', async () => {
    const kzpl = new Kzpl({ url: 'https://example.com/file.zip', multiply: 3.5 });
    await kzpl.getEntryNames();
    expect(wrappers).toHaveLength(4);
  });

  it('should clamp multiply to 1 when a negative value is given (Math.max)', async () => {
    // 実装は `params.multiply && Math.max(params.multiply, 1) || LANE_MULTIPLY`。
    // 負値 (-3) は truthy なので Math.max(-3, 1) = 1 に clamp される。
    const kzpl = new Kzpl({ url: 'https://example.com/file.zip', multiply: -3 });
    await kzpl.getEntryNames();
    expect(wrappers).toHaveLength(1);
  });

  it('should fall back to default (4) when multiply=0 (falsy)', async () => {
    const kzpl = new Kzpl({ url: 'https://example.com/file.zip', multiply: 0 });
    await kzpl.getEntryNames();
    expect(wrappers).toHaveLength(4);
  });

  it('should pass worker override to WorkerWrapper', async () => {
    const kzpl = new Kzpl({
      url: 'https://example.com/file.zip',
      worker: 'custom.js',
      multiply: 1,
    });
    await kzpl.getEntryNames();
    expect(wrappers[0].__params.worker).toBe('custom.js');
  });
});

describe('Kzpl.getEntryNames', () => {
  it('should return entry names from the first worker state', async () => {
    stateOverrides[0] = { entryNames: ['x', 'y'] };
    const kzpl = new Kzpl({ url: 'https://example.com/file.zip', multiply: 1 });
    await expect(kzpl.getEntryNames()).resolves.toEqual(['x', 'y']);
  });
});

describe('Kzpl.getBuffer', () => {
  it('should return the same buffer instance from getExistsBuffer without invoking getBuffer', async () => {
    const kzpl = new Kzpl({ url: 'https://example.com/file.zip', multiply: 3 });
    await kzpl.getEntryNames();

    const target = new ArrayBuffer(4);
    const existing = Promise.resolve(target);
    wrappers[2].getExistsBuffer.mockImplementation((n: string) => (n === 'a.txt' ? existing : undefined));

    const result = await kzpl.getBuffer('a.txt');
    // 同一オブジェクトが返る (=キャッシュ経路が本当に効いている)
    expect(result).toBe(target);
    for (const w of wrappers) {
      expect(w.getBuffer).not.toHaveBeenCalled();
    }
  });

  it('should prefer the first worker when multiple workers hold the cached buffer', async () => {
    // リファクタ (for...of 化) 後も、キャッシュ走査が先頭 worker から順に行われることを固定する。
    const kzpl = new Kzpl({ url: 'https://example.com/file.zip', multiply: 3 });
    await kzpl.getEntryNames();

    const first = new ArrayBuffer(1);
    const last = new ArrayBuffer(2);
    wrappers[0].getExistsBuffer.mockImplementation((n: string) => (n === 'a.txt' ? Promise.resolve(first) : undefined));
    wrappers[2].getExistsBuffer.mockImplementation((n: string) => (n === 'a.txt' ? Promise.resolve(last) : undefined));

    const result = await kzpl.getBuffer('a.txt');
    expect(result).toBe(first);
    // 2 番目以降の worker には到達しない
    expect(wrappers[1].getExistsBuffer).not.toHaveBeenCalled();
    expect(wrappers[2].getExistsBuffer).not.toHaveBeenCalled();
  });

  it('should not query pending counts when a cached buffer is found', async () => {
    // キャッシュヒット時は getMostFreeWorker (getPendingCount 探索) に進まないことを固定する。
    const kzpl = new Kzpl({ url: 'https://example.com/file.zip', multiply: 3 });
    await kzpl.getEntryNames();

    const target = new ArrayBuffer(4);
    wrappers[0].getExistsBuffer.mockImplementation((n: string) =>
      n === 'a.txt' ? Promise.resolve(target) : undefined,
    );

    const result = await kzpl.getBuffer('a.txt');
    expect(result).toBe(target);
    for (const w of wrappers) {
      expect(w.getPendingCount).not.toHaveBeenCalled();
    }
  });

  it('should select the most-free worker (lowest pending count)', async () => {
    const kzpl = new Kzpl({ url: 'https://example.com/file.zip', multiply: 3 });
    await kzpl.getEntryNames();

    wrappers[0].getPendingCount.mockReturnValue(5);
    wrappers[1].getPendingCount.mockReturnValue(1);
    wrappers[2].getPendingCount.mockReturnValue(3);

    const buff = new ArrayBuffer(8);
    wrappers[1].getBuffer.mockResolvedValue(buff);

    await expect(kzpl.getBuffer('a.txt')).resolves.toBe(buff);
    expect(wrappers[1].getBuffer).toHaveBeenCalledWith('a.txt');
    expect(wrappers[0].getBuffer).not.toHaveBeenCalled();
    expect(wrappers[2].getBuffer).not.toHaveBeenCalled();
  });

  it('should stick with the first worker on ties (strict >, not >=)', async () => {
    const kzpl = new Kzpl({ url: 'https://example.com/file.zip', multiply: 3 });
    await kzpl.getEntryNames();

    wrappers[0].getPendingCount.mockReturnValue(2);
    wrappers[1].getPendingCount.mockReturnValue(2);
    wrappers[2].getPendingCount.mockReturnValue(2);

    wrappers[0].getBuffer.mockResolvedValue(new ArrayBuffer(1));
    await kzpl.getBuffer('a.txt');
    expect(wrappers[0].getBuffer).toHaveBeenCalled();
  });
});

describe('Kzpl.abort', () => {
  it('should call abort on every worker', async () => {
    const kzpl = new Kzpl({ url: 'https://example.com/file.zip', multiply: 3 });
    await kzpl.getEntryNames();

    await kzpl.abort('a.txt');

    for (const w of wrappers) {
      expect(w.abort).toHaveBeenCalledWith('a.txt');
    }
  });
});

describe('Kzpl fallback', () => {
  it('should drop co-workers via terminate when first worker triggers onFallback', async () => {
    const kzpl = new Kzpl({ url: 'https://example.com/file.zip', multiply: 3 });
    await kzpl.getEntryNames();
    expect(wrappers).toHaveLength(3);

    wrappers[0].__triggerFallback();
    // fallback 内の Promise chain 消化待ち
    await new Promise((r) => setTimeout(r, 0));

    wrappers[0].getPendingCount.mockReturnValue(0);
    wrappers[0].getBuffer.mockResolvedValue(new ArrayBuffer(3));
    await kzpl.getBuffer('a.txt');
    expect(wrappers[0].getBuffer).toHaveBeenCalled();

    // co-worker は terminate される
    expect(wrappers[1].terminate).toHaveBeenCalled();
    expect(wrappers[2].terminate).toHaveBeenCalled();
  });

  // pending を抱えたままの terminate 経路は WorkerWrapper 単体 (worker-wrapper.test.ts の
  // `should abort every pending entry and then terminate the worker`) で担保する。
  // Kzpl 層で同じことを検証しようとすると WorkerWrapper 全体を差し替えたモックで
  // terminate を no-op にする以外に手が無く、`this` 束縛の退行を捕まえられない
  // 同語反復のテストになってしまうため、ここには置かない。
});

describe('Kzpl.prefetchAll', () => {
  it('should fetch entries strictly sequentially (next only after previous resolves)', async () => {
    // 逐次性 (`for (...) await getBuffer(...)`) を検証する。
    stateOverrides[0] = { entryNames: ['a', 'b', 'c'] };
    const kzpl = new Kzpl({ url: 'https://example.com/file.zip', multiply: 1 });
    await kzpl.getEntryNames();

    const order: string[] = [];
    const resolvers: Array<() => void> = [];
    wrappers[0].getBuffer.mockImplementation(
      (name: string) =>
        new Promise<ArrayBuffer>((resolve) => {
          order.push(`start:${name}`);
          resolvers.push(() => {
            order.push(`end:${name}`);
            resolve(new ArrayBuffer(name.length));
          });
        }),
    );

    const prefetch = kzpl.prefetchAll();
    // prefetchAll → getEntryNames → setupWorkers 解決 → 初回 getBuffer 到達までは
    // 数マイクロタスク必要
    const drain = async () => {
      for (let i = 0; i < 20; i++) await Promise.resolve();
    };
    await drain();
    expect(order).toEqual(['start:a']);

    resolvers[0]();
    await drain();
    expect(order).toEqual(['start:a', 'end:a', 'start:b']);

    resolvers[1]();
    await drain();
    expect(order).toEqual(['start:a', 'end:a', 'start:b', 'end:b', 'start:c']);

    resolvers[2]();
    await prefetch;
    expect(order).toEqual(['start:a', 'end:a', 'start:b', 'end:b', 'start:c', 'end:c']);
  });

  it('should return the same in-flight promise when called twice (dedupe)', async () => {
    stateOverrides[0] = { entryNames: ['a'] };
    const kzpl = new Kzpl({ url: 'https://example.com/file.zip', multiply: 1 });
    await kzpl.getEntryNames();

    let resolveBuf!: (v: ArrayBuffer) => void;
    wrappers[0].getBuffer.mockReturnValue(
      new Promise<ArrayBuffer>((r) => {
        resolveBuf = r;
      }),
    );

    const first = kzpl.prefetchAll();
    const second = kzpl.prefetchAll();
    expect(second).toBe(first);

    resolveBuf(new ArrayBuffer(1));
    await first;
  });

  it('should reset prefetching state on rejection so a retry is possible', async () => {
    // M4 対策: `promise.catch(() => { this.prefetching = undefined; })` が消えると
    // 一度失敗したあと再試行できなくなる (失敗した Promise が返り続ける)。
    stateOverrides[0] = { entryNames: ['a'] };
    const kzpl = new Kzpl({ url: 'https://example.com/file.zip', multiply: 1 });
    await kzpl.getEntryNames();

    wrappers[0].getBuffer.mockRejectedValueOnce(new Error('first-fail'));

    const first = kzpl.prefetchAll();
    await expect(first).rejects.toThrow('first-fail');
    // catch ハンドラが this.prefetching = undefined を実行するまで待つ
    for (let i = 0; i < 5; i++) await Promise.resolve();

    // 2 回目は成功シナリオでリトライできる
    wrappers[0].getBuffer.mockResolvedValueOnce(new ArrayBuffer(4));
    const second = kzpl.prefetchAll();
    expect(second).not.toBe(first);
    await expect(second).resolves.toBeUndefined();
  });
});
