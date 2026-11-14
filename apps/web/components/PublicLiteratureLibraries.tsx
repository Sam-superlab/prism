'use client';

import Link from 'next/link';
import { useState } from 'react';
import { api, useAction, useResource } from '../lib/api';
import { safeReferenceUrl, type Publication } from '../lib/bibliography';
import type { Page } from '../lib/types';
import { ErrorState, Loading, Notice } from './ui';
import styles from './ResearchReferences.module.css';

type PublicTeam = { id: string; name: string; description: string; visibility: 'public_closed' | 'public_open' };
type PublicReference = { id: string; title: string; authors: string[]; year: number | null; doi: string | null; url: string | null; publication: Publication };
const root = '/team-library-discovery';

export function PublicLiteratureLibraries({ id }: { id?: string }) {
  return <main className={styles.publicLibraries}>
    <div className="page-heading"><div>
      <Link className="back-link" href={id ? root : '/research/library'}>{id ? 'Public libraries' : 'PRISM workspace'}</Link>
      <h1>{id ? 'Team library' : 'Public team libraries'}</h1>
    </div></div>
    {id ? <PublicLibrary key={id} id={id} /> : <PublicLibraryList />}
  </main>;
}

function PublicLibraryList() {
  const [cursors, setCursors] = useState<string[]>([]);
  const cursor = cursors.at(-1);
  const result = useResource<Page<PublicTeam>>(`${root}?limit=25${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
  return <section className="panel content-panel" aria-label="Public libraries">
    <ErrorState error={result.error} retry={result.reload} />
    {result.loading && <Loading />}
    {!result.loading && result.data?.items.length === 0 && <p className="muted">No public libraries are available.</p>}
    {!result.loading && !result.error && <ul className={styles.rows}>{result.data?.items.map((team) => <li className={styles.row} key={team.id}>
      <div><Link className="text-link" href={`${root}?library=${team.id}`}>{team.name}</Link>
        {team.description && <p>{team.description}</p>}</div>
      <span className="muted small-text">{team.visibility === 'public_open' ? 'Open membership' : 'Invitation required'}</span>
    </li>)}</ul>}
    <PublicPagination current={cursor} next={result.data?.next_cursor} setCursors={setCursors} />
  </section>;
}

function PublicLibrary({ id }: { id: string }) {
  const path = `${root}/${id}`;
  const team = useResource<PublicTeam>(path);
  const viewer = useResource<{ id: string }>('/me');
  const [cursors, setCursors] = useState<string[]>([]);
  const [joined, setJoined] = useState(false);
  const action = useAction();
  const cursor = cursors.at(-1);
  const references = useResource<Page<PublicReference>>(team.data && !team.error
    ? `${path}/references?limit=25${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}` : null);
  return <section className="panel content-panel" aria-label="Public team bibliography">
    <ErrorState error={team.error} retry={team.reload} />
    {team.loading && <Loading />}
    {team.data && !team.error && <>
      <h2>{team.data.name}</h2>
      {team.data.description && <p>{team.data.description}</p>}
      {team.data.visibility === 'public_open' ? viewer.data ? (
        <button className="button small" type="button" disabled={action.busy || joined} onClick={() => void action.run(async () => {
          await api(`/team-libraries/${id}/join`, { method: 'POST' });
          setJoined(true);
        })}>{joined ? 'Joined' : 'Join library'}</button>
      ) : !viewer.loading && <a className="text-link" href={`/auth/login?returnTo=${encodeURIComponent(`${root}?library=${id}`)}`}>Sign in to join</a>
        : <p className="muted">Membership is by invitation.</p>}
      {action.error && <Notice tone="error">{action.error}</Notice>}
      {joined && <p><Link className="text-link" href="/research/library">Open your literature library</Link></p>}
      <ErrorState error={references.error} retry={references.reload} />
      {references.loading && <Loading />}
      {!references.loading && references.data?.items.length === 0 && <p className="muted">No published references.</p>}
      {!references.loading && !references.error && <ul className={styles.rows}>{references.data?.items.map((item) => {
        const url = item.url && safeReferenceUrl(item.url);
        return <li className={styles.row} key={item.id}><div>
          {url ? <a href={url} className="text-link" target="_blank" rel="noreferrer">{item.title}</a> : <span>{item.title}</span>}
          <p className="muted small-text">{[item.authors.join(', '), item.year, item.publication.journal].filter(Boolean).join(' · ')}</p>
        </div></li>;
      })}</ul>}
      <PublicPagination current={cursor} next={references.data?.next_cursor} setCursors={setCursors} />
    </>}
  </section>;
}

function PublicPagination({ current, next, setCursors }: {
  current?: string; next?: string | null; setCursors: React.Dispatch<React.SetStateAction<string[]>>;
}) {
  if (!current && !next) return null;
  return <div className={styles.pagination}>
    <button type="button" className="button small" disabled={!current} onClick={() => setCursors((values) => values.slice(0, -1))}>Previous page</button>
    <button type="button" className="button small" disabled={!next} onClick={() => { if (next) setCursors((values) => [...values, next]); }}>Next page</button>
  </div>;
}
