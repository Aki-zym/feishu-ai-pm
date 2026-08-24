import { desktopBridge } from './desktop';

export class ApiRequestError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.body = body;
  }
}

async function request<T>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const desktop = desktopBridge();
  if (desktop) {
    const response = await desktop.api.request({ method, url, body });
    if (response.status < 200 || response.status >= 300) {
      const errorBody = response.body as { error?: string } | undefined;
      throw new ApiRequestError(errorBody?.error ?? '请求失败，请稍后重试。', response.status, response.body);
    }
    return response.body as T;
  }

  const response = await fetch(url, {
    method,
    signal,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    const errorBody = (await response.json().catch(() => ({}))) as { error?: string };
    throw new ApiRequestError(errorBody.error ?? '请求失败，请稍后重试。', response.status, errorBody);
  }
  return response.json() as Promise<T>;
}

export const api = {
  get: <T>(url: string, signal?: AbortSignal) => request<T>('GET', url, undefined, signal),
  post: <T>(url: string, body: unknown) => request<T>('POST', url, body),
  put: <T>(url: string, body: unknown) => request<T>('PUT', url, body),
  patch: <T>(url: string, body: unknown) => request<T>('PATCH', url, body),
  delete: <T>(url: string, body?: unknown) => request<T>('DELETE', url, body),
};
