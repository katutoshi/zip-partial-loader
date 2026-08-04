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
    let minCount = Number.POSITIVE_INFINITY;
    let freeWorker: WorkerWrapper = workers[0];
    for (let index = 0; index < workers.length; index++) {
      const worker = workers[index];
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
    for (let index = 0; index < workers.length; index++) {
      const worker = workers[index];
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
    for (let index = 0; index < workers.length; index++) {
      const worker = workers[index];
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
