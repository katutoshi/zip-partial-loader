import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import FragmentStorage from './fragment-storage';

// IndexedDB を簡易モック。fragment-storage.ts が touch する API のみ再現。
// - open('lszr', DB_VERSION) → onupgradeneeded は今回はスキップし、成功のみ模擬
// - transaction.objectStore(name).get / .put / .index(...) を再現

type StoreData = Map<string, unknown>;

class MockIDBRequest<T = unknown> {
  public onerror: (() => void) | null = null;
  public onsuccess: (() => void) | null = null;
  public result: T | undefined;
  public error: unknown = null;

  succeed(result: T) {
    this.result = result;
    // async: mimic browser behavior
    queueMicrotask(() => this.onsuccess?.());
  }

  fail(err: unknown) {
    this.error = err;
    queueMicrotask(() => this.onerror?.());
  }
}

class MockIndex {
  constructor(private store: MockObjectStore) {}
  count() {
    const req = new MockIDBRequest<number>();
    req.succeed(this.store.data.size);
    return req;
  }
  openCursor() {
    // 空カーソル (即座に result=null で終了)
    const req = new MockIDBRequest<unknown>();
    req.succeed(null as unknown);
    return req;
  }
}

class MockObjectStore {
  public data: StoreData = new Map();

  get(key: string) {
    const req = new MockIDBRequest();
    req.succeed(this.data.get(key));
    return req;
  }
  put(value: unknown, key: string) {
    this.data.set(key, value);
    const req = new MockIDBRequest();
    req.succeed(key);
    return req;
  }
  index(_name: string) {
    return new MockIndex(this);
  }
}

class MockTransaction {
  public abort = vi.fn();
  constructor(private stores: Record<string, MockObjectStore>) {}
  objectStore(name: string) {
    return this.stores[name];
  }
}

class MockDatabase {
  public stores: Record<string, MockObjectStore> = {
    fragment: new MockObjectStore(),
    group: new MockObjectStore(),
  };
  transaction(_names: string[], _mode: string) {
    return new MockTransaction(this.stores);
  }
}

const openState: { db?: MockDatabase; failOnOpen?: boolean } = {};

function makeOpenRequest(): MockIDBRequest<MockDatabase> {
  const req = new MockIDBRequest<MockDatabase>();
  if (openState.failOnOpen) {
    queueMicrotask(() => req.fail(new Error('open failed')));
  } else {
    const db = new MockDatabase();
    openState.db = db;
    queueMicrotask(() => req.succeed(db));
  }
  // 何らかの upgrade は呼ばない (簡略化)
  (req as any).onupgradeneeded = null;
  return req;
}

beforeEach(() => {
  openState.db = undefined;
  openState.failOnOpen = false;
  (globalThis as any).indexedDB = {
    open: vi.fn(() => makeOpenRequest()),
  };
});

afterEach(() => {
  delete (globalThis as any).indexedDB;
});

describe('FragmentStorage.getFragment', () => {
  it('returns undefined when key does not exist', async () => {
    const storage = new FragmentStorage({ url: 'https://example.com/a.zip' });
    const result = await storage.getFragment('missing');
    expect(result).toBeUndefined();
  });

  it('returns stored buffer when key exists', async () => {
    const storage = new FragmentStorage({ url: 'https://example.com/a.zip' });
    const buf = new ArrayBuffer(8);
    await storage.putFragment('entry-1', buf);
    const result = await storage.getFragment('entry-1');
    expect(result).toBe(buf);
  });

  it('returns undefined when IndexedDB open fails', async () => {
    openState.failOnOpen = true;
    // Silence expected error logs
    const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => {});
    const storage = new FragmentStorage({ url: 'https://example.com/a.zip' });
    const result = await storage.getFragment('anything');
    expect(result).toBeUndefined();
    consoleErr.mockRestore();
  });
});

describe('FragmentStorage.putFragment', () => {
  it('stores buffer under a namespaced key (url:name)', async () => {
    const storage = new FragmentStorage({ url: 'https://example.com/a.zip' });
    const buf = new ArrayBuffer(4);
    await storage.putFragment('foo.txt', buf);

    // fetch back via getFragment (indirect verification of key namespacing)
    const back = await storage.getFragment('foo.txt');
    expect(back).toBe(buf);
  });

  it('is a no-op when IndexedDB open fails', async () => {
    openState.failOnOpen = true;
    const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => {});
    const storage = new FragmentStorage({ url: 'https://example.com/a.zip' });
    await expect(storage.putFragment('foo', new ArrayBuffer(1))).resolves.toBeUndefined();
    consoleErr.mockRestore();
  });
});

describe('FragmentStorage per-url isolation', () => {
  it('same key under different urls does not collide', async () => {
    const a = new FragmentStorage({ url: 'https://a.example.com/z.zip' });
    const b = new FragmentStorage({ url: 'https://b.example.com/z.zip' });

    const bufA = new ArrayBuffer(4);
    const bufB = new ArrayBuffer(8);
    await a.putFragment('shared', bufA);
    await b.putFragment('shared', bufB);

    expect(await a.getFragment('shared')).toBe(bufA);
    expect(await b.getFragment('shared')).toBe(bufB);
  });
});
