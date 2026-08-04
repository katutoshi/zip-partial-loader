import type { RequestMessage, ResponseMessage } from './types';

export type AnyMessage<P = any> = RequestMessage<string, P, any> | ResponseMessage<string, P, any>;

export interface Resolver<T> extends Promise<T> {
  attachPromise(promise: Promise<T>): void;
  attachMessage(message: AnyMessage): void;
}

export function createResolver<T>(): Resolver<T> {
  let resolve: (result: T) => void, reject: (error: any) => void;
  const resolver = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  }) as Resolver<T>;
  resolver.attachPromise = (promise: Promise<T>) => {
    promise.then(
      (result) => {
        resolve(result);
      },
      (error) => {
        reject(error);
      },
    );
  };
  resolver.attachMessage = (message: AnyMessage<T>) => {
    const { error, payload } = message;
    if (!error) {
      resolve(payload);
    } else {
      reject(payload);
    }
  };
  return resolver;
}
