'use client';

import { useRef, useState, type ReactNode } from 'react';
import { api, ApiError, datetime, useAction, useResource, uuid } from '../lib/api';
import type { Page } from '../lib/types';
import type { LookupReference } from './LiteratureIdentifierLookup';
import { ErrorState, Field, Loading, Modal, Notice } from './ui';
import { LiteratureFeedOpml } from './LiteratureFeedOpml';
import styles from './ResearchReferences.module.css';

type FeedItem = { external_id: string; title: string; url: string | null; authors: string[]; published_at: string | null; summary: string | null };
type FeedPreview = { url: string; title: string; items: FeedItem[] };
type Subscription = { id: string; url: string; title: string | null; last_refreshed_at: string | null; last_refresh_error: string | null;
  version: string; unread_count: number; auto_refresh?: boolean; next_refresh_at?: string | null };
type FeedEntry = FeedItem & { id: string; version: string; read_at: string | null };
const feedsPath = '/research/library/feeds';

export function LiteratureFeedPreview({ onClose, onReview }: {
  onClose: () => void; onReview: (reference: LookupReference) => void;
}) {
  const [preview, setPreview] = useState<FeedPreview>();
  const [activeFeed, setActiveFeed] = useState('');
  const [unread, setUnread] = useState(false);
  const [cursors, setCursors] = useState<string[]>([]);
  const cursor = cursors.at(-1);
  const params = new URLSearchParams({ limit: '20', ...(unread && { unread: 'true' }), ...(cursor && { cursor }) });
  const subscriptions = useResource<{ items: Subscription[] }>(feedsPath);
  const entries = useResource<Page<FeedEntry>>(activeFeed ? `${feedsPath}/${activeFeed}/entries?${params}` : null);
  const currentFeed = subscriptions.data?.items.find((feed) => feed.id === activeFeed);
  const [feedNotice, setFeedNotice] = useState('');
  const [removing, setRemoving] = useState(false);
  const subscribeAttempt = useRef<{ url: string; id: string }>(null);
  const refreshAttempt = useRef<{ id: string; key: string }>(null);
  const action = useAction();
  const mutate = useAction(() => { subscriptions.reload(); entries.reload(); });
  const request = useRef<AbortController>(null);
  function close() {
    request.current?.abort();
    onClose();
  }

  function selectFeed(id: string) {
    setActiveFeed(id);
    setCursors([]);
    setFeedNotice('');
    setRemoving(false);
    mutate.setError(null);
  }

  function review(item: FeedItem) {
    onReview({ title: item.title.slice(0, 500), authors: item.authors,
      year: item.published_at ? Number(item.published_at.slice(0, 4)) || null : null,
      doi: null, arxiv_id: null, url: item.url, publication: { type: 'online', ...(item.summary && { abstract: item.summary }) } });
  }

  return <Modal title="Literature feeds" onClose={close} wide>
    <section aria-label="Feed subscriptions" className={styles.referenceNotes}>
      <h3>Subscriptions</h3>
      <ErrorState error={subscriptions.error} retry={subscriptions.reload} />
      {subscriptions.loading && <Loading />}
      <LiteratureFeedOpml subscriptions={subscriptions.data?.items ?? []} onChange={subscriptions.reload}
        disabled={subscriptions.loading || !!subscriptions.error || mutate.busy} />
      {!!subscriptions.data?.items.length && <Field label="Subscription">
        <select value={activeFeed} disabled={mutate.busy} onChange={(event) => selectFeed(event.target.value)}>
          <option value="">Choose a subscription</option>
          {subscriptions.data.items.map((feed) => <option key={feed.id} value={feed.id}>
            {feed.title || new URL(feed.url).hostname} ({feed.unread_count} unread)
          </option>)}
        </select>
      </Field>}
      {currentFeed && <>
        <div className={styles.inlineActions}>
          <button type="button" className="button small" disabled={mutate.busy} onClick={() => void mutate.run(async () => {
            setFeedNotice('');
            if (refreshAttempt.current?.id !== currentFeed.id) refreshAttempt.current = { id: currentFeed.id, key: uuid() };
            const result = await api<{ added: number; pruned: number }>(`${feedsPath}/${currentFeed.id}/refresh`, {
              method: 'POST', key: refreshAttempt.current.key, body: {},
            }).catch((error: unknown) => {
              if (error instanceof ApiError && error.status > 0) refreshAttempt.current = null;
              subscriptions.reload();
              throw error;
            });
            refreshAttempt.current = null;
            setCursors([]);
            const added = result.added ? `${result.added} new ${result.added === 1 ? 'entry' : 'entries'}` : 'No new entries';
            setFeedNotice(result.pruned ? `${added} · ${result.pruned} older entries removed` : added);
          })}>Refresh feed</button>
          <label><input type="checkbox" checked={unread} onChange={(event) => { setUnread(event.target.checked); setCursors([]); }} /> Unread only</label>
          <button type="button" className="button small" disabled={mutate.busy} onClick={() => setRemoving(!removing)}>
            {removing ? 'Cancel removal' : 'Remove subscription'}
          </button>
        </div>
        {removing && <button type="button" className="button small danger" disabled={mutate.busy} onClick={() => void mutate.run(async () => {
          await api(`${feedsPath}/${currentFeed.id}`, { method: 'DELETE', version: currentFeed.version });
          selectFeed('');
        })}>Confirm removal</button>}
        {feedNotice && <span role="status" className="small-text">{feedNotice}</span>}
        <label className="small-text"><input type="checkbox" checked={currentFeed.auto_refresh === true}
          disabled={mutate.busy} onChange={(event) => {
            const auto_refresh = event.currentTarget.checked;
            void mutate.run(async () => {
              const updated = await api<Subscription>(`${feedsPath}/${currentFeed.id}`, {
                method: 'PATCH', version: currentFeed.version, body: { auto_refresh },
              });
              subscriptions.setData((data) => data && { items: data.items.map((feed) => feed.id === updated.id ? updated : feed) });
              return updated;
            }).then((result) => { if (result === undefined) subscriptions.reload(); });
          }} /> Refresh automatically</label>
        {currentFeed.auto_refresh && <p className="muted small-text">
          {currentFeed.next_refresh_at ? `Next refresh ${datetime(currentFeed.next_refresh_at)}` : 'Waiting for the background worker.'}
        </p>}
        {currentFeed.last_refresh_error && <Notice tone="warning">{currentFeed.last_refresh_error}</Notice>}
        <p className="muted small-text">Each subscription keeps its 200 newest entries.</p>
        <ErrorState error={entries.error} retry={entries.reload} />
        {entries.loading && <Loading />}
        {!entries.loading && entries.data?.items.length === 0 && <p className="muted">{unread ? 'No unread entries.' : 'Refresh the feed to load entries.'}</p>}
        <ul className={styles.rows}>{!entries.loading && entries.data?.items.map((item) => <FeedRow item={item} key={item.id} onReview={review}>
          <button type="button" className="button small" disabled={mutate.busy} onClick={() => void mutate.run(() =>
            api(`/research/library/feed-entries/${item.id}`, { method: 'PATCH', version: item.version, body: { read: !item.read_at } }))}>
            {item.read_at ? 'Mark unread' : 'Mark read'}
          </button>
        </FeedRow>)}</ul>
        {(cursor || entries.data?.next_cursor) && <div className={styles.pagination}>
          <button type="button" className="button small" disabled={!cursor} onClick={() => setCursors((value) => value.slice(0, -1))}>Previous entries</button>
          <button type="button" className="button small" disabled={!entries.data?.next_cursor} onClick={() => {
            const next = entries.data?.next_cursor;
            if (next) setCursors((value) => [...value, next]);
          }}>Next entries</button>
        </div>}
      </>}
      {mutate.error && <Notice tone="error">{mutate.error}</Notice>}
    </section>
    <form onSubmit={(event) => {
      event.preventDefault();
      if (action.busy) return;
      const url = String(new FormData(event.currentTarget).get('url') ?? '').trim();
      const controller = new AbortController();
      request.current = controller;
      void action.run(async () => {
        const feed = await api<FeedPreview>(`${feedsPath}/preview`, { method: 'POST', body: { url }, signal: controller.signal });
        if (!controller.signal.aborted) setPreview(feed);
      });
    }}>
      <Field label="Public HTTPS feed URL"><input name="url" type="url" placeholder="https://…" required maxLength={2000} /></Field>
      <div className="modal-footer"><button type="submit" className="button primary" disabled={action.busy}>
        {action.busy ? 'Loading feed…' : 'Preview feed'}
      </button></div>
    </form>
    {action.error && <Notice tone="error">{action.error}</Notice>}
    {preview && <section aria-label="Feed entries">
      <h3>{preview.title}</h3>
      <button type="button" className="button small" disabled={mutate.busy || subscriptions.loading || subscriptions.data?.items.some((feed) => feed.url === preview.url)}
        onClick={() => void mutate.run(async () => {
          if (subscribeAttempt.current?.url !== preview.url) subscribeAttempt.current = { url: preview.url, id: uuid() };
          const feed = await api<Subscription>(feedsPath, { method: 'POST', body: { id: subscribeAttempt.current.id, url: preview.url, title: preview.title } });
          subscribeAttempt.current = null;
          selectFeed(feed.id);
          setPreview(undefined);
        })}>Subscribe</button>
      {preview.items.length === 0 && <p className="muted">This feed has no readable entries.</p>}
      <ul className={styles.rows}>{preview.items.map((item) => <FeedRow item={item} key={item.external_id} onReview={review} />)}</ul>
    </section>}
  </Modal>;
}

function FeedRow({ item, onReview, children }: { item: FeedItem; onReview: (item: FeedItem) => void; children?: ReactNode }) {
  return <li className={styles.row}>
        <div>
          {item.url && /^https?:\/\//i.test(item.url)
            ? <a href={item.url} target="_blank" rel="noreferrer" className="text-link">{item.title}</a>
            : <span>{item.title}</span>}
          {(item.authors.length > 0 || item.published_at) && <p className="muted small-text">
            {[item.authors.join(', '), item.published_at?.slice(0, 10)].filter(Boolean).join(' · ')}
          </p>}
          {item.summary && <p>{item.summary}</p>}
        </div>
    <div className={styles.inlineActions}>
      <button type="button" className="button small" aria-label={`Review ${item.title}`} onClick={() => onReview(item)}>Review reference</button>
      {children}
    </div>
  </li>;
}
