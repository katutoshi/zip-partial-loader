import { createResolver, type Resolver } from '../resolver';
import {
  type GetDataRequestMessage,
  type GetDataResponseMessage,
  MessageType,
  type ResponseMessage,
  type WorkerState,
} from '../types';

// デフォルトの Worker を起動する。
// `new Worker(new URL(..., import.meta.url), { type: 'module' })` の
// "リテラル形" を関数内に直書きするのが重要: Vite / webpack 5 / Rollup の bundler は
// このコード上のパターンを AST で静的検出して初めて Worker JS を独立チャンクに
// 切り出し、更に Worker からの相対 import (../resolver, ../types, ./lszr-wrapper など)
// を再帰的にたどってバンドルする。
// 変数に URL を退避して `new Worker(variable, ...)` にしてしまうと Vite は
// "URL を単に import.meta.url 相対のアセットにコピーする" 経路に落ちてしまい、
// Worker 内部の import 群がリテラルのまま残ってブラウザで解決できず落ちる
// (実際に example/vite で発生した罠)。
function createDefaultWorker(): Worker {
  return new Worker(new URL('../lszlw/lszlw.js', import.meta.url), { type: 'module' });
}

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
      // 後方互換のため文字列も受け付ける。Worker が別ドメインに置かれる CDN 配布や、
      // どうしてもハッシュ付き自動配置に載せられない環境向け。文字列を渡す場合、
      // その先の JS は module worker として解釈される点に注意 (0.12 以降)。
      worker?: string | URL;
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
    // dist/lszlw/lszlw.js は ESM (`import` を含む) として出力されるため、
    // Worker は必ず `type: 'module'` で起動する必要がある。カスタムパスを渡す場合も
    // このライブラリの Worker を差し替える前提なので module worker で統一する。
    this.worker = params.worker ? new Worker(params.worker, { type: 'module' }) : createDefaultWorker();
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
