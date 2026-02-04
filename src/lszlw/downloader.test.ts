import { describe, it, expect, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../test/setup';
import { downloadRange, downloadAll, DataChunk } from './downloader';
import { RangeNotSupportedError } from '../error';
import { AbortError } from '../util/abort';

describe('downloadRange', () => {
  const TEST_URL = 'https://example.com/test.zip';

  it('should return data chunk with correct offset on 206 response', async () => {
    const testData = new Uint8Array([1, 2, 3, 4, 5]);

    server.use(
      http.get(TEST_URL, ({ request }) => {
        const rangeHeader = request.headers.get('Range');
        expect(rangeHeader).toBe('bytes=100-200');

        return new HttpResponse(testData, {
          status: 206,
          headers: {
            'Content-Range': 'bytes 100-200/1000',
          },
        });
      })
    );

    const result = await downloadRange(TEST_URL, 'bytes=100-200');

    expect(result[1]).toBe(100); // offset
    expect(new Uint8Array(result[0])).toEqual(testData);
  });

  it('should handle suffix range request (bytes=-65557)', async () => {
    const testData = new Uint8Array([10, 20, 30]);

    server.use(
      http.get(TEST_URL, ({ request }) => {
        const rangeHeader = request.headers.get('Range');
        expect(rangeHeader).toBe('bytes=-65557');

        return new HttpResponse(testData, {
          status: 206,
          headers: {
            'Content-Range': 'bytes 934443-1000000/1000000',
          },
        });
      })
    );

    const result = await downloadRange(TEST_URL, 'bytes=-65557');

    expect(result[1]).toBe(934443);
  });

  it('should throw RangeNotSupportedError when server returns 200', async () => {
    server.use(
      http.get(TEST_URL, () => {
        return new HttpResponse(new Uint8Array([1, 2, 3]), {
          status: 200,
        });
      })
    );

    await expect(downloadRange(TEST_URL, 'bytes=0-100'))
      .rejects
      .toThrow(RangeNotSupportedError);
  });

  it('should throw error when Content-Range header is missing', async () => {
    server.use(
      http.get(TEST_URL, () => {
        return new HttpResponse(new Uint8Array([1, 2, 3]), {
          status: 206,
          // Content-Range header is missing
        });
      })
    );

    await expect(downloadRange(TEST_URL, 'bytes=0-100'))
      .rejects
      .toThrow('Content-Range not found.');
  });

  it('should throw error when Content-Range format is invalid', async () => {
    server.use(
      http.get(TEST_URL, () => {
        return new HttpResponse(new Uint8Array([1, 2, 3]), {
          status: 206,
          headers: {
            'Content-Range': 'invalid-format',
          },
        });
      })
    );

    await expect(downloadRange(TEST_URL, 'bytes=0-100'))
      .rejects
      .toThrow('Content-Range not found.');
  });

  it('should throw AbortError when signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(downloadRange(TEST_URL, 'bytes=0-100', controller.signal))
      .rejects
      .toThrow(AbortError);
  });

  it('should abort request when signal is aborted during fetch', async () => {
    const controller = new AbortController();

    server.use(
      http.get(TEST_URL, async () => {
        // リクエスト中にabort
        controller.abort();
        // 少し遅延してレスポンスを返す
        await new Promise(resolve => setTimeout(resolve, 100));
        return new HttpResponse(new Uint8Array([1, 2, 3]), {
          status: 206,
          headers: {
            'Content-Range': 'bytes 0-100/1000',
          },
        });
      })
    );

    await expect(downloadRange(TEST_URL, 'bytes=0-100', controller.signal))
      .rejects
      .toThrow();
  });
});

describe('downloadAll', () => {
  const TEST_URL = 'https://example.com/test.zip';

  it('should return full file content on 200 response', async () => {
    const testData = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

    server.use(
      http.get(TEST_URL, () => {
        return new HttpResponse(testData, {
          status: 200,
        });
      })
    );

    const result = await downloadAll(TEST_URL);

    expect(new Uint8Array(result)).toEqual(testData);
  });

  it('should throw error on 404 response', async () => {
    server.use(
      http.get(TEST_URL, () => {
        return new HttpResponse(null, { status: 404 });
      })
    );

    await expect(downloadAll(TEST_URL))
      .rejects
      .toThrow('Get request failed. status code: 404');
  });

  it('should throw error on 500 response', async () => {
    server.use(
      http.get(TEST_URL, () => {
        return new HttpResponse(null, { status: 500 });
      })
    );

    await expect(downloadAll(TEST_URL))
      .rejects
      .toThrow('Get request failed. status code: 500');
  });

  it('should throw AbortError when signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(downloadAll(TEST_URL, controller.signal))
      .rejects
      .toThrow(AbortError);
  });

  it('should abort request when signal is aborted', async () => {
    const controller = new AbortController();

    server.use(
      http.get(TEST_URL, async () => {
        controller.abort();
        await new Promise(resolve => setTimeout(resolve, 100));
        return new HttpResponse(new Uint8Array([1, 2, 3]), {
          status: 200,
        });
      })
    );

    await expect(downloadAll(TEST_URL, controller.signal))
      .rejects
      .toThrow();
  });
});
