import { HttpResponse, http } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { server } from '../test/setup';

// wasm/pkg 実物への依存を回避するためのモック。
// CI の check ジョブでは wasm/pkg が存在しないので、必ずここで vi.mock する。
type RangeMock = { offset: number; size: number; free: () => void };

const wasmInit = vi.fn(async () => ({}));
const rangeConfig = {
  eocd: { offset: 900, size: 100 },
  cd: { offset: 500, size: 100 },
  entries: { 'a.txt': { offset: 0, size: 10 } } as Record<string, { offset: number; size: number }>,
};

vi.mock('../../wasm/pkg/lszr', () => {
  const makeRange = (offset: number, size: number): RangeMock => ({
    offset,
    size,
    free: () => {},
  });
  class LSZR {
    get eocdRange() {
      return makeRange(rangeConfig.eocd.offset, rangeConfig.eocd.size);
    }
    get cdRange() {
      return makeRange(rangeConfig.cd.offset, rangeConfig.cd.size);
    }
    getRange(name: string): RangeMock {
      const cfg = rangeConfig.entries[name];
      if (!cfg) throw new Error(`unknown entry: ${name}`);
      return makeRange(cfg.offset, cfg.size);
    }
    parseCD(_data: Uint8Array): string[] {
      return Object.keys(rangeConfig.entries);
    }
    getData(_name: string, data: Uint8Array): Uint8Array {
      // Simulate: return first N bytes as "extracted"
      return new Uint8Array(data.slice(0, Math.min(data.length, 4)));
    }
  }
  return { default: wasmInit, LSZR };
});

vi.mock('../../wasm/pkg/lszr_bg.wasm', () => ({ default: 'mock-wasm-url' }));

// FragmentStorage をモック (getFragment は常に undefined、putFragment は no-op)
type FragmentStorageMock = {
  getFragment: ReturnType<typeof vi.fn>;
  putFragment: ReturnType<typeof vi.fn>;
};
const storageInstances: FragmentStorageMock[] = [];
const storageBehavior: {
  getFragment?: (name: string) => Promise<ArrayBuffer | undefined>;
} = {};

vi.mock('./fragment-storage', () => {
  class MockStorage {
    constructor(_params: unknown) {
      const inst: FragmentStorageMock = {
        getFragment: vi.fn((name: string) =>
          storageBehavior.getFragment ? storageBehavior.getFragment(name) : Promise.resolve(undefined),
        ),
        putFragment: vi.fn(() => Promise.resolve()),
      };
      storageInstances.push(inst);
      // Assign methods to `this`
      (this as any).getFragment = inst.getFragment;
      (this as any).putFragment = inst.putFragment;
    }
  }
  return { default: MockStorage };
});

// Dynamically import after mocks
let LSZRWrapper: typeof import('./lszr-wrapper').default;
beforeEach(async () => {
  wasmInit.mockClear();
  storageInstances.length = 0;
  storageBehavior.getFragment = undefined;
  vi.resetModules();
  const mod = await import('./lszr-wrapper');
  LSZRWrapper = mod.default;
});

afterEach(() => {
  server.resetHandlers();
});

const TEST_URL = 'https://example.com/file.zip';

function mockRangeServer() {
  server.use(
    http.get(TEST_URL, ({ request }) => {
      const range = request.headers.get('Range');
      if (range === 'bytes=-65557') {
        // EOCD range request. Return 100 bytes from offset 900 (of a 1000-byte file)
        const buf = new Uint8Array(100).fill(0xee);
        return new HttpResponse(buf, {
          status: 206,
          headers: { 'Content-Range': 'bytes 900-999/1000' },
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
  it('resolves entryNames and fallback=false when range requests succeed', async () => {
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

  it('falls back to in-memory cache when server does not support range', async () => {
    const onUpdate = vi.fn();
    // Return 200 (no range support) for the initial range request
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
    // onUpdateState was called during fallback transition
    expect(onUpdate).toHaveBeenCalled();
  });

  it('forceInMemoryCache=true triggers in-memory fallback immediately', async () => {
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
});

describe('LSZRWrapper.getBuffer', () => {
  it('returns data extracted by wasm from a range response', async () => {
    mockRangeServer();
    const wrapper = new LSZRWrapper({
      url: TEST_URL,
      noUseCache: true,
      onUpdateState: () => {},
    });
    await wrapper.getState();

    const controller = new AbortController();
    const data = await wrapper.getBuffer('a.txt', controller.signal);
    expect(data).toBeInstanceOf(Uint8Array);
    expect(data.length).toBeGreaterThan(0);
  });

  it('throws when signal is already aborted', async () => {
    mockRangeServer();
    const wrapper = new LSZRWrapper({
      url: TEST_URL,
      noUseCache: true,
      onUpdateState: () => {},
    });
    await wrapper.getState();

    const controller = new AbortController();
    controller.abort();
    await expect(wrapper.getBuffer('a.txt', controller.signal)).rejects.toBeDefined();
  });

  it('uses cached fragment when storage.getFragment returns data', async () => {
    mockRangeServer();
    storageBehavior.getFragment = (name) => {
      if (name === 'a.txt') return Promise.resolve(new ArrayBuffer(20));
      return Promise.resolve(undefined);
    };
    const wrapper = new LSZRWrapper({
      url: TEST_URL,
      onUpdateState: () => {},
    });
    await wrapper.getState();
    const controller = new AbortController();
    const data = await wrapper.getBuffer('a.txt', controller.signal);
    expect(data).toBeInstanceOf(Uint8Array);
  });
});
