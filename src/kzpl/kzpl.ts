import WorkerWrapper from './worker-wrapper';

const LANE_MULTIPLY = 4;

export default class Kzpl {
  public readonly url: string;
  private setupWorkers: Promise<WorkerWrapper[]>;
  private prefetching?: Promise<void>;
  constructor(
    private params: {
      url: string;
      // Worker JS のパス上書き。通常は指定不要 (bundler が自動配置)。
      // 詳細は worker-wrapper.ts の DEFAULT_WORKER_URL のコメント参照。
      worker?: string | URL;
      multiply?: number;
      forceInMemoryCache?: boolean;
      forceKeepCache?: boolean;
    },
  ) {
    const url = new URL(params.url, window.location.href).href;
    this.url = url;

    this.setupWorkers = (async () => {
      const firstWorker = new WorkerWrapper({
        url,
        worker: this.params.worker,
        noUseCache: false,
        forceInMemoryCache: this.params.forceInMemoryCache,
        forceKeepCache: this.params.forceKeepCache,
      });
      const state = await firstWorker.getState();
      if (state.fallback) {
        return [firstWorker];
      }
      firstWorker.onFallback = () => this.fallback(firstWorker);
      const workers = [firstWorker];
      const multiply = (params.multiply && Math.max(params.multiply, 1)) || LANE_MULTIPLY;
      // co-worker を (multiply - 1) 個生成する。
      // 回数指定ループは index 比較の C スタイル for が最も直接的。
      // 小数 multiply (例: 2.5) のとき旧実装から挙動を変えないため
      // index < multiply の比較をそのまま維持する (ceil(multiply) - 1 回回る)。
      // 回数ループの for...of (Array.from) 化は使い捨て配列の確保を招くだけで
      // 利点がないため、あえて導入しない。
      for (let index = 1; index < multiply; index++) {
        const coworker = new WorkerWrapper({
          url,
          worker: this.params.worker,
          noUseCache: false,
          forceKeepCache: true,
        });
        coworker.onFallback = () => this.fallback(coworker);
        workers.push(coworker);
      }
      return workers;
    })();
  }

  public prefetchAll = (): Promise<void> => {
    if (this.prefetching) {
      return this.prefetching;
    }
    const promise = (async () => {
      const names = await this.getEntryNames();
      for (const name of names) {
        await this.getBuffer(name);
      }
    })();
    promise.catch(() => {
      this.prefetching = undefined;
    });
    this.prefetching = promise;
    return this.prefetching;
  };

  private async getMostFreeWorker(): Promise<WorkerWrapper> {
    const workers = await this.setupWorkers;
    // workers はコンストラクタで必ず 1 つ以上生成されるため workers[0] は安全。
    // getPendingCount() は Object.keys() で配列を確保するため、最小値はローカル変数に
    // キャッシュして各 worker につき 1 回の呼び出しに抑える (prefetchAll のホットパス)。
    let minCount = Number.POSITIVE_INFINITY;
    let freeWorker: WorkerWrapper = workers[0];
    for (const worker of workers) {
      const pendingCount = worker.getPendingCount();
      if (minCount > pendingCount) {
        minCount = pendingCount;
        freeWorker = worker;
      }
    }
    return freeWorker;
  }

  public abort = async (entryName: string) => {
    const workers = await this.setupWorkers;
    for (const worker of workers) {
      worker.abort(entryName);
    }
  };

  public getEntryNames = async (): Promise<string[]> => {
    const workers = await this.setupWorkers;
    const state = await workers[0].getState();
    return state.entryNames;
  };

  public getBuffer = async (entryName: string): Promise<ArrayBuffer> => {
    const workers = await this.setupWorkers;
    for (const worker of workers) {
      const exists = worker.getExistsBuffer(entryName);
      if (exists) {
        return exists;
      }
    }
    const worker = await this.getMostFreeWorker();
    return worker.getBuffer(entryName);
  };

  private fallback(worker: WorkerWrapper) {
    this.setupWorkers = this.setupWorkers
      .then((workers) => workers.filter((one) => one !== worker))
      .then((workers) => {
        workers.forEach((one) => {
          one.terminate();
        });
      })
      .then(() => [worker]);
  }
}
