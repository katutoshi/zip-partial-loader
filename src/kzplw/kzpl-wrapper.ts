import init, { KZPL } from '../../wasm/pkg/kzpl.js';
import { type DataChunk, downloadAll, downloadRange } from './downloader';

// WASM 初期化 (一度だけ実行)。
// wasm-pack `--target web` 出力の `init()` は引数を省略すると
// `new URL('kzpl_bg.wasm', import.meta.url)` を自動で解決する。この import.meta.url は
// `wasm/pkg/kzpl.js` 自身のロケーションになるため、消費側の bundler (Vite / webpack 5)
// が kzpl.js を静的解析した時点で `kzpl_bg.wasm` を同ディレクトリに再配置してくれる。
// 以前は webpack の asset/resource 経由で URL 文字列を受け取っていたが、library 側で
// ハッシュ URL を焼き込むと消費側が再配置できず、`dist/*.wasm` を手コピーする "おまじない"
// が必要だった。この経路を丸ごと廃止する。
const wasmReady = init();

import { RangeNotSupportedError } from '../error';
import type { WorkerState } from '../types';
import { throwIfAbort } from '../util/abort';
import FragmentStorage from './fragment-storage';

const EOCD_ENTRY_NAME = ':eocd';
const CD_ENTRY_NAME = ':cd';

export default class KZPLWrapper {
  private state: WorkerState;
  // prepare() の中で失敗時に undefined を戻す再入経路があるため、
  // 型的にも `| undefined` (= optional) として宣言しておく。
  private init?: Promise<KZPL>;
  private inMemoryCache?: Promise<ArrayBuffer>;
  private storage?: FragmentStorage;

  public constructor(
    private params: {
      url: string;
      noUseCache?: boolean;
      forceKeepCache?: boolean;
      forceInMemoryCache?: boolean;
      onUpdateState: (state: WorkerState) => void;
    },
  ) {
    this.state = {
      entryNames: [],
      fallback: false,
    };
    if (!params.noUseCache) {
      this.storage = new FragmentStorage({
        url: params.url,
        forceKeepCache: params.forceKeepCache,
      });
    }
    this.prepare();
  }

  private prepare(): Promise<KZPL> {
    if (this.init) {
      return this.init;
    }
    const promise = (async () => {
      // WASM初期化を待つ
      await wasmReady;
      const eocdCacheData = this.storage && (await this.storage.getFragment(EOCD_ENTRY_NAME));
      const cdCacheData = this.storage && (await this.storage.getFragment(CD_ENTRY_NAME));
      let eocdData = eocdCacheData;
      let cdData = cdCacheData;
      let lastChunk: DataChunk | undefined;
      let inMemoryCache: ArrayBuffer | undefined;

      if (!eocdData) {
        try {
          if (this.params.forceInMemoryCache) {
            // force fallback
            throw new RangeNotSupportedError();
          }
          lastChunk = await downloadRange(this.params.url, 'bytes=-65557');
          eocdData = lastChunk[0];
        } catch (err) {
          if (!(err instanceof RangeNotSupportedError)) {
            throw err;
          }
          inMemoryCache = await this.cacheInMemory();
          const start = inMemoryCache.byteLength - 65557;
          eocdData = inMemoryCache.slice(inMemoryCache.byteLength - 65557);
          lastChunk = [eocdData, start];
        }
      }
      const uzr = new KZPL(new Uint8Array(eocdData));

      if (!eocdCacheData) {
        const eocdRange = uzr.eocdRange;
        const { offset, size } = eocdRange;
        const start = offset;
        const end = start + size;
        eocdRange.free();

        // 不変条件: !eocdCacheData のときは直上の `if (!eocdData)` 分岐が走り
        // lastChunk は必ず代入済み。TS は前提を追えないので non-null assertion で示す。
        // biome-ignore lint/style/noNonNullAssertion: 直上の条件分岐で必ず代入される不変条件
        eocdData = lastChunk![0].slice(start, end);
        if (this.storage) {
          await this.storage.putFragment(EOCD_ENTRY_NAME, eocdData).catch(console.warn);
        }
      }

      if (!cdData) {
        const subRange = uzr.cdRange;
        const { offset, size } = subRange;
        subRange.free();

        if (lastChunk && offset > lastChunk[1]) {
          const start = offset - lastChunk[1];
          const end = start + size;
          cdData = lastChunk[0].slice(start, end);
        } else {
          const start = offset;
          const end = offset + size;

          if (inMemoryCache) {
            cdData = inMemoryCache.slice(start, end + 1);
          } else {
            try {
              [cdData] = await downloadRange(this.params.url, `bytes=${start}-${end}`);
            } catch (err) {
              if (!(err instanceof RangeNotSupportedError)) {
                throw err;
              }
              inMemoryCache = await this.cacheInMemory();
              cdData = inMemoryCache.slice(start, end + 1);
            }
          }
        }
        if (this.storage) {
          await this.storage.putFragment(CD_ENTRY_NAME, cdData).catch(console.warn);
        }
      }

      const entryNames = uzr.parseCD(new Uint8Array(cdData));
      const fallback = !!inMemoryCache;

      this.state = {
        entryNames,
        fallback,
      };

      return uzr;
    })();
    promise.catch(() => {
      this.init = undefined;
    });
    this.init = promise;
    return promise;
  }

  public getState(): Promise<WorkerState> {
    return this.prepare().then(() => this.state);
  }

  public getBuffer(name: string, signal: AbortSignal): Promise<Uint8Array> {
    const promise = this.prepare().then(async (uzr) => {
      throwIfAbort(signal);
      const exists = this.storage && (await this.storage.getFragment(name, signal));
      if (exists) {
        throwIfAbort(signal);
        const data = uzr.getData(name, new Uint8Array(exists));
        throwIfAbort(signal);
        return data;
      }
      const range = uzr.getRange(name);
      const start = range.offset;
      const end = start + range.size;
      range.free();
      let buff: ArrayBuffer;

      if (this.state.fallback) {
        // 不変条件: fallback=true は cacheInMemory() 経由でしか立たず、
        // その中で this.inMemoryCache が必ずセットされる。
        // biome-ignore lint/style/noNonNullAssertion: fallback=true と inMemoryCache セットは同時に立つ
        const inMemoryCache = await this.inMemoryCache!;
        buff = inMemoryCache.slice(start, end + 1);
      } else {
        try {
          [buff] = await downloadRange(this.params.url, `bytes=${start}-${end}`, signal);
        } catch (err) {
          if (!(err instanceof RangeNotSupportedError)) {
            throw err;
          }
          const inMemoryCache = await this.cacheInMemory();
          buff = inMemoryCache.slice(start, end + 1);
        }
      }
      if (this.storage) {
        this.storage.putFragment(name, buff).catch(console.warn);
      }
      throwIfAbort(signal);
      const data = uzr.getData(name, new Uint8Array(buff));
      throwIfAbort(signal);
      return data;
    });

    return promise;
  }

  private cacheInMemory(): Promise<ArrayBuffer> {
    if (this.inMemoryCache) {
      return this.inMemoryCache;
    }
    this.setState({
      ...this.state,
      fallback: true,
    });
    const promise = downloadAll(this.params.url);
    promise.catch((err) => {
      console.warn(err);
      this.inMemoryCache = undefined;
    });
    promise
      .then(async (inMemoryCache) => {
        const uzr = await this.prepare();
        this.state.entryNames.forEach((name) => {
          const range = uzr.getRange(name);
          const start = range.offset;
          const end = start + range.size;
          range.free();
          const buff = inMemoryCache.slice(start, end + 1);
          if (this.storage) {
            this.storage.putFragment(name, buff).catch(console.warn);
          }
        });
      })
      // promise が reject した場合、機能面の後始末 (this.inMemoryCache = undefined)
      // は直上の promise.catch が担う。ここでの catch は、その catch ハンドラを
      // 経由してもなお .then チェーンに残る「未 catch な rejection」を握りつぶす
      // ための空 catch。無いと Node ≥ 15 では unhandled rejection でプロセスが
      // 落ちる (テストランナーでも false positive を招く)。err の再ハンドリングは
      // 不要 (上の .catch で console.warn 済み) なので何もしない。
      .catch(() => {});
    this.inMemoryCache = promise;
    return promise;
  }

  private setState(state: WorkerState) {
    this.state = state;
    this.params.onUpdateState(state);
  }
}
