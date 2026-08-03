import { createResolver, type Resolver } from '../resolver';
import {
  type GetDataRequestMessage,
  type GetDataResponseMessage,
  MessageType,
  type ResponseMessage,
  type WorkerState,
} from '../types';

export default class WorkerWrapper {
  private resolvers: {
    init: Resolver<WorkerState>;
    getData: { [entryName: string]: Resolver<ArrayBuffer> };
  };
  private worker: Worker;
  public onFallback?: () => void;
  constructor(
    private params: {
      url: string;
      key?: string;
      worker?: string;
      noUseCache?: boolean;
      forceInMemoryCache?: boolean;
      forceKeepCache?: boolean;
    },
  ) {
    const init = createResolver<WorkerState>();
    this.resolvers = {
      init,
      getData: {},
    };
    this.worker = new Worker(params.worker || 'lszlw.js');
    this.worker.onmessage = this.onmessage;
    this.worker.postMessage({
      type: MessageType.INIT,
      payload: params,
    });
  }

  public getState(): Promise<WorkerState> {
    return this.resolvers.init;
  }

  public getBuffer(entryName: string): Promise<ArrayBuffer> {
    const exists = this.resolvers.getData[entryName];
    if (exists) {
      return exists;
    }
    const resolver = createResolver<ArrayBuffer>();
    this.resolvers.getData[entryName] = resolver;
    this.worker.postMessage({
      type: MessageType.GET_DATA,
      payload: entryName,
    } as GetDataRequestMessage);
    resolver.then(
      () => {
        delete this.resolvers.getData[entryName];
      },
      () => {
        delete this.resolvers.getData[entryName];
      },
    );
    return resolver;
  }

  public getExistsBuffer(entryName: string): Promise<ArrayBuffer> | undefined {
    const exists = this.resolvers.getData[entryName];
    if (exists) {
      return exists;
    }
    return undefined;
  }

  public getPendingCount(): number {
    return Object.keys(this.resolvers.getData).length;
  }

  public abort(entryName: string) {
    if (entryName in this.resolvers.getData) {
      this.worker.postMessage({
        type: MessageType.ABORT_DATA,
        payload: entryName,
      });
    }
  }

  private onmessage = (ev: MessageEvent) => {
    const message = ev.data as ResponseMessage;
    const type = message.type;
    if (type === MessageType.INIT) {
      this.resolvers.init.attachMessage(message);
    } else if (type === MessageType.GET_DATA) {
      const { meta: entryName } = message as GetDataResponseMessage;
      const resolver = this.resolvers.getData[entryName];
      resolver?.attachMessage(message);
    } else if (type === MessageType.UPDATE_STATE) {
      // const { payload: state } = message as UpdateStateMessage;
      this.onFallback?.();
    }
  };

  public terminate = () => {
    // `forEach(this.abort)` だと通常メソッド `abort` の this が失われ、
    // pending がある状態で terminate すると TypeError で落ちる。
    // アロー関数で this を確保する。
    Object.keys(this.resolvers.getData).forEach((entryName) => {
      this.abort(entryName);
    });
    this.worker.terminate();
  };
}
