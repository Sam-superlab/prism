'use client';

import { useState } from 'react';
import { api, useAction, useResource, uuid } from '../lib/api';
import { MarkdownEditor } from './MarkdownEditor';
import { ErrorState, Field, KnowledgeMarkdown, Loading, Notice } from './ui';
import styles from './ResearchReferences.module.css';

type Note = { id: string; title: string; content: string; created_by_name: string; updated_by_name: string; version: string };

export function LiteratureTeamNotes({ referencePath, canEdit }: { referencePath: string; canEdit: boolean }) {
  const path = `${referencePath}/notes`;
  const notes = useResource<{ items: Note[] }>(path);
  const action = useAction(notes.reload);
  const [draft, setDraft] = useState<{ id: string; title: string; content: string; version?: string }>();
  const [remove, setRemove] = useState<Note>();
  return <section className={styles.referenceNotes} aria-label="Shared notes">
    <h4>Shared notes</h4>
    <ErrorState error={notes.error} retry={notes.reload} />
    {notes.loading && <Loading />}
    {!notes.loading && !draft && notes.data?.items.length === 0 && <p className="muted small-text">No shared notes for this reference.</p>}
    {canEdit && !draft && <button className="button small" type="button" disabled={action.busy}
      onClick={() => { setDraft({ id: uuid(), title: '', content: '' }); setRemove(undefined); action.setError(null); }}>Add shared note</button>}
    {draft && canEdit && <form onSubmit={(event) => {
      event.preventDefault();
      if (!draft.title.trim() || action.busy) return;
      void action.run(async () => {
        const body = { title: draft.title.trim(), content: draft.content };
        if (draft.version) await api(`${path}/${draft.id}`, { method: 'PATCH', version: draft.version, body });
        else await api(path, { method: 'POST', body: { id: draft.id, ...body } });
        setDraft(undefined);
      });
    }}>
      <Field label="Shared note title"><input value={draft.title} required maxLength={300} disabled={action.busy}
        onChange={(event) => setDraft({ ...draft, title: event.target.value })} autoFocus /></Field>
      <MarkdownEditor label="Shared note" rows={5} value={draft.content} maxLength={64_000} disabled={action.busy}
        onChange={(content) => setDraft({ ...draft, content })} />
      <div className={styles.inlineActions}>
        <button className="button small" type="button" disabled={action.busy} onClick={() => setDraft(undefined)}>Cancel</button>
        <button className="button small primary" type="submit" disabled={action.busy || !draft.title.trim()}>Save shared note</button>
      </div>
    </form>}
    {action.error && <Notice tone="error">{action.error}</Notice>}
    <ul className={styles.rows}>{notes.data?.items.map((note) => <li key={note.id} className={styles.row}>
      <details>
        <summary>{note.title}</summary>
        <p className="muted small-text">Added by {note.created_by_name} · Updated by {note.updated_by_name}</p>
        <KnowledgeMarkdown content={note.content} />
      </details>
      {canEdit && <div className={styles.inlineActions}>
        <button className="button small" type="button" disabled={action.busy} onClick={() => {
          setRemove(undefined); setDraft(note); action.setError(null);
        }}>Edit note</button>
        {remove?.id === note.id ? <>
          <button className="button small" type="button" disabled={action.busy} onClick={() => setRemove(undefined)}>Cancel removal</button>
          <button className="button small danger" type="button" disabled={action.busy} onClick={() => void action.run(async () => {
            await api(`${path}/${note.id}`, { method: 'DELETE', version: note.version });
            setRemove(undefined);
            if (draft?.id === note.id) setDraft(undefined);
          })}>Confirm note removal</button>
        </> : <button className="button small" type="button" disabled={action.busy} onClick={() => setRemove(note)}>Remove note</button>}
      </div>}
    </li>)}</ul>
  </section>;
}
