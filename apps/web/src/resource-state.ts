export type ResourceStatus = 'idle' | 'loading' | 'success-empty' | 'success-data' | 'error' | 'stale';

export const MUTATION_REFRESH_FAILURE_MESSAGE = '写入已成功，但列表未刷新';

export type ResourceState<T> = {
  status: ResourceStatus;
  data: T | null;
  error: string | null;
  updatedAt: string | null;
};

export type ResourceRequest = { generation: number };
export type ResourceMutation = { resourceId: string; generation: number; operationId: string };

export type ResourceRequestRef = { current: number };
export type ResourceMutationRef = { generations: Map<string, number> };

/** Start a refresh and return the identity that is allowed to publish its result. */
export function beginResourceRequest(ref: ResourceRequestRef): ResourceRequest {
  ref.current += 1;
  return { generation: ref.current };
}

/** Async results may update a resource only when they belong to the latest refresh. */
export function isLatestResourceRequest(ref: ResourceRequestRef, request: ResourceRequest): boolean {
  return ref.current === request.generation;
}

/** Start a mutation whose completion may publish only while it is newest. */
export function beginResourceMutation(ref: ResourceMutationRef, resourceId: string, operationId: string): ResourceMutation {
  const generation = (ref.generations.get(resourceId) ?? 0) + 1;
  ref.generations.set(resourceId, generation);
  return { resourceId, generation, operationId };
}

/** Delayed mutation callbacks must not overwrite a newer operation's state. */
export function isLatestResourceMutation(ref: ResourceMutationRef, mutation: ResourceMutation): boolean {
  return ref.generations.get(mutation.resourceId) === mutation.generation;
}

export function loadingResource<T>(): ResourceState<T> {
  return { status: 'loading', data: null, error: null, updatedAt: null };
}

export function beginResource<T>(current: ResourceState<T>): ResourceState<T> {
  return { ...current, status: 'loading', error: null };
}

export function successResource<T>(data: T, empty = false, updatedAt = new Date().toISOString()): ResourceState<T> {
  return { status: empty ? 'success-empty' : 'success-data', data, error: null, updatedAt };
}

export function failureResource<T>(current: ResourceState<T>, error: string): ResourceState<T> {
  return {
    ...current,
    status: current.data === null ? 'error' : 'stale',
    error,
  };
}

/** A committed mutation must never be replayed when its follow-up refresh fails. */
export function mutationRefreshFailure<T>(current: ResourceState<T>): ResourceState<T> {
  return failureResource(current, MUTATION_REFRESH_FAILURE_MESSAGE);
}
