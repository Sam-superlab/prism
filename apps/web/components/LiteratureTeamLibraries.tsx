'use client';

import dynamic from 'next/dynamic';
import { useState } from 'react';
import Link from 'next/link';
import { api, useAction, useResource, uuid } from '../lib/api';
import type { Page } from '../lib/types';
import type { BibliographyItem, Publication } from '../lib/bibliography';
import { ErrorState, Field, Loading, Modal, Notice } from './ui';
import { LiteratureTeamAttachments } from './LiteratureTeamAttachments';
import { LiteratureTeamNotes } from './LiteratureTeamNotes';
import styles from './ResearchReferences.module.css';

type Role = 'admin' | 'editor' | 'reader';
type Visibility = 'private' | 'public_closed' | 'public_open';
type Team = { id: string; name: string; description: string; role: Role; created_by: string; updated_by: string; version: string; visibility?: Visibility };
type Member = { user_id: string; display_name: string; role: Role; version: string };
type Reference = { id: string; title: string; authors: string[]; year: number | null; doi: string | null;
  url: string | null; publication: Publication; created_by: string; updated_by: string;
  created_by_name?: string; updated_by_name?: string; version: string; tags?: string[] };
const root = '/team-libraries';
const visibilityNames = { private: 'Private', public_closed: 'Public · invitation required', public_open: 'Public · open membership' } as const;
const TeamPdfReader = dynamic(() => import('./LiteratureTeamPdfReader').then((module) => module.LiteratureTeamPdfReader));

export function LiteratureTeamLibraries({ userId, onClose }: {
  userId?: string; onClose: () => void;
}) {
  const groups = useResource<{ items: Team[] }>(root);
  const [selected, setSelected] = useState('');
  const [form, setForm] = useState<'new' | 'edit'>();
  const [confirm, setConfirm] = useState(false);
  const [creationId, setCreationId] = useState(uuid);
  const [copyStatus, setCopyStatus] = useState('');
  const [visibility, setVisibility] = useState<Visibility>('private');
  const [publicationConfirmed, setPublicationConfirmed] = useState(false);
  const [reading, setReading] = useState<{ path: string; name: string }>();
  const team = groups.data?.items.find((entry) => entry.id === selected);
  const action = useAction(groups.reload);
  return <><Modal title="Team libraries" onClose={() => { if (!action.busy) onClose(); }} wide suspended={!!reading}>
    <div className={styles.inlineActions}>
      {groups.data?.items.length ? <Field label="Team library"><select value={selected}
        disabled={action.busy} onChange={(event) => {
          setSelected(event.target.value); setForm(undefined); setConfirm(false); action.setError(null);
        }}>
        <option value="">Choose a team library</option>
        {groups.data.items.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
      </select></Field> : null}
      <button className="button small" type="button" disabled={action.busy} onClick={() => {
        setForm('new'); setConfirm(false); setCreationId(uuid()); action.setError(null);
      }}>New team library</button>
      <Link className="button small" href="/team-library-discovery" prefetch={false}>Browse public libraries</Link>
      {userId && <button className="button small" type="button" onClick={() => {
        void navigator.clipboard.writeText(userId).then(() => setCopyStatus('Workspace user ID copied.'))
          .catch(() => setCopyStatus(userId));
      }}>Copy my user ID</button>}
      {team?.role === 'admin' && <>
        <button className="button small" type="button" disabled={action.busy} onClick={() => {
          setForm('edit'); setConfirm(false); setVisibility(team.visibility ?? 'private'); setPublicationConfirmed(false); action.setError(null);
        }}>Edit library</button>
        <button className="button small" type="button" disabled={action.busy} onClick={() => {
          setForm(undefined); setConfirm(!confirm); action.setError(null);
        }}>{confirm ? 'Cancel removal' : 'Remove library'}</button>
      </>}
    </div>
    {copyStatus && <p role="status" className="small-text">{copyStatus}</p>}
    {confirm && team && <div className={styles.inlineActions}>
      <p className="muted">Remove {team.name} and its shared references?</p>
      <button type="button" className="button small danger" disabled={action.busy} onClick={() => void action.run(async () => {
        await api(`${root}/${team.id}`, { method: 'DELETE', version: team.version });
        setSelected(''); setConfirm(false);
      })}>Confirm library removal</button>
    </div>}
    {form && <form key={form} onSubmit={(event) => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      const name = String(data.get('name') ?? '').trim();
      const description = String(data.get('description') ?? '').trim();
      if (!name) return;
      if (form === 'edit' && visibility !== 'private' && visibility !== team?.visibility && !publicationConfirmed) return;
      void action.run(async () => {
        const saved = form === 'edit' && team
          ? await api<Team>(`${root}/${team.id}`, { method: 'PATCH', version: team.version, body: { name, description, visibility } })
          : await api<Team>(root, { method: 'POST', body: { id: creationId, name, description } });
        setSelected(saved.id); setForm(undefined);
      });
    }}>
      <Field label="Library name"><input name="name" defaultValue={form === 'edit' ? team?.name : ''} required maxLength={120} autoFocus /></Field>
      <Field label="Description"><textarea name="description" defaultValue={form === 'edit' ? team?.description : ''} rows={2} maxLength={2000} /></Field>
      {form === 'edit' && <Field label="Visibility"><select value={visibility} onChange={(event) => {
        setVisibility(event.target.value as Visibility); setPublicationConfirmed(false);
      }}>{Object.entries(visibilityNames).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field>}
      {form === 'edit' && visibility !== 'private' && visibility !== team?.visibility && <label>
        <input type="checkbox" checked={publicationConfirmed} onChange={(event) => setPublicationConfirmed(event.target.checked)} required />
        {' '}Publish this library’s name, description, and shared bibliography to anyone with internet access.
      </label>}
      <div className={styles.inlineActions}>
        <button className="button small" type="button" disabled={action.busy} onClick={() => setForm(undefined)}>Cancel</button>
        <button className="button small primary" type="submit" disabled={action.busy}>Save library</button>
      </div>
    </form>}
    {action.error && <Notice tone="error">{action.error}</Notice>}
    <ErrorState error={groups.error} retry={groups.reload} />
    {groups.loading && <Loading />}
    {!groups.loading && groups.data?.items.length === 0 && !form && <p className="muted">No team libraries yet.</p>}
    {team && <TeamContents key={team.id} team={team} reloadTeam={groups.reload}
      onRead={(path, name) => setReading({ path, name })} />}
  </Modal>
  {team && reading && <TeamPdfReader attachmentPath={reading.path} fileName={reading.name}
    role={team.role} userId={userId} onClose={() => setReading(undefined)} />}
  </>;
}

function TeamContents({ team, reloadTeam, onRead }: {
  team: Team; reloadTeam: () => void; onRead: (path: string, name: string) => void;
}) {
  const path = `${root}/${team.id}`;
  const members = useResource<{ items: Member[] }>(team.role === 'admin' ? `${path}/members` : null);
  const [cursorStack, setCursorStack] = useState<string[]>([]);
  const cursor = cursorStack.at(-1);
  const references = useResource<Page<Reference>>(`${path}/references?limit=25${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
  const [referenceForm, setReferenceForm] = useState<'new' | 'copy' | Reference>();
  const [draftId, setDraftId] = useState(uuid);
  const [personalSearch, setPersonalSearch] = useState('');
  const [personalQuery, setPersonalQuery] = useState('');
  const personal = useResource<Page<BibliographyItem>>(referenceForm === 'copy'
    ? `/research/library?native=true&limit=25&q=${encodeURIComponent(personalQuery)}` : null);
  const [memberForm, setMemberForm] = useState(false);
  const [removing, setRemoving] = useState('');
  const [expandedFiles, setExpandedFiles] = useState('');
  const [expandedNotes, setExpandedNotes] = useState('');
  const action = useAction(references.reload);
  const membership = useAction(() => { members.reload(); reloadTeam(); });
  const canEdit = team.role !== 'reader';
  const person = (id: string) => members.data?.items.find((item) => item.user_id === id)?.display_name || 'Former member';
  const beginReference = (mode: typeof referenceForm) => { setDraftId(uuid()); setReferenceForm(mode); action.setError(null); };

  return <>
    <section className={styles.referenceNotes} aria-label="Team references">
      <h3>{team.name}</h3>
      {team.description && <p>{team.description}</p>}
      <span className="muted small-text">{visibilityNames[team.visibility ?? 'private']} · {team.role}</span>
      {team.visibility && team.visibility !== 'private' && <Link className="text-link" href={`/team-library-discovery?library=${team.id}`} prefetch={false}>View public bibliography</Link>}
      {canEdit && <div className={styles.inlineActions}>
        <button className="button small" type="button" disabled={action.busy} onClick={() => beginReference('new')}>Add team reference</button>
        <button className="button small" type="button" disabled={action.busy}
          onClick={() => beginReference('copy')}>Copy from my library</button>
      </div>}
      {referenceForm && <form key={typeof referenceForm === 'string' ? referenceForm : referenceForm.id} onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        const field = (name: string) => String(data.get(name) ?? '').trim();
        const year = field('year');
        const bibliographic = { title: field('title'), authors: field('authors').split(';').map((value) => value.trim()).filter(Boolean),
          year: year ? Number(year) : null, doi: field('doi') || null, url: field('url') || null,
          tags: field('tags').split(';').map((value) => value.trim()).filter(Boolean) };
        void action.run(async () => {
          if (referenceForm === 'copy') await api(`${path}/references`, { method: 'POST', body: { id: draftId, reference_id: field('reference') } });
          else if (referenceForm === 'new') await api(`${path}/references`, { method: 'POST', body: { id: draftId, ...bibliographic } });
          else await api(`${path}/references/${referenceForm.id}`, { method: 'PATCH', version: referenceForm.version, body: bibliographic });
          setCursorStack([]); setReferenceForm(undefined);
        });
      }}>
        {referenceForm === 'copy' ? <>
          <div className={styles.inlineActions}>
            <input type="search" aria-label="Search my library" maxLength={300} value={personalSearch}
              onChange={(event) => setPersonalSearch(event.target.value)} onKeyDown={(event) => {
                if (event.key === 'Enter') { event.preventDefault(); setPersonalQuery(personalSearch.trim()); }
              }} />
            <button type="button" className="button small" onClick={() => setPersonalQuery(personalSearch.trim())}>Search</button>
          </div>
          <ErrorState error={personal.error} retry={personal.reload} />
          <Field label="Personal reference" hint="The team receives a copy of the bibliographic fields.">
          <select name="reference" required defaultValue=""><option value="" disabled>Choose a reference</option>
            {!personal.loading && personal.data?.items.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
          </select>
          </Field>
        </> : <>
          <Field label="Title"><input name="title" required maxLength={500} defaultValue={typeof referenceForm === 'object' ? referenceForm.title : ''} /></Field>
          <Field label="Authors" hint="Separate names with semicolons."><input name="authors" maxLength={4000}
            defaultValue={typeof referenceForm === 'object' ? referenceForm.authors.join('; ') : ''} /></Field>
          <div className="form-grid">
            <Field label="Year"><input name="year" type="number" min={1} max={9999}
              defaultValue={typeof referenceForm === 'object' ? referenceForm.year ?? '' : ''} /></Field>
            <Field label="DOI"><input name="doi" maxLength={280} defaultValue={typeof referenceForm === 'object' ? referenceForm.doi ?? '' : ''} /></Field>
          </div>
          <Field label="URL"><input name="url" type="url" maxLength={2000}
            defaultValue={typeof referenceForm === 'object' ? referenceForm.url ?? '' : ''} /></Field>
          <Field label="Team tags" hint="Separate tags with semicolons."><input name="tags" maxLength={2640}
            defaultValue={typeof referenceForm === 'object' ? referenceForm.tags?.join('; ') ?? '' : ''} /></Field>
        </>}
        <div className={styles.inlineActions}>
          <button className="button small" type="button" disabled={action.busy} onClick={() => beginReference(undefined)}>Cancel</button>
          <button className="button small primary" type="submit" disabled={action.busy}>Save team reference</button>
        </div>
      </form>}
      <ErrorState error={references.error} retry={references.reload} />
      {references.loading && <Loading />}
      {!references.loading && references.data?.items.length === 0 && <p className="muted">No shared references yet.</p>}
      {action.error && <Notice tone="error">{action.error}</Notice>}
      <ul className={styles.rows}>{references.data?.items.map((item) => <li key={item.id} className={styles.row}>
        <div><p>{item.title}</p><span className="muted small-text">{[item.authors.join(', '), item.year, item.publication?.journal].filter(Boolean).join(' · ')}</span>
          <p className="muted small-text">Added by {item.created_by_name ?? person(item.created_by)} · Updated by {item.updated_by_name ?? person(item.updated_by)}</p>
          {!!item.tags?.length && <p className="muted small-text">{item.tags.join(' · ')}</p>}
          {team.visibility !== 'public_open' && <>
            <button className="button small" type="button" aria-expanded={expandedFiles === item.id}
              onClick={() => setExpandedFiles(expandedFiles === item.id ? '' : item.id)}>Shared PDFs</button>
            {expandedFiles === item.id && <LiteratureTeamAttachments referencePath={`${path}/references/${item.id}`} canEdit={canEdit} onRead={onRead} />}
            <button className="button small" type="button" aria-expanded={expandedNotes === item.id}
              onClick={() => setExpandedNotes(expandedNotes === item.id ? '' : item.id)}>Shared notes</button>
            {expandedNotes === item.id && <LiteratureTeamNotes referencePath={`${path}/references/${item.id}`} canEdit={canEdit} />}
          </>}
        </div>
        {canEdit && <div className={styles.inlineActions}>
          <button type="button" className="button small" disabled={action.busy} onClick={() => beginReference(item)}>Edit</button>
          <button type="button" className="button small" disabled={action.busy} onClick={() => setRemoving(removing === item.id ? '' : item.id)}>
            {removing === item.id ? 'Cancel removal' : 'Remove'}
          </button>
          {removing === item.id && <button type="button" className="button small danger" disabled={action.busy} onClick={() => void action.run(async () => {
            await api(`${path}/references/${item.id}`, { method: 'DELETE', version: item.version });
            setRemoving('');
          })}>Confirm removal</button>}
        </div>}
      </li>)}</ul>
      {(cursor || references.data?.next_cursor) && <div className={styles.pagination}>
        <button className="button small" type="button" disabled={!cursor} onClick={() => setCursorStack((stack) => stack.slice(0, -1))}>Previous references</button>
        <button className="button small" type="button" disabled={!references.data?.next_cursor} onClick={() => {
          const next = references.data?.next_cursor;
          if (next) setCursorStack((stack) => [...stack, next]);
        }}>Next references</button>
      </div>}
    </section>
    {team.role === 'admin' && <section className={styles.referenceNotes} aria-label="Team members">
      <h3>Members</h3>
      {team.role === 'admin' && <div><button type="button" className="button small" disabled={membership.busy}
        onClick={() => { setMemberForm(!memberForm); membership.setError(null); }}>{memberForm ? 'Cancel member form' : 'Add member'}</button></div>}
      {memberForm && team.role === 'admin' && <form onSubmit={(event) => {
        event.preventDefault();
        const values = new FormData(event.currentTarget);
        void membership.run(async () => {
          await api(`${path}/members`, { method: 'POST', body: { user_id: String(values.get('member')).trim(), role: values.get('role') } });
          setMemberForm(false);
        });
      }}>
        <Field label="Workspace user ID"><input name="member" required maxLength={36} /></Field>
        <Field label="Role"><RolePicker name="role" value="reader" /></Field>
        <button className="button small primary" type="submit" disabled={membership.busy}>Save member</button>
      </form>}
      <ErrorState error={members.error} retry={members.reload} />
      {membership.error && <Notice tone="error">{membership.error}</Notice>}
      <ul className={styles.rows}>{members.data?.items.map((member) => <li className={styles.row} key={member.user_id}>
        <span>{member.display_name}</span>
        {team.role === 'admin' && member.user_id !== team.created_by ? <div className={styles.inlineActions}>
          <RolePicker label={`Role for ${member.display_name}`} value={member.role} disabled={membership.busy} onChange={(role) => {
            void membership.run(() => api(`${path}/members/${member.user_id}`, { method: 'PATCH', version: member.version, body: { role } }));
          }} />
          <button className="button small" type="button" disabled={membership.busy} onClick={() => {
            void membership.run(() => api(`${path}/members/${member.user_id}`, { method: 'DELETE', version: member.version }));
          }}>Remove member</button>
        </div> : <span className="muted small-text">{member.role}</span>}
      </li>)}</ul>
    </section>}
  </>;
}

function RolePicker({ name, label, value, disabled, onChange }: {
  name?: string; label?: string; value: Role; disabled?: boolean; onChange?: (role: Role) => void;
}) {
  return <select name={name} aria-label={label} disabled={disabled} {...(onChange ? { value } : { defaultValue: value })}
    onChange={(event) => onChange?.(event.target.value as Role)}>
    <option value="reader">Reader</option><option value="editor">Editor</option><option value="admin">Admin</option>
  </select>;
}
