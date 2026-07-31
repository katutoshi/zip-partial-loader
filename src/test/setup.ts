import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll } from 'vitest';

// テスト用のモックハンドラー（各テストで上書き可能）
export const handlers = [
  // デフォルトハンドラー（必要に応じて各テストで上書き）
];

export const server = setupServer(...handlers);

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
