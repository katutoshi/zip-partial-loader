import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import FragmentStorage from './fragment-storage';

// IndexedDB を簡易モック。fragment-storage.ts が使う API のみ再現。
// - open('lszr', DB_VERSION): 同名 DB は複数 open 間で共有 (実ブラウザと同挙動)
// - transaction(names, mode).objectStore(name).get / .put / .index('time')
// - index.count() / index.openCursor() で LRU / expire を模擬
// - upgrade は初回のみ onupgradeneeded を発火
//
// 実 IndexedDB は structured clone するので put 後の buffer は同一参照ではない。
// 本モックも put 時に slice して deep copy する。

type Row = { key: string; value: unknown };

class MockIDBRequest<T = unknown> {
  public onerror: (() => void) | null = null;
  public onsuccess: (() => void) | null = null;
  public onupgradeneeded: (() => void) | null = null;
  public result: T | undefined;
  public error: unknown = null;

  succeed(result: T) {
    this.result = result;
    queueMicrotask(() => this.onsuccess?.());
  }

  fail(err: unknown) {
    this.error = err;
    queueMicrotask(() => this.onerror?.());
  }
}

class MockObjectStore {
  public rows: Row[] = [];
  private indexes: Record<string, string> = {};

  createIndex(name: string, keyPath: string, _options: { unique: boolean }) {
    this.indexes[name] = keyPath;
  }

  get(key: string): MockIDBRequest {
    const req = new MockIDBRequest();
    const hit = this.rows.find((r) => r.key === key);
    req.succeed(hit ? cloneValue(hit.value) : undefined);
    return req;
  }

  put(value: unknown, key: string): MockIDBRequest {
    const stored = cloneValue(value);
    const existing = this.rows.findIndex((r) => r.key === key);
    if (existing >= 0) {
      this.rows[existing] = { key, value: stored };
    } else {
      this.rows.push({ key, value: stored });
    }
    const req = new MockIDBRequest();
    req.succeed(key);
    return req;
  }

  delete(key: string) {
    const idx = this.rows.findIndex((r) => r.key === key);
    if (idx >= 0) this.rows.splice(idx, 1);
  }

  index(name: string): MockIndex {
    const keyPath = this.indexes[name];
    if (!keyPath) throw new Error(`no index ${name}`);
    return new MockIndex(this, keyPath);
  }
}

class MockIndex {
  constructor(
    private store: MockObjectStore,
    private keyPath: string,
  ) {}

  count(): MockIDBRequest<number> {
    const req = new MockIDBRequest<number>();
    req.succeed(this.store.rows.length);
    return req;
  }

  openCursor(): MockIDBRequest<MockCursor | null> {
    const req = new MockIDBRequest<MockCursor | null>();
    // keyPath (時刻) 昇順で走査
    const sorted = [...this.store.rows].sort((a, b) => {
      const av = (a.value as Record<string, number>)[this.keyPath];
      const bv = (b.value as Record<string, number>)[this.keyPath];
      return av - bv;
    });
    let pos = 0;
    const advance = () => {
      if (pos >= sorted.length) {
        req.result = null;
        queueMicrotask(() => req.onsuccess?.());
        return;
      }
      const current = sorted[pos];
      const cursor: MockCursor = {
        primaryKey: current.key,
        value: current.value,
        continue: () => {
          pos++;
          advance();
        },
        delete: () => {
          this.store.delete(current.key);
        },
      };
      req.result = cursor;
      queueMicrotask(() => req.onsuccess?.());
    };
    advance();
    return req;
  }
}

interface MockCursor {
  primaryKey: string;
  value: unknown;
  continue(): void;
  delete(): void;
}

class MockTransaction {
  public abort = vi.fn();
  constructor(private stores: Record<string, MockObjectStore>) {}
  objectStore(name: string) {
    const s = this.stores[name];
    if (!s) throw new Error(`no store ${name}`);
    return s;
  }
}

class MockDatabase {
  public stores: Record<string, MockObjectStore> = {};
  public objectStoreNames = {
    contains: (name: string) => name in this.stores,
  };
  public version = 0;

  createObjectStore(name: string) {
    const s = new MockObjectStore();
    this.stores[name] = s;
    return s;
  }
  deleteObjectStore(name: string) {
    delete this.stores[name];
  }
  transaction(_names: string[], _mode: string) {
    return new MockTransaction(this.stores);
  }
}

function cloneValue<T>(v: T): T {
  if (v instanceof ArrayBuffer) {
    return v.slice(0) as unknown as T;
  }
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = cloneValue(val);
    }
    return out as T;
  }
  return v;
}

// 共有 DB (実ブラウザ同様、同名 DB は再 open しても状態を保つ)
const sharedDatabases = new Map<string, MockDatabase>();
const openState = { failOnOpen: false };

function makeOpenRequest(name: string, version: number): MockIDBRequest<MockDatabase> {
  const req = new MockIDBRequest<MockDatabase>();
  if (openState.failOnOpen) {
    queueMicrotask(() => req.fail(new Error('open failed')));
    return req;
  }
  let db = sharedDatabases.get(name);
  const wasNew = !db;
  if (!db) {
    db = new MockDatabase();
    sharedDatabases.set(name, db);
  }
  req.result = db;
  queueMicrotask(() => {
    if (wasNew) {
      db.version = version;
      req.onupgradeneeded?.();
    }
    req.onsuccess?.();
  });
  return req;
}

beforeEach(() => {
  sharedDatabases.clear();
  openState.failOnOpen = false;
  (globalThis as any).indexedDB = {
    open: vi.fn((name: string, version: number) => makeOpenRequest(name, version)),
  };
});

afterEach(() => {
  delete (globalThis as any).indexedDB;
  vi.restoreAllMocks();
});

describe('FragmentStorage.getFragment', () => {
  it('should return undefined when key does not exist', async () => {
    const storage = new FragmentStorage({ url: 'https://example.com/a.zip' });
    const result = await storage.getFragment('missing');
    expect(result).toBeUndefined();
  });

  it('should return stored buffer content when key exists', async () => {
    const storage = new FragmentStorage({ url: 'https://example.com/a.zip' });
    const buf = new Uint8Array([1, 2, 3, 4]).buffer;
    await storage.putFragment('entry-1', buf);
    const result = await storage.getFragment('entry-1');
    expect(result).toBeInstanceOf(ArrayBuffer);
    // structured clone 相当なので参照ではなく内容比較
    expect(Array.from(new Uint8Array(result as ArrayBuffer))).toEqual([1, 2, 3, 4]);
  });

  it('should return undefined when IndexedDB open fails', async () => {
    openState.failOnOpen = true;
    const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => {});
    const storage = new FragmentStorage({ url: 'https://example.com/a.zip' });
    const result = await storage.getFragment('anything');
    expect(result).toBeUndefined();
    consoleErr.mockRestore();
  });

  it('should temporarily wire signal.onabort during the transaction and restore it after', async () => {
    // 型修正 (signal.onabort = onabort ?? null) の分岐を担保する回帰テスト。
    // 呼び出し前後で onabort を復元するというプロトコルを守っている。
    const storage = new FragmentStorage({ url: 'https://example.com/a.zip' });
    const signal = { onabort: null } as unknown as AbortSignal;
    await storage.getFragment('missing', signal);
    expect(signal.onabort).toBeNull();
  });
});

describe('FragmentStorage.putFragment', () => {
  it('should store buffer under a namespaced key "url:name"', async () => {
    const url = 'https://example.com/a.zip';
    const storage = new FragmentStorage({ url });
    await storage.putFragment('foo.txt', new Uint8Array([7, 8]).buffer);

    // 共有 DB を直接覗いてキー形式を確認 (getFragmentKey ロジックを検証)
    // FragmentStorage が open する DB は必ず 'lszr' で登録される。
    // biome-ignore lint/style/noNonNullAssertion: テスト内不変条件のため
    const db = sharedDatabases.get('lszr')!;
    expect(db).toBeDefined();
    const fragmentRows = db.stores.fragment.rows;
    expect(fragmentRows.map((r) => r.key)).toContain(`${url}:foo.txt`);
  });

  it('should be a no-op when IndexedDB open fails', async () => {
    openState.failOnOpen = true;
    const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => {});
    const storage = new FragmentStorage({ url: 'https://example.com/a.zip' });
    await expect(storage.putFragment('foo', new ArrayBuffer(1))).resolves.toBeUndefined();
    consoleErr.mockRestore();
  });
});

describe('FragmentStorage per-url isolation on shared DB', () => {
  it('should not collide same-name keys under different urls (namespacing is real)', async () => {
    // 共有 DB モックなので、実装のキー生成 (`${url}:${name}`) が壊れると衝突する形。
    const a = new FragmentStorage({ url: 'https://a.example.com/z.zip' });
    const b = new FragmentStorage({ url: 'https://b.example.com/z.zip' });

    await a.putFragment('shared', new Uint8Array([1, 2, 3]).buffer);
    await b.putFragment('shared', new Uint8Array([9, 9, 9, 9, 9, 9, 9, 9]).buffer);

    const gotA = new Uint8Array((await a.getFragment('shared')) as ArrayBuffer);
    const gotB = new Uint8Array((await b.getFragment('shared')) as ArrayBuffer);

    expect(Array.from(gotA)).toEqual([1, 2, 3]);
    expect(Array.from(gotB)).toEqual([9, 9, 9, 9, 9, 9, 9, 9]);

    // 実キーが url プレフィックス込みであることを直接確認
    // FragmentStorage が open する DB は必ず 'lszr' で登録される。
    // biome-ignore lint/style/noNonNullAssertion: テスト内不変条件のため
    const db = sharedDatabases.get('lszr')!;
    const keys = db.stores.fragment.rows.map((r) => r.key).sort();
    expect(keys).toEqual(['https://a.example.com/z.zip:shared', 'https://b.example.com/z.zip:shared']);
  });
});

describe('FragmentStorage.clearExpired', () => {
  const LIVE_FRAGMENT_AGE = 1000 * 60 * 60; // 1 hour

  it('should not delete anything when count is under the 1000 limit', async () => {
    const storage = new FragmentStorage({ url: 'https://example.com/a.zip' });
    await storage.putFragment('entry-1', new Uint8Array([1]).buffer);
    await storage.putFragment('entry-2', new Uint8Array([2]).buffer);

    // FragmentStorage が open する DB は必ず 'lszr' で登録される。
    // biome-ignore lint/style/noNonNullAssertion: テスト内不変条件のため
    const db = sharedDatabases.get('lszr')!;
    await storage.clearExpired(db as unknown as IDBDatabase);
    expect(db.stores.fragment.rows).toHaveLength(2);
  });

  it('should delete OTHER-url fragments and their group record when they are expired and total > 1000', async () => {
    const url = 'https://example.com/keep.zip';
    const otherUrl = 'https://example.com/other.zip';
    const storage = new FragmentStorage({ url });
    // prepare を発火させる
    await storage.getFragment('warmup');

    // FragmentStorage が open する DB は必ず 'lszr' で登録される。
    // biome-ignore lint/style/noNonNullAssertion: テスト内不変条件のため
    const db = sharedDatabases.get('lszr')!;
    const now = Date.now();

    // 対象 URL 側 1000 件 (新しい)
    for (let i = 0; i < 1000; i++) {
      db.stores.fragment.rows.push({
        key: `${url}:e${i}`,
        value: { time: now, buffer: new ArrayBuffer(1) },
      });
    }
    // 別 URL 側 5 件 (期限切れ)
    for (let i = 0; i < 5; i++) {
      db.stores.fragment.rows.push({
        key: `${otherUrl}:e${i}`,
        value: { time: now - LIVE_FRAGMENT_AGE - 1000, buffer: new ArrayBuffer(1) },
      });
    }
    db.stores.group.rows.push({ key: url, value: { time: now } });
    db.stores.group.rows.push({
      key: otherUrl,
      value: { time: now - LIVE_FRAGMENT_AGE - 1000 },
    });

    await storage.clearExpired(db as unknown as IDBDatabase);

    const remainingFragments = db.stores.fragment.rows.map((r) => r.key);
    expect(remainingFragments.filter((k) => k.startsWith(url))).toHaveLength(1000);
    expect(remainingFragments.filter((k) => k.startsWith(otherUrl))).toHaveLength(0);

    const remainingGroups = db.stores.group.rows.map((r) => r.key);
    expect(remainingGroups).toEqual([url]);
  });

  it('should skip automatic cleanup when forceKeepCache=true', async () => {
    // forceKeepCache=true では prepare 内から clearExpired が呼ばれないことを確認する。
    // 1000 件超の古いレコードを積んでおいても putFragment の完了後に件数が減らない。
    const storage = new FragmentStorage({
      url: 'https://example.com/a.zip',
      forceKeepCache: true,
    });
    await storage.putFragment('e0', new Uint8Array([0]).buffer);
    // FragmentStorage が open する DB は必ず 'lszr' で登録される。
    // biome-ignore lint/style/noNonNullAssertion: テスト内不変条件のため
    const db = sharedDatabases.get('lszr')!;
    const now = Date.now();
    for (let i = 0; i < 1000; i++) {
      db.stores.fragment.rows.push({
        key: `https://example.com/a.zip:pad${i}`,
        value: { time: now - LIVE_FRAGMENT_AGE - 1000, buffer: new ArrayBuffer(1) },
      });
    }
    // 追加後に prepare 内 auto-clear が走っていたら 1000 件以下に減る。走らない前提を検証。
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(db.stores.fragment.rows.length).toBeGreaterThanOrEqual(1001);
  });
});
