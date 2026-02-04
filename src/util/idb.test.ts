import { describe, it, expect, vi } from 'vitest';
import { promisify, promisifyWithCursor } from './idb';

describe('promisify', () => {
  it('should resolve with result on success', async () => {
    const mockRequest = {
      onerror: null as (() => void) | null,
      onsuccess: null as (() => void) | null,
      result: 'test-result',
      error: null,
    } as unknown as IDBRequest<string>;

    const promise = promisify(mockRequest);

    // Trigger success
    mockRequest.onsuccess?.();

    await expect(promise).resolves.toBe('test-result');
  });

  it('should reject with error on failure', async () => {
    const mockError = new Error('test-error');
    const mockRequest = {
      onerror: null as (() => void) | null,
      onsuccess: null as (() => void) | null,
      result: null,
      error: mockError,
    } as unknown as IDBRequest<string>;

    const promise = promisify(mockRequest);

    // Trigger error
    mockRequest.onerror?.();

    await expect(promise).rejects.toBe(mockError);
  });
});

describe('promisifyWithCursor', () => {
  it('should iterate through cursor and resolve when cursor is null', async () => {
    const ondata = vi.fn();
    let callCount = 0;

    const mockRequest = {
      onerror: null as (() => void) | null,
      onsuccess: null as (() => void) | null,
      result: null as { continue: () => void } | null,
      error: null,
    } as unknown as IDBRequest<IDBCursor>;

    const promise = promisifyWithCursor(mockRequest, ondata);

    // Simulate cursor iteration
    const mockCursor = {
      continue: vi.fn(() => {
        callCount++;
        if (callCount < 3) {
          mockRequest.result = mockCursor;
          mockRequest.onsuccess?.();
        } else {
          mockRequest.result = null;
          mockRequest.onsuccess?.();
        }
      }),
    };

    mockRequest.result = mockCursor as unknown as IDBCursor;
    mockRequest.onsuccess?.();

    await promise;

    expect(ondata).toHaveBeenCalledTimes(3);
  });

  it('should stop early when ondata returns true', async () => {
    const ondata = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);

    const mockRequest = {
      onerror: null as (() => void) | null,
      onsuccess: null as (() => void) | null,
      result: null as { continue: () => void } | null,
      error: null,
    } as unknown as IDBRequest<IDBCursor>;

    const promise = promisifyWithCursor(mockRequest, ondata);

    const mockCursor = {
      continue: vi.fn(() => {
        mockRequest.result = mockCursor;
        mockRequest.onsuccess?.();
      }),
    };

    mockRequest.result = mockCursor as unknown as IDBCursor;
    mockRequest.onsuccess?.();

    await promise;

    expect(ondata).toHaveBeenCalledTimes(2);
    expect(mockCursor.continue).toHaveBeenCalledTimes(1);
  });

  it('should reject on error', async () => {
    const mockError = new Error('cursor-error');
    const ondata = vi.fn();

    const mockRequest = {
      onerror: null as (() => void) | null,
      onsuccess: null as (() => void) | null,
      result: null,
      error: mockError,
    } as unknown as IDBRequest<IDBCursor>;

    const promise = promisifyWithCursor(mockRequest, ondata);

    mockRequest.onerror?.();

    await expect(promise).rejects.toBe(mockError);
    expect(ondata).not.toHaveBeenCalled();
  });
});
