import { describe, expect, it } from 'vitest';
import { createResolver } from './resolver';

describe('createResolver', () => {
  it('should create a resolvable promise', () => {
    const resolver = createResolver<string>();
    expect(resolver).toBeInstanceOf(Promise);
  });
});

describe('attachPromise', () => {
  it('should resolve with the attached promise result', async () => {
    const resolver = createResolver<string>();
    const promise = Promise.resolve('test-value');

    resolver.attachPromise(promise);

    const result = await resolver;
    expect(result).toBe('test-value');
  });

  it('should reject with the attached promise error', async () => {
    const resolver = createResolver<string>();
    const error = new Error('test-error');
    const promise = Promise.reject(error);

    resolver.attachPromise(promise);

    await expect(resolver).rejects.toBe(error);
  });
});

describe('attachMessage', () => {
  it('should resolve when error is false', async () => {
    const resolver = createResolver<string>();
    const message = {
      type: 'TEST',
      error: false,
      payload: 'test-payload',
    };

    resolver.attachMessage(message);

    const result = await resolver;
    expect(result).toBe('test-payload');
  });

  it('should reject when error is true', async () => {
    const resolver = createResolver<string>();
    const message = {
      type: 'TEST',
      error: true,
      payload: 'error-payload',
    };

    resolver.attachMessage(message);

    await expect(resolver).rejects.toBe('error-payload');
  });
});
