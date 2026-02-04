import { describe, it, expect } from 'vitest';
import { bufferToString, stringToBuffer } from './bytes';

describe('bufferToString', () => {
  it('should convert ArrayBuffer to string', () => {
    const buffer = new Uint8Array([72, 101, 108, 108, 111]).buffer; // "Hello"
    expect(bufferToString(buffer)).toBe('Hello');
  });

  it('should return empty string for empty buffer', () => {
    const buffer = new ArrayBuffer(0);
    expect(bufferToString(buffer)).toBe('');
  });

  it('should handle single byte', () => {
    const buffer = new Uint8Array([65]).buffer; // "A"
    expect(bufferToString(buffer)).toBe('A');
  });
});

describe('stringToBuffer', () => {
  it('should convert string to ArrayBuffer', () => {
    const buffer = stringToBuffer('Hello');
    const view = new Uint8Array(buffer);
    expect(Array.from(view)).toEqual([72, 101, 108, 108, 111]);
  });

  it('should return empty buffer for empty string', () => {
    const buffer = stringToBuffer('');
    expect(buffer.byteLength).toBe(0);
  });

  it('should handle single character', () => {
    const buffer = stringToBuffer('A');
    const view = new Uint8Array(buffer);
    expect(Array.from(view)).toEqual([65]);
  });
});

describe('round-trip conversion', () => {
  it('should preserve data through round-trip', () => {
    const original = 'Hello, World!';
    const buffer = stringToBuffer(original);
    const result = bufferToString(buffer);
    expect(result).toBe(original);
  });

  it('should preserve binary data through round-trip', () => {
    const bytes = [0, 127, 255, 128, 1];
    const str = bytes.map(b => String.fromCharCode(b)).join('');
    const buffer = stringToBuffer(str);
    const view = new Uint8Array(buffer);
    expect(Array.from(view)).toEqual(bytes);
  });
});
