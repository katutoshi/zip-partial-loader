import { describe, it, expect } from 'vitest';
import { createResolver, ResolverStatus } from './resolver';

describe('createResolver', () => {
  it('should create resolver with PENDING status', () => {
    const resolver = createResolver<string>();
    expect(resolver.status).toBe(ResolverStatus.PENDING);
  });
});

describe('attachPromise', () => {
  it('should resolve and set status to RESOLVED', async () => {
    const resolver = createResolver<string>();
    const promise = Promise.resolve('test-value');

    resolver.attachPromise(promise);

    const result = await resolver;
    expect(result).toBe('test-value');
    expect(resolver.status).toBe(ResolverStatus.RESOLVED);
  });

  it('should reject and set status to REJECTED', async () => {
    const resolver = createResolver<string>();
    const error = new Error('test-error');
    const promise = Promise.reject(error);

    resolver.attachPromise(promise);

    await expect(resolver).rejects.toBe(error);
    expect(resolver.status).toBe(ResolverStatus.REJECTED);
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
    expect(resolver.status).toBe(ResolverStatus.RESOLVED);
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
    expect(resolver.status).toBe(ResolverStatus.REJECTED);
  });
});
