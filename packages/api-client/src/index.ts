export interface ClientOptions {
  baseUrl: string;
  accessToken?: () => Promise<string | null>;
  fetch?: typeof fetch;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export class PrismClient {
  constructor(private options: ClientOptions) {}

  async request<T>(
    path: string,
    options: {
      method?: string;
      body?: unknown;
      version?: string;
      idempotencyKey?: string;
      signal?: AbortSignal;
    } = {},
  ): Promise<T> {
    const method = options.method ?? 'GET';
    const headers: Record<string, string> = { Accept: 'application/json' };
    const token = await this.options.accessToken?.();
    if (token) headers.Authorization = `Bearer ${token}`;
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    if (method !== 'GET') headers['Idempotency-Key'] = options.idempotencyKey ?? crypto.randomUUID();
    if (options.version) headers['If-Match'] = `"${options.version}"`;
    const response = await (this.options.fetch ?? fetch)(
      `${this.options.baseUrl.replace(/\/$/, '')}/${path.replace(/^\//, '')}`,
      {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: options.signal,
      },
    );
    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as {
        error?: { code?: string; message?: string; details?: Record<string, unknown> };
      };
      throw new ApiError(
        response.status,
        payload.error?.code ?? 'HTTP_ERROR',
        payload.error?.message ?? `Request failed (${response.status})`,
        payload.error?.details,
      );
    }
    if (response.status === 204) return undefined as T;
    return response.json() as Promise<T>;
  }

  async *pages<T>(path: string, signal?: AbortSignal): AsyncGenerator<T> {
    let cursor: string | null = null;
    do {
      const separator = path.includes('?') ? '&' : '?';
      const result: { items: T[]; next_cursor: string | null } = await this.request(
        `${path}${cursor ? `${separator}cursor=${encodeURIComponent(cursor)}` : ''}`,
        { signal },
      );
      for (const item of result.items) yield item;
      cursor = result.next_cursor;
    } while (cursor);
  }
}
