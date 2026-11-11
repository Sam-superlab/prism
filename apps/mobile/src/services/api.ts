import type { Command, Json, LocalStore, Outcome, RecordEnvelope } from '../offline/store';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: Json = {},
  ) {
    super(message);
  }
}
export class Api {
  constructor(
    readonly baseUrl: string,
    readonly accessToken: () => Promise<string | null>,
    readonly uuid: () => string,
  ) {}
  async request<T = Json>(
    path: string,
    method = 'GET',
    body?: unknown,
    version?: string,
    key?: string,
  ): Promise<T> {
    const token = await this.accessToken();
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (method !== 'GET') headers['Idempotency-Key'] = key ?? this.uuid();
    if (version) headers['If-Match'] = `"${version}"`;
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), 20000);
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: abort.signal,
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as {
          error?: { code: string; message: string; details: Json };
        };
        throw new ApiError(
          response.status,
          payload.error?.code ?? 'REQUEST_FAILED',
          payload.error?.message ?? `Request failed (${response.status})`,
          payload.error?.details,
        );
      }
      return response.status === 204 ? (undefined as T) : ((await response.json()) as T);
    } finally {
      clearTimeout(timeout);
    }
  }
  async list(path: string): Promise<Json[]> {
    let cursor: string | null = null;
    const items: Json[] = [];
    do {
      const separator = path.includes('?') ? '&' : '?';
      const response: { items: Json[]; next_cursor: string | null } = await this.request(
        `${path}${separator}limit=500${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      );
      items.push(...response.items);
      cursor = response.next_cursor;
    } while (cursor);
    return items;
  }
}

export class SyncEngine {
  private running: Promise<void> | null = null;
  constructor(
    readonly local: LocalStore,
    readonly api: Api,
    readonly deviceId: string,
    readonly uuid: () => string,
  ) {}
  sync(): Promise<void> {
    if (!this.running)
      this.running = this.perform().finally(() => {
        this.running = null;
      });
    return this.running;
  }
  private async register(): Promise<void> {
    await this.api.request(
      '/devices',
      'POST',
      { id: this.deviceId, name: 'PRISM iOS', platform: 'ios' },
      undefined,
      this.deviceId,
    );
  }
  private async bootstrap(): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const snapshot = await this.api.request<{ id: string }>('/sync/snapshots', 'POST', {
          device_id: this.deviceId,
        });
        let next: string | null = null;
        let resume = '';
        do {
          const page: {
            records: RecordEnvelope[];
            next_page_cursor: string | null;
            resume_sync_cursor: string;
          } = await this.api.request(
            `/sync/snapshots/${snapshot.id}/records?limit=500${next ? `&cursor=${encodeURIComponent(next)}` : ''}`,
          );
          await this.local.stageSnapshot(snapshot.id, page.records);
          next = page.next_page_cursor;
          resume = page.resume_sync_cursor;
        } while (next);
        if (!resume) throw new Error('The server returned no sync cursor. Local data was not replaced.');
        await this.local.installSnapshot(snapshot.id, resume);
        return;
      } catch (error) {
        if (!(error instanceof ApiError) || ![404, 410].includes(error.status) || attempt === 2) throw error;
        // Restore maintenance may clear an old snapshot while its pages are being read.
        // Restart from a new immutable snapshot; canonical data/outbox stay intact until installation.
      }
    }
  }
  private async reconcile(): Promise<void> {
    try {
      await this.pull();
    } catch (error) {
      if (!(error instanceof ApiError) || error.code !== 'SYNC_CURSOR_EXPIRED') throw error;
      const reason = error.details.reason;
      if (reason === 'STREAM_RESET' || reason === 'CURSOR_AHEAD')
        await this.local.createRecoveryCopy(this.uuid(), reason, new Date().toISOString());
      await this.bootstrap();
      await this.pull();
    }
  }
  private async perform(): Promise<void> {
    await this.register();
    if (!(await this.local.meta('sync_cursor'))) await this.bootstrap();
    // Validate the server stream before sending pending work or replacing any acknowledged cache.
    await this.reconcile();
    // Receipts are permanent: re-sending stable command IDs is safe after a lost response.
    for (let batch = 0; batch < 20; batch++) {
      const operations = await this.local.pending();
      if (!operations.length) break;
      let progressed = false;
      for (const operation of operations) {
        const prepared = await this.local.prepare(operation.client_operation_id, new Date().toISOString());
        const response = await this.api.request<{ results: Outcome[] }>('/sync/push', 'POST', {
          device_id: this.deviceId,
          operations: [prepared],
        });
        for (const result of response.results) {
          await this.local.applyOutcome(result);
          if (result.status === 'applied' || result.status === 'duplicate') progressed = true;
        }
      }
      if (!progressed) break;
    }
    await this.reconcile();
    await this.local.setMeta('last_synced', new Date().toISOString());
  }
  private async pull(): Promise<void> {
    let more = false;
    do {
      const cursor = await this.local.meta('sync_cursor');
      const response: { batches: { changes: RecordEnvelope[] }[]; next_cursor: string; has_more: boolean } =
        await this.api.request(`/sync/pull?cursor=${encodeURIComponent(cursor ?? '')}&limit=100`);
      // API pages contain whole server transactions. Applying the full page in one local transaction is stronger.
      await this.local.applyBatch(
        response.batches.flatMap((x) => x.changes),
        response.next_cursor,
      );
      more = response.has_more;
    } while (more);
  }
}

export function entityEnvelope(type: string, item: Json): RecordEnvelope {
  return {
    entity_type: type,
    entity_id: String(item.id),
    entity_version: String(item.version ?? '1'),
    deleted_at: (item.deleted_at as string | null) ?? null,
    data: item,
  };
}
export function commandEntityType(command: Command): string {
  const prefix = command.operation.split('.');
  return (
    (
      { knowledge: 'knowledge_item', review: 'review_card', task: 'task', inbox: 'inbox_entry' } as Record<
        string,
        string
      >
    )[prefix[0]!] ?? `workout_${prefix[1]}`
  );
}
