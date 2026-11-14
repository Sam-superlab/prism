'use client';

import { useRef, useState } from 'react';
import { api, useAction, uuid } from '../lib/api';
import { maxLiteratureOpmlBytes, parseLiteratureOpml, serializeLiteratureOpml, type LiteratureOpmlFeed } from '../lib/literature-opml';
import { Notice } from './ui';
import styles from './ResearchReferences.module.css';

export function LiteratureFeedOpml({ subscriptions, onChange, disabled }: {
  subscriptions: readonly { url: string; title: string | null }[]; onChange: () => void; disabled?: boolean;
}) {
  const [draft, setDraft] = useState<ReturnType<typeof parseLiteratureOpml>>();
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const operationIds = useRef(new Map<string, string>());
  const action = useAction();
  const picker = useRef<HTMLInputElement>(null);
  const known = new Set(subscriptions.map(({ url }) => url));
  const available = Math.max(0, 25 - subscriptions.length);
  const candidates = draft?.feeds.filter(({ url }) => !known.has(url)) ?? [];

  async function prepare(file: File) {
    setError('');
    setDraft(undefined);
    setStatus('');
    try {
      if (file.size > maxLiteratureOpmlBytes) throw new Error('Choose an OPML file no larger than 512 KiB.');
      const parsed = parseLiteratureOpml(new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer()));
      setDraft(parsed);
      setSelected(new Set(parsed.feeds.filter(({ url }) => !known.has(url)).slice(0, available).map(({ url }) => url)));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not read this OPML file.');
    }
  }

  function download() {
    try {
      const url = URL.createObjectURL(new Blob([serializeLiteratureOpml(subscriptions)], { type: 'text/x-opml;charset=utf-8' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = 'prism-feeds.opml';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not export these subscriptions.');
    }
  }

  async function save(feeds: LiteratureOpmlFeed[]) {
    const remaining = new Set(feeds.map(({ url }) => url));
    try {
      for (const feed of feeds) {
        const id = operationIds.current.get(feed.url) ?? uuid();
        operationIds.current.set(feed.url, id);
        await api('/research/library/feeds', { method: 'POST', body: { id, ...feed } });
        remaining.delete(feed.url);
      }
      setDraft(undefined);
      setStatus(`${feeds.length} ${feeds.length === 1 ? 'subscription' : 'subscriptions'} imported.`);
    } finally {
      setSelected(remaining);
      onChange();
    }
  }

  const chosen = candidates.filter(({ url }) => selected.has(url));
  return <div>
    <div className={styles.inlineActions}>
      <button className="button small" type="button" disabled={disabled || action.busy}
        onClick={() => picker.current?.click()}>Import OPML</button>
      <input type="file" hidden ref={picker} accept=".opml,.xml,text/xml,application/xml,text/x-opml"
        aria-label="Choose OPML file" onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file) void prepare(file);
        }} />
      <button className="button small" type="button" disabled={disabled || !subscriptions.length}
        onClick={download}>Export OPML</button>
    </div>
    {status && <p role="status" className="small-text">{status}</p>}
    {(error || action.error) && <Notice tone="error">{error || action.error}</Notice>}
    {draft && <section aria-label="Review OPML subscriptions" className={styles.referenceNotes}>
      <h4>Review OPML subscriptions</h4>
      <p className="muted small-text">{draft.skipped.length} skipped · {draft.feeds.length - candidates.length} already subscribed · {available} available slots</p>
      <ul className={styles.rows}>{candidates.map((feed) => <li className={styles.row} key={feed.url}>
        <label><input type="checkbox" disabled={action.busy} checked={selected.has(feed.url)} onChange={(event) => {
          const checked = event.target.checked;
          setSelected((current) => {
            const next = new Set(current);
            if (checked) next.add(feed.url);
            else next.delete(feed.url);
            return next;
          });
        }} /> {feed.title} <small className="muted">{new URL(feed.url).hostname}</small></label>
      </li>)}</ul>
      <div className={styles.inlineActions}>
        <button className="button small" type="button" disabled={action.busy} onClick={() => { setDraft(undefined); action.setError(null); }}>Cancel import</button>
        <button className="button small primary" type="button" disabled={disabled || action.busy || !chosen.length || chosen.length > available}
          onClick={() => void action.run(() => save(chosen))}>Import selected subscriptions</button>
      </div>
    </section>}
  </div>;
}
