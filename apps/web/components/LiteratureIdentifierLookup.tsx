'use client';

import { useState } from 'react';
import { api, useAction } from '../lib/api';
import type { ReferenceFields } from '../lib/bibliography';
import { Field, Modal, Notice } from './ui';

type Kind = 'doi' | 'isbn' | 'issn' | 'pmid' | 'pmcid' | 'arxiv';
export type LookupReference = Pick<ReferenceFields, 'title' | 'authors' | 'year' | 'doi' | 'arxiv_id' | 'url' | 'publication'>;
const sources = { doi: 'Crossref', isbn: 'Open Library', issn: 'Crossref', pmid: 'PubMed', pmcid: 'PubMed Central', arxiv: 'arXiv' };
const examples = { doi: '10.1000/xyz123', isbn: '978-0-19-853352-6', issn: '0003-486X', pmid: '12345678', pmcid: 'PMC7840891', arxiv: '2301.01234' };

export function LiteratureIdentifierLookup({ onClose, onReview }: {
  onClose: () => void; onReview: (fields: LookupReference) => void;
}) {
  const [kind, setKind] = useState<Kind>('doi');
  const [value, setValue] = useState('');
  const action = useAction();
  return (
    <Modal title="Look up an identifier" onClose={() => { if (!action.busy) onClose(); }}>
      <form onSubmit={(event) => {
        event.preventDefault();
        const identifier = value.trim();
        if (!identifier || action.busy) return;
        const params = new URLSearchParams({ kind, value: identifier });
        void action.run(async () => {
          const result = await api<{ reference: LookupReference }>(`/research/library/lookup?${params}`);
          onReview(result.reference);
        });
      }}>
        <Field label="Identifier type">
          <select value={kind} disabled={action.busy} onChange={(event) => {
            setKind(event.target.value as Kind);
            setValue('');
            action.setError(null);
          }}>
            <option value="doi">DOI</option>
            <option value="isbn">ISBN</option>
            <option value="issn">ISSN (journal)</option>
            <option value="pmid">PubMed ID</option>
            <option value="pmcid">PubMed Central ID</option>
            <option value="arxiv">arXiv ID</option>
          </select>
        </Field>
        <Field label="Identifier">
          <input value={value} maxLength={300} required disabled={action.busy} placeholder={examples[kind]}
            onChange={(event) => { setValue(event.target.value); action.setError(null); }} />
        </Field>
        <p className="muted">{kind === 'issn' ? 'Looks up the journal through Crossref.' : `Looks up this identifier through ${sources[kind]}.`} Review the result before saving it.</p>
        {action.error && <Notice tone="error">{action.error}</Notice>}
        <div className="modal-footer">
          <button className="button primary" type="submit" disabled={!value.trim() || action.busy}>
            {action.busy ? 'Looking up…' : 'Look up'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
