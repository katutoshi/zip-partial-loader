import { describe, it, expect } from 'vitest';
import { RangeNotSupportedError } from './error';

describe('RangeNotSupportedError', () => {
  it('should be an instance of Error', () => {
    const error = new RangeNotSupportedError();
    expect(error).toBeInstanceOf(Error);
  });

  it('should have correct message', () => {
    const error = new RangeNotSupportedError();
    expect(error.message).toBe('RangeNotSupportedError');
  });

  it('should have correct name', () => {
    const error = new RangeNotSupportedError();
    expect(error.name).toBe('Error');
  });
});
