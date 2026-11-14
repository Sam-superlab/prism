'use client';

import { useRef, useState } from 'react';
import { api, useAction, uuid } from '../lib/api';
import { Field, Modal, Notice } from './ui';

export type LiteratureBatchItem = { id: string; title: string; version: string };
export type LiteratureBatchResult = { items: { id: string; version: string }[]; changed_count: number; undo_token: string | null };

export function LiteratureBatchEdit({ items, onClose, onSaved }: {
  items: readonly LiteratureBatchItem[]; onClose: () => void; onSaved: (result: LiteratureBatchResult) => void;
}) {
  const [formError, setFormError] = useState('');
  const attempt = useRef<{ body: string; key: string }>(null);
  const action = useAction();
  return <Modal title="Edit selected references" onClose={() => { if (!action.busy) onClose(); }} wide>
    <details><summary>{items.length} selected {items.length === 1 ? 'reference' : 'references'}</summary>
      <ul>{items.map((item) => <li key={item.id}>{item.title}</li>)}</ul>
    </details>
    <form onSubmit={(event) => {
      event.preventDefault();
      setFormError('');
      const values = new FormData(event.currentTarget);
      const value = (name: string) => String(values.get(name) ?? '').trim();
      const list = (name: string) => value(name).split(';').map((entry) => entry.trim()).filter(Boolean);
      const tags_add = list('add');
      const tags_remove = list('remove');
      if ([tags_add, tags_remove].some((tags) => tags.length > 40 || tags.some((tag) => tag.length > 64))) {
        setFormError('Enter up to 40 tags per field, with up to 64 characters per tag.');
        return;
      }
      const publication = Object.fromEntries(['type', 'journal', 'publisher'].filter((field) => values.has(`apply-${field}`))
        .map((field) => [field, value(field) || null]));
      const changes = {
        ...(tags_add.length && { tags_add }), ...(tags_remove.length && { tags_remove }),
        ...(values.has('apply-year') && { year: value('year') ? Number(value('year')) : null }),
        ...(Object.keys(publication).length && { publication }),
      };
      if (!Object.keys(changes).length) { setFormError('Choose at least one change.'); return; }
      const body = { items: items.map(({ id, version }) => ({ id, version })), changes };
      const serialized = JSON.stringify(body);
      if (attempt.current?.body !== serialized) attempt.current = { body: serialized, key: uuid() };
      void action.run(async () => {
        const result = await api<LiteratureBatchResult>('/research/library/batch-edit', {
          method: 'POST', body, key: attempt.current!.key,
        });
        onSaved(result);
      });
    }}>
      <Field label="Add tags" hint="Separate tags with semicolons."><input name="add" maxLength={2640} /></Field>
      <Field label="Remove tags"><input name="remove" maxLength={2640} /></Field>
      <div className="form-grid">
        <BatchField name="year" label="Year"><input name="year" type="number" min={1} max={9999} aria-label="Year" /></BatchField>
        <BatchField name="type" label="Publication type"><input name="type" maxLength={32} aria-label="Publication type" pattern="[A-Za-z][A-Za-z0-9\-]{0,31}" /></BatchField>
        <BatchField name="journal" label="Journal"><input name="journal" maxLength={2000} aria-label="Journal" /></BatchField>
        <BatchField name="publisher" label="Publisher"><input name="publisher" maxLength={2000} aria-label="Publisher" /></BatchField>
      </div>
      <p className="muted small-text">Check a field to apply it. Leave a checked field blank to clear its value.</p>
      {(action.error || formError) && <Notice tone="error">{action.error || formError}</Notice>}
      <div className="modal-footer">
        <button className="button" type="button" disabled={action.busy} onClick={onClose}>Cancel</button>
        <button className="button primary" type="submit" disabled={action.busy}>{action.busy ? 'Saving…' : 'Apply changes'}</button>
      </div>
    </form>
  </Modal>;
}

function BatchField({ name, label, children }: { name: string; label: string; children: React.ReactNode }) {
  const [enabled, setEnabled] = useState(false);
  return <div>
    <label><input type="checkbox" name={`apply-${name}`} checked={enabled} onChange={(event) => setEnabled(event.target.checked)} /> Set {label}</label>
    <fieldset disabled={!enabled} style={{ display: 'contents' }}>{children}</fieldset>
  </div>;
}
