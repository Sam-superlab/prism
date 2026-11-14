'use client';

import Link from 'next/link';
import { useRef, useState } from 'react';
import { api, useAction, useResource, uuid } from '../lib/api';
import type { Page } from '../lib/types';
import { ErrorState, Loading, Notice } from './ui';
import styles from './ResearchReferences.module.css';

type Reference = { id: string; title: string; authors: string[]; year: number | null };
type Relation = Reference & { version: string; reference_id: string };

export function LiteratureRelatedReferences({ id }: { id: string }) {
  const path = `/research/references/${id}/related`;
  const [linkPages, setLinkPages] = useState<string[]>([]);
  const links = useResource<Page<Relation>>(path + (linkPages.length ? `?cursor=${encodeURIComponent(linkPages.at(-1)!)}` : ''));
  const [search, setSearch] = useState<string>();
  const [pages, setPages] = useState<string[]>([]);
  const attempts = useRef(new Map<string, string>());
  const action = useAction(links.reload);
  const params = new URLSearchParams({ native: 'true', limit: '25' });
  if (search) params.set('q', search);
  if (pages.length) params.set('cursor', pages.at(-1)!);
  const results = useResource<Page<Reference>>(search === undefined ? null : `/research/library?${params}`);
  const linksNext = links.data?.next_cursor;
  const searchNext = results.data?.next_cursor;
  const related = links.data?.items ?? [];

  return (
    <section className={styles.relatedReferences} aria-label="Related references">
      <h3>Related references</h3>
      <ErrorState error={links.error} retry={links.reload} />
      {action.error && <Notice tone="error">{action.error}</Notice>}
      {links.loading && <Loading />}
      {!links.loading && links.data?.items.length === 0 && <p className="muted">No related references.</p>}
      <ul className={styles.rows}>
        {related.map((item) => (
          <li key={item.id} className={styles.row}>
            <Link className="text-link" href={`/research/library?reference=${item.reference_id}`}>{item.title}</Link>
            <button className="button small" type="button" disabled={action.busy || links.loading}
              aria-label={`Unlink ${item.title}`} onClick={() => void action.run(async () => {
                await api(`/research/reference-relations/${item.id}`, { method: 'DELETE', version: item.version });
                attempts.current.delete(item.reference_id);
                if (related.length === 1) setLinkPages((previous) => previous.slice(0, -1));
              })}>Unlink</button>
          </li>
        ))}
      </ul>
      {(linksNext || linkPages.length > 0) && (
        <div className={styles.pagination}>
          <button className="button small" type="button" disabled={!linkPages.length || links.loading}
            onClick={() => setLinkPages((previous) => previous.slice(0, -1))}>Previous related references</button>
          <button className="button small" type="button" disabled={!linksNext || links.loading}
            onClick={() => { if (linksNext) setLinkPages((previous) => [...previous, linksNext]); }}>More related references</button>
        </div>
      )}
      <form className={styles.toolbar} onSubmit={(event) => {
        event.preventDefault();
        setSearch(String(new FormData(event.currentTarget).get('q') ?? '').trim());
        setPages([]);
      }}>
        <input name="q" className={styles.search} maxLength={300} placeholder="Title, author, or identifier"
          aria-label="Search for a related reference" />
        <button className="button small" type="submit">Find related references</button>
      </form>
      <ErrorState error={results.error} retry={results.reload} />
      {results.loading && <Loading />}
      {!results.loading && !results.error && results.data && (
        <>
          {results.data.items.every((item) => item.id === id) && <p className="muted">No other matching references on this page.</p>}
          <ul className={styles.rows}>
            {results.data.items.filter((item) => item.id !== id).map((item) => {
              const linked = related.some((link) => link.reference_id === item.id);
              return (
                <li key={item.id} className={styles.row}>
                  <span>{item.title}<small className={styles.rowMeta}>
                    {[item.authors.join(', '), item.year].filter(Boolean).join(' · ')}
                  </small></span>
                  <button className="button small" type="button" disabled={action.busy || linked}
                    aria-label={`Relate ${item.title}`} onClick={() => {
                      const attempt = attempts.current.get(item.id) ?? uuid();
                      attempts.current.set(item.id, attempt);
                      void action.run(async () => {
                        await api(path, { method: 'POST', body: { id: attempt, reference_id: item.id } });
                        setSearch(undefined);
                        setLinkPages([]);
                      });
                    }}>{linked ? 'Linked' : 'Link'}</button>
                </li>
              );
            })}
          </ul>
          {(searchNext || pages.length > 0) && (
            <div className={styles.pagination}>
              <button className="button small" type="button" disabled={!pages.length}
                onClick={() => setPages((previous) => previous.slice(0, -1))}>Previous results</button>
              <button className="button small" type="button" disabled={!searchNext}
                onClick={() => { if (searchNext) setPages((previous) => [...previous, searchNext]); }}>More results</button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
