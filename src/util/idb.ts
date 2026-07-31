export function promisify<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((res, rej) => {
    request.onerror = () => rej(request.error);
    request.onsuccess = () => res(request.result);
  });
}

export function promisifyWithCursor<C extends IDBCursor>(
  // IDBObjectStore#openCursor / IDBIndex#openCursor は `IDBRequest<C | null>`
  // を返す (end 到達時に null) ため、request の型もそれに合わせる。
  request: IDBRequest<C | null>,
  // biome-ignore lint/suspicious/noConfusingVoidType: 呼び出し側で return を書かない (=戻り値を無視する) パターンを許容したいので void を残す
  ondata: (target: C) => void | boolean,
): Promise<void> {
  return new Promise((res, rej) => {
    request.onerror = () => rej(request.error);
    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor) {
        const ret = ondata(cursor);
        if (ret) {
          res();
        } else {
          cursor.continue();
        }
      } else {
        res();
      }
    };
  });
}
