import { beforeAll, afterEach, afterAll } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';

// テスト用のモックハンドラー（各テストで上書き可能）
export const handlers = [
  // デフォルトハンドラー（必要に応じて各テストで上書き）
];

export const server = setupServer(...handlers);

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
