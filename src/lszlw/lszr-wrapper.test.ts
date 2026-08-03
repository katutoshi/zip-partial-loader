import { HttpResponse, http } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { server } from '../test/setup';

// wasm/pkg 実物への依存を回避するためのモック。
// CI の check ジョブでは wasm/pkg が存在しないため必須。
type RangeMock = { offset: number; size: number; free: () => void };

const wasmInit = vi.fn(async () => ({}));

// LSZR モックの挙動設定
// eocdRange / cdRange の offset は「lastChunk 内の相対オフセット」を返す
// (lszr-wrapper.ts の `lastChunk[0].slice(start, end)` のセマンティクスに合わせる)。
// getRange の offset はファイル絶対 (`bytes=${start}-${end}` に使う)。
const rangeConfig: {
  eocd: RangeMock;
  cd: RangeMock;
  entries: Record<string, { offset: number; size: number }>;
  getDataImpl: (name: string, data: Uint8Array) => Uint8Array;
} = {
  eocd: { offset: 978, size: 22, free: () => {} }, // chunk 相対 (chunk は 1000 バイト想定)
  cd: { offset: 500, size: 100, free: () => {} }, // chunk 相対 (chunk[1]=0 前提)
  entries: { 'a.txt': { offset: 100, size: 10 } },
  getDataImpl: (_name, data) => new Uint8Array(data.slice(0, 4)),
};

vi.mock('../../wasm/pkg/lszr', () => {
  const cloneRange = (r: RangeMock): RangeMock => ({
    offset: r.offset,
    size: r.size,
    free: () => {},
  });
  class LSZR {
    get eocdRange() {
      return cloneRange(rangeConfig.eocd);
    }
    get cdRange() {
      return cloneRange(rangeConfig.cd);
    }
    getRange(name: string): RangeMock {
      const cfg = rangeConfig.entries[name];
      if (!cfg) throw new Error(`unknown entry: ${name}`);
      return { offset: cfg.offset, size: cfg.size, free: () => {} };
    }
    parseCD(_data: Uint8Array): string[] {
      return Object.keys(rangeConfig.entries);
    }
    getData(name: string, data: Uint8Array): Uint8Array {
      return rangeConfig.getDataImpl(name, data);
    }
  }
  return { default: wasmInit, LSZR };
});

// FragmentStorage の挙動もテスト毎に差し替え可能な形にする
const storageBehavior: {
  getFragment?: (name: string) => Promise<ArrayBuffer | undefined>;
  putCalls: Array<{ name: string; buffer: ArrayBuffer }>;
} = { putCalls: [] };

vi.mock('./fragment-storage', () => {
  class MockStorage {
    // biome-ignore lint/complexity/noUselessConstructor: パラメータ受け取り目的
    constructor(_params: unknown) {}
    getFragment(name: string) {
      return storageBehavior.getFragment ? storageBehavior.getFragment(name) : Promise.resolve(undefined);
    }
    putFragment(name: string, buffer: ArrayBuffer) {
      storageBehavior.putCalls.push({ name, buffer });
      return Promise.resolve();
    }
  }
  return { default: MockStorage };
});

let LSZRWrapper: typeof import('./lszr-wrapper').default;

beforeEach(async () => {
  wasmInit.mockClear();
  storageBehavior.getFragment = undefined;
  storageBehavior.putCalls = [];
  // 設定はテスト毎にデフォルトへ戻す
  rangeConfig.eocd = { offset: 978, size: 22, free: () => {} };
  rangeConfig.cd = { offset: 500, size: 100, free: () => {} };
  rangeConfig.entries = { 'a.txt': { offset: 100, size: 10 } };
  rangeConfig.getDataImpl = (_name, data) => new Uint8Array(data.slice(0, 4));
  vi.resetModules();
  const mod = await import('./lszr-wrapper');
  LSZRWrapper = mod.default;
});

afterEach(() => {
  server.resetHandlers();
});

const TEST_URL = 'https://example.com/file.zip';

/**
 * 1000バイトのZIPを模擬する MSW ハンドラ。
 * - suffix range (bytes=-65557): ファイルサイズ (1000) 以下しかないので実質全体を返す
 *   (RFC 7233: サフィックス長がファイル長を超える場合は全体で応答)。
 *   Content-Range: bytes 0-999/1000
 * - 通常の bytes=start-end: 該当バイトを 0xcc で埋めて返す
 */
function mockRangeServer() {
  server.use(
    http.get(TEST_URL, ({ request }) => {
      const range = request.headers.get('Range');
      if (range === 'bytes=-65557') {
        const buf = new Uint8Array(1000);
        // EOCD 領域を 0xee で埋め、CD 領域を 0xcd で埋めておく (キャッシュ内容を検証可能に)
        for (let i = 978; i < 1000; i++) buf[i] = 0xee;
        for (let i = 500; i < 600; i++) buf[i] = 0xcd;
        return new HttpResponse(buf, {
          status: 206,
          headers: { 'Content-Range': 'bytes 0-999/1000' },
        });
      }
      const match = range?.match(/bytes=(\d+)-(\d+)/);
      if (match) {
        const start = parseInt(match[1], 10);
        const end = parseInt(match[2], 10);
        const size = end - start + 1;
        const buf = new Uint8Array(size).fill(0xcc);
        return new HttpResponse(buf, {
          status: 206,
          headers: { 'Content-Range': `bytes ${start}-${end}/1000` },
        });
      }
      return new HttpResponse(null, { status: 400 });
    }),
  );
}

describe('LSZRWrapper.getState', () => {
  it('should resolve entryNames and fallback=false when range requests succeed', async () => {
    mockRangeServer();
    const wrapper = new LSZRWrapper({
      url: TEST_URL,
      noUseCache: true,
      onUpdateState: () => {},
    });
    const state = await wrapper.getState();
    expect(state.entryNames).toEqual(['a.txt']);
    expect(state.fallback).toBe(false);
  });

  it('should fall back to in-memory cache when server does not support range', async () => {
    const onUpdate = vi.fn();
    server.use(
      http.get(TEST_URL, () => {
        return new HttpResponse(new Uint8Array(1000).fill(0xaa), { status: 200 });
      }),
    );

    const wrapper = new LSZRWrapper({
      url: TEST_URL,
      noUseCache: true,
      onUpdateState: onUpdate,
    });
    const state = await wrapper.getState();
    expect(state.fallback).toBe(true);
    expect(onUpdate).toHaveBeenCalled();
  });

  it('should trigger in-memory fallback immediately when forceInMemoryCache=true', async () => {
    server.use(http.get(TEST_URL, () => new HttpResponse(new Uint8Array(1000).fill(0xaa), { status: 200 })));
    const wrapper = new LSZRWrapper({
      url: TEST_URL,
      noUseCache: true,
      forceInMemoryCache: true,
      onUpdateState: () => {},
    });
    const state = await wrapper.getState();
    expect(state.fallback).toBe(true);
  });

  it('should cache the EOCD chunk contents (not an empty slice) after successful init', async () => {
    // C9 対策: eocd の offset を chunk 相対に揃えていないと slice が空になり、
    // 空バッファがキャッシュされる。ここでは実際のキャッシュ内容を検証する。
    mockRangeServer();
    const wrapper = new LSZRWrapper({
      url: TEST_URL,
      onUpdateState: () => {},
    });
    await wrapper.getState();

    // :eocd キャッシュに書かれた 22 バイトが全て 0xee であること
    const eocdPut = storageBehavior.putCalls.find((c) => c.name === ':eocd');
    expect(eocdPut).toBeDefined();
    // biome-ignore lint/style/noNonNullAssertion: 直上の toBeDefined で保証
    const bytes = new Uint8Array(eocdPut!.buffer);
    expect(bytes.length).toBe(22);
    expect(bytes.every((b) => b === 0xee)).toBe(true);
  });
});

describe('LSZRWrapper.getBuffer', () => {
  it('should return bytes extracted from network response by default', async () => {
    mockRangeServer();
    const wrapper = new LSZRWrapper({
      url: TEST_URL,
      noUseCache: true,
      onUpdateState: () => {},
    });
    await wrapper.getState();

    const controller = new AbortController();
    const data = await wrapper.getBuffer('a.txt', controller.signal);
    // ネットワーク経路: 0xcc で埋まった 4 バイト (getDataImpl は data.slice(0, 4))
    expect(Array.from(data)).toEqual([0xcc, 0xcc, 0xcc, 0xcc]);
  });

  it('should throw AbortError from throwIfAbort when signal is already aborted', async () => {
    // A3 対策: 単に何か reject するだけでは throwIfAbort ミュータント(E2)を検出できない。
    // ネットワーク層は正常応答を返すため、fetch 由来の DOMException ではなく
    // util/abort の AbortError クラスが投げられていることを検証する。
    mockRangeServer();
    const wrapper = new LSZRWrapper({
      url: TEST_URL,
      noUseCache: true,
      onUpdateState: () => {},
    });
    await wrapper.getState();

    const controller = new AbortController();
    controller.abort();

    // vi.resetModules() で AbortError クラスが毎回別インスタンスになるので、
    // 名前とコンストラクタ名の両方で「util/abort の AbortError」を特定する
    // (fetch 由来の DOMException は constructor.name が 'DOMException')。
    const err = await wrapper.getBuffer('a.txt', controller.signal).then(
      () => {
        throw new Error('expected rejection');
      },
      (e) => e,
    );
    expect((err as any)?.name).toBe('AbortError');
    expect((err as any)?.constructor?.name).toBe('AbortError');
    expect(err).not.toBeInstanceOf(Error); // util/abort の AbortError は Error を継承していない
  });

  it('should notify onUpdateState with fallback:true when RangeNotSupportedError triggers in-memory fallback', async () => {
    // 未テスト経路: RangeNotSupportedError -> cacheInMemory の setState 経路。
    // "呼ばれたこと" だけでは fallback フラグ有無を検出できないので、payload を検証する。
    server.use(
      http.get(TEST_URL, () => {
        // status 200 = Range 未サポート応答。downloadRange が RangeNotSupportedError を投げる。
        return new HttpResponse(new Uint8Array(1000).fill(0xaa), { status: 200 });
      }),
    );

    const onUpdate = vi.fn();
    const wrapper = new LSZRWrapper({
      url: TEST_URL,
      noUseCache: true,
      onUpdateState: onUpdate,
    });
    const state = await wrapper.getState();

    // 状態自体が fallback:true になっていること
    expect(state.fallback).toBe(true);

    // onUpdateState が fallback:true 付きの payload で呼ばれた回が
    // 少なくとも 1 回存在すること (payload を実際に検証)
    const fallbackCalls = onUpdate.mock.calls.filter(
      ([s]: [{ fallback: boolean }]) => s.fallback === true,
    );
    expect(fallbackCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('should reset this.init on prepare() failure and allow retry on subsequent call', async () => {
    // 未テスト経路: prepare() 失敗 -> `this.init = undefined` -> 次回 prepare() で再試行可能。
    // 1回目は downloadRange が Content-Range 欠落で "Content-Range not found." を投げて
    // prepare が RangeNotSupportedError ではない例外で reject する (fallback 経路には
    // 入らないため、cacheInMemory の未 catch な .then 副作用 (別バグ) を避けられる)。
    // 2回目はサーバを正常な 206 応答に差し替えて再試行が通ることを実挙動で検証する。
    let firstCall = true;
    server.use(
      http.get(TEST_URL, ({ request }) => {
        if (firstCall) {
          firstCall = false;
          // status=206 だが Content-Range ヘッダ無し → downloadRange 内で
          // 'Content-Range not found.' が throw され、prepare の catch では
          // RangeNotSupportedError ではないので再 throw されて promise が reject する。
          return new HttpResponse(new Uint8Array(22), { status: 206 });
        }
        // 2回目以降は mockRangeServer 相当の正常応答
        const range = request.headers.get('Range');
        if (range === 'bytes=-65557') {
          const buf = new Uint8Array(1000);
          for (let i = 978; i < 1000; i++) buf[i] = 0xee;
          for (let i = 500; i < 600; i++) buf[i] = 0xcd;
          return new HttpResponse(buf, {
            status: 206,
            headers: { 'Content-Range': 'bytes 0-999/1000' },
          });
        }
        const match = range?.match(/bytes=(\d+)-(\d+)/);
        if (match) {
          const start = parseInt(match[1], 10);
          const end = parseInt(match[2], 10);
          const size = end - start + 1;
          return new HttpResponse(new Uint8Array(size).fill(0xcc), {
            status: 206,
            headers: { 'Content-Range': `bytes ${start}-${end}/1000` },
          });
        }
        return new HttpResponse(null, { status: 400 });
      }),
    );

    const wrapper = new LSZRWrapper({
      url: TEST_URL,
      noUseCache: true,
      onUpdateState: () => {},
    });

    // 1回目は必ず失敗する
    await expect(wrapper.getState()).rejects.toThrow(/Content-Range not found/);

    // マイクロタスクを進めて、prepare の promise.catch(() => { this.init = undefined; })
    // ハンドラを確実に実行させる (this.init のリセットが `this.init = promise` より
    // 後ろに登録された経路のため、await での rejects 検出だけでは順序が保証されない)。
    await Promise.resolve();
    await Promise.resolve();

    // 2回目の呼び出しで prepare() が新しい promise を作って再試行できることを検証。
    // this.init が undefined にリセットされていなければ、rejected な旧 promise が
    // そのまま返って再度 rejects.toThrow するはず。
    const state = await wrapper.getState();
    expect(state.entryNames).toEqual(['a.txt']);
    expect(state.fallback).toBe(false);
  });

  it('should return CACHED bytes (not network bytes) when storage has the fragment', async () => {
    // A2 対策: 内容比較でキャッシュ経路とネットワーク経路を区別。
    // キャッシュ経路が短絡されるミュータント(E1)を確実に検出する。
    mockRangeServer();
    storageBehavior.getFragment = (name) => {
      if (name === 'a.txt') return Promise.resolve(new Uint8Array([1, 2, 3, 4]).buffer);
      return Promise.resolve(undefined);
    };
    const wrapper = new LSZRWrapper({
      url: TEST_URL,
      onUpdateState: () => {},
    });
    await wrapper.getState();
    const controller = new AbortController();
    const data = await wrapper.getBuffer('a.txt', controller.signal);
    // キャッシュ経由なら [1,2,3,4] (getDataImpl は data.slice(0, 4))
    expect(Array.from(data)).toEqual([1, 2, 3, 4]);
  });
});
