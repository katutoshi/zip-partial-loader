import { describe, it, expect } from 'vitest';
import { throwIfAbort, AbortError } from './abort';

describe('throwIfAbort', () => {
  it('should not throw when signal is undefined', () => {
    expect(() => throwIfAbort(undefined)).not.toThrow();
  });

  it('should not throw when signal is not aborted', () => {
    const controller = new AbortController();
    expect(() => throwIfAbort(controller.signal)).not.toThrow();
  });

  it('should throw AbortError when signal is aborted', () => {
    const controller = new AbortController();
    controller.abort();
    expect(() => throwIfAbort(controller.signal)).toThrow(AbortError);
  });
});

describe('AbortError', () => {
  it('should have name property set to AbortError', () => {
    const error = new AbortError();
    expect(error.name).toBe('AbortError');
  });
});
