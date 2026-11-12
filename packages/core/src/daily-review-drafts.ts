import { randomUUID } from 'node:crypto';
import type { Database, Sql } from '@prism/database';
import { localDate, localDayRange } from '@prism/shared-utils';
import { validation } from './errors';
import {
  generateReviewDrafts,
  ReviewDraftProviderError,
  type ReviewDraftCard,
  type ReviewDraftNote,
} from './review-draft-provider';

type DraftItem = { knowledge_id: string; title: string; cards: (ReviewDraftCard & { id: string })[] };
type DraftStatus = 'disabled' | 'idle' | 'running' | 'ready' | 'paused' | 'failed';
type DraftBatch = { date: string; status: DraftStatus; items: DraftItem[]; message?: string };
const maxNotes = 8;
const maxNoteCharacters = 1600;
const maxBatchBytes = 23_000;
const lease = "interval '2 minutes'";
const pausedMessage =
  'AI drafts are paused. Check the promotional balance and billing settings before retrying.';

// Do not send attachments, inline source images, or lines containing recognizable local file references.
function noteText(value: string): string {
  return value
    .replace(/<img\b[^>]*>/gi, '')
    .split(/\r?\n/)
    .filter(
      (line) =>
        !/!\[|file:\/\/|https?:\/\/(?:localhost|127\.0\.0\.1)|\/(?:knowledge-sources|Users|home)\//i.test(
          line,
        ),
    )
    .join('\n')
    .trim();
}

async function currentBatch(sql: Sql, userId: string, date: string, enabled: boolean): Promise<DraftBatch> {
  const {
    rows: [batch],
  } = await sql.query('SELECT status,items FROM ai_review_drafts WHERE user_id=$1 AND note_date=$2', [
    userId,
    date,
  ]);
  if (batch?.status === 'ready') {
    const stored = batch.items as DraftItem[];
    if (!stored.length) return { date, status: 'ready', items: [] };
    const { rows: eligible } = await sql.query<{ id: string }>(
      'SELECT id FROM knowledge_items WHERE user_id=$1 AND id=ANY($2::uuid[]) AND deleted_at IS NULL',
      [userId, stored.map((group) => group.knowledge_id)],
    );
    const { rows: approved } = await sql.query<{ id: string }>(
      'SELECT id FROM review_cards WHERE user_id=$1 AND id=ANY($2::uuid[])',
      [userId, stored.flatMap((group) => group.cards.map((card) => card.id))],
    );
    const liveNotes = new Set(eligible.map((row) => row.id));
    const savedCards = new Set(approved.map((row) => row.id));
    const items = stored
      .filter((group) => liveNotes.has(group.knowledge_id))
      .map((group) => ({ ...group, cards: group.cards.filter((card) => !savedCards.has(card.id)) }))
      .filter((group) => group.cards.length);
    return { date, status: 'ready', items };
  }
  if (!enabled)
    return {
      date,
      status: 'disabled',
      items: [],
      message: 'AI drafts are off until promotional-only API billing is confirmed and enabled.',
    };
  const {
    rows: [active],
  } = await sql.query(
    `SELECT CASE WHEN status='running' AND updated_at>now()-${lease} THEN 'running' ELSE 'paused' END AS state
     FROM ai_review_drafts WHERE user_id=$1
     AND (status='paused' OR (status='running' AND (resuming OR updated_at>now()-${lease})))
     ORDER BY CASE WHEN status='running' AND updated_at>now()-${lease} THEN 0 ELSE 1 END LIMIT 1`,
    [userId],
  );
  if (active?.state === 'paused') return { date, status: 'paused', items: [], message: pausedMessage };
  if (active?.state === 'running') return { date, status: 'running', items: [] };
  if (batch)
    return { date, status: 'failed', items: [], message: 'Draft generation did not finish. You can retry.' };
  return { date, status: 'idle', items: [] };
}

export class DailyReviewDrafts {
  constructor(
    private readonly db: Database,
    private readonly apiKey?: string,
    private readonly provider = generateReviewDrafts,
  ) {}

  get(userId: string, date: string): Promise<DraftBatch> {
    return this.db.transaction(userId, (sql) => currentBatch(sql, userId, date, !!this.apiKey));
  }

  async generate(userId: string, date: string, requestKey: string, retry = false): Promise<DraftBatch> {
    const apiKey = this.apiKey;
    if (!apiKey) return this.get(userId, date);
    const claim = await this.db.transaction<DraftBatch | { notes: ReviewDraftNote[]; resuming: boolean }>(
      userId,
      async (sql) => {
        // Share the normal account write lock so tabs and devices cannot claim two requests.
        await sql.query('SELECT revision FROM user_sync_state WHERE user_id=$1 FOR UPDATE', [userId]);
        const current = await currentBatch(sql, userId, date, true);
        if (
          current.status === 'ready' ||
          current.status === 'running' ||
          (current.status !== 'idle' && !retry)
        )
          return current;
        const {
          rows: [profile],
        } = await sql.query<{ timezone: string }>(
          'SELECT timezone FROM users WHERE id=$1 AND deleted_at IS NULL',
          [userId],
        );
        const today = localDate(new Date(), profile.timezone);
        const yesterday = new Date(`${today}T00:00:00Z`);
        yesterday.setUTCDate(yesterday.getUTCDate() - 1);
        if (date !== yesterday.toISOString().slice(0, 10))
          throw validation('Generate drafts only for the previous local day.');

        const {
          rows: [replayed],
        } = await sql.query(
          'SELECT 1 FROM ai_review_drafts WHERE user_id=$1 AND note_date=$2 AND request_key=$3',
          [userId, date, requestKey],
        );
        if (replayed) return current;
        const { start, end } = localDayRange(date, profile.timezone);
        const { rows } = await sql.query<ReviewDraftNote>(
          `SELECT id AS knowledge_id,title,content FROM knowledge_items WHERE user_id=$1
         AND deleted_at IS NULL AND created_at >= $2 AND created_at < $3
         AND tags @> ARRAY['ai-review']::text[] AND length(btrim(content))>0
         ORDER BY created_at,id LIMIT $4`,
          [userId, start, end, maxNotes],
        );
        const notes: ReviewDraftNote[] = [];
        let bytesRemaining = maxBatchBytes;
        for (const { knowledge_id, title, content } of rows) {
          const note = {
            knowledge_id,
            title: noteText(title) || 'Study note',
            content: Array.from(noteText(content)).slice(0, maxNoteCharacters).join(''),
          };
          const size = Buffer.byteLength(JSON.stringify(note), 'utf8');
          if (!note.content || size > bytesRemaining) continue;
          bytesRemaining -= size;
          notes.push(note);
        }
        const resuming = current.status === 'paused';
        if (!notes.length) return resuming ? current : { date, status: 'ready', items: [] };
        await sql.query(
          `INSERT INTO ai_review_drafts(user_id,note_date,request_key,status,resuming) VALUES($1,$2,$3,'running',$4)
         ON CONFLICT(user_id,note_date) DO UPDATE
         SET request_key=EXCLUDED.request_key,status=EXCLUDED.status,resuming=EXCLUDED.resuming,
         items='[]',updated_at=now()`,
          [userId, date, requestKey, resuming],
        );
        return { notes, resuming };
      },
    );
    if (!('notes' in claim)) return claim;

    let status: 'ready' | 'paused' | 'failed' = 'ready';
    let items: DraftItem[] = [];
    try {
      const byId = new Map(claim.notes.map((note) => [note.knowledge_id, note.title]));
      const result = await this.provider(claim.notes, apiKey);
      items = result.flatMap((group) => {
        const title = byId.get(group.knowledge_id);
        return title && group.cards.length
          ? [
              {
                knowledge_id: group.knowledge_id,
                title,
                cards: group.cards.map((card) => ({ ...card, id: randomUUID() })),
              },
            ]
          : [];
      });
    } catch (error) {
      status =
        claim.resuming || (error instanceof ReviewDraftProviderError && error.pause) ? 'paused' : 'failed';
    }
    return this.db.transaction(userId, async (sql) => {
      await sql.query('SELECT revision FROM user_sync_state WHERE user_id=$1 FOR UPDATE', [userId]);
      const { rows: completed } = await sql.query(
        `UPDATE ai_review_drafts SET status=$4,items=$5::jsonb,resuming=false,updated_at=now()
         WHERE user_id=$1 AND note_date=$2 AND request_key=$3 AND status='running' RETURNING note_date`,
        [userId, date, requestKey, status, JSON.stringify(items)],
      );
      if (completed.length && claim.resuming && status === 'ready')
        await sql.query(
          `UPDATE ai_review_drafts SET status='failed',resuming=false,updated_at=now()
           WHERE user_id=$1 AND (status='paused' OR (status='running' AND resuming))`,
          [userId],
        );
      return currentBatch(sql, userId, date, true);
    });
  }
}
