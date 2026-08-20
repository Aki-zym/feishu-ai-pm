import { describe, expect, it } from 'vitest';
import { beginResource, beginResourceMutation, beginResourceRequest, failureResource, isLatestResourceMutation, isLatestResourceRequest, loadingResource, mutationRefreshFailure, MUTATION_REFRESH_FAILURE_MESSAGE, successResource } from './resource-state';

describe('resource state contract', () => {
  it('keeps first-load failure distinct from a successful empty response', () => {
    const failed = failureResource(loadingResource<string[]>(), '服务暂时不可用。');
    expect(failed.status).toBe('error');
    expect(failed.data).toBeNull();

    const empty = successResource<string[]>([], true);
    expect(empty.status).toBe('success-empty');
    expect(empty.data).toEqual([]);
  });

  it('preserves the last successful value and marks a refresh failure stale', () => {
    const loaded = successResource(['task-a']);
    const refreshing = beginResource(loaded);
    const stale = failureResource(refreshing, '连接超时。');
    expect(stale.status).toBe('stale');
    expect(stale.data).toEqual(['task-a']);
    expect(stale.error).toBe('连接超时。');
  });

  it('marks a committed mutation refresh failure with the explicit non-replay message', () => {
    const stale = mutationRefreshFailure(beginResource(successResource(['task-a'])));
    expect(stale.status).toBe('stale');
    expect(stale.data).toEqual(['task-a']);
    expect(stale.error).toBe(MUTATION_REFRESH_FAILURE_MESSAGE);
  });

  it('only accepts the latest request identity', () => {
    const ref = { current: 0 };
    const first = beginResourceRequest(ref);
    const second = beginResourceRequest(ref);
    expect(isLatestResourceRequest(ref, first)).toBe(false);
    expect(isLatestResourceRequest(ref, second)).toBe(true);
  });

  it('drops delayed mutation callbacks after a newer resource operation starts', () => {
    const ref = { generations: new Map<string, number>() };
    const first = beginResourceMutation(ref, 'candidate-a', 'candidate-a:accept');
    const second = beginResourceMutation(ref, 'candidate-a', 'candidate-a:refresh');
    expect(isLatestResourceMutation(ref, first)).toBe(false);
    expect(isLatestResourceMutation(ref, second)).toBe(true);
  });

  it('does not invalidate an independent candidate mutation', () => {
    const ref = { generations: new Map<string, number>() };
    const first = beginResourceMutation(ref, 'candidate-a', 'candidate-a:accept');
    const second = beginResourceMutation(ref, 'candidate-b', 'candidate-b:accept');
    expect(isLatestResourceMutation(ref, first)).toBe(true);
    expect(isLatestResourceMutation(ref, second)).toBe(true);
  });
});
