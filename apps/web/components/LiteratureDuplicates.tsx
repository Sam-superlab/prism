'use client';

import { useRef, useState } from 'react';
import { api, useAction, useResource, uuid } from '../lib/api';
import { citationKey, type BibliographyItem } from '../lib/bibliography';
import { ErrorState, Loading, Modal, Notice } from './ui';
import styles from './ResearchReferences.module.css';

type DuplicateGroup = {
  matched_by: 'doi' | 'arxiv_id' | 'title_author_year';
  value: string;
  references: BibliographyItem[];
};
const reasons = {
  doi: 'Same DOI',
  arxiv_id: 'Same arXiv ID',
  title_author_year: 'Similar title, first author, and year',
};

export function LiteratureDuplicates({ onClose, onMerged }: {
  onClose: () => void;
  onMerged: () => void;
}) {
  const duplicates = useResource<{ items: DuplicateGroup[]; truncated: boolean }>('/research/library/duplicates');
  const [group, setGroup] = useState<DuplicateGroup>();
  const [target, setTarget] = useState('');
  const [excluded, setExcluded] = useState<string[]>([]);
  const attempt = useRef<{ fingerprint: string; key: string }>(null);
  const action = useAction(() => {
    setGroup(undefined);
    duplicates.reload();
    onMerged();
  });
  const survivor = group?.references.find((item) => item.id === target);
  const sources = group?.references.filter((item) => item.id !== target && !excluded.includes(item.id)) ?? [];

  return (
    <Modal title="Duplicate references" onClose={() => { if (!action.busy) onClose(); }} wide>
      {duplicates.loading && <Loading />}
      <ErrorState error={duplicates.error} retry={duplicates.reload} />
      {action.error && <Notice tone="error">{action.error}</Notice>}
      {group ? (
        <>
          <p>Choose the record to keep. PRISM fills in missing metadata and combines tags, project links, and collections.</p>
          <fieldset>
            <legend>Record to keep</legend>
            <ul className={styles.rows}>
              {group.references.map((item) => (
                <li key={item.id} className={styles.row}>
                  <label>
                    <input type="radio" name="merge-target" checked={target === item.id} disabled={action.busy}
                      onChange={() => setTarget(item.id)} />
                    {' '}{item.title}
                    <span className={styles.rowMeta}>
                      {[item.authors.join(', '), item.year, citationKey(item)].filter(Boolean).join(' · ')}
                    </span>
                  </label>
                  {target !== item.id && (
                    <label>
                      <input type="checkbox" checked={!excluded.includes(item.id)} disabled={action.busy}
                        onChange={(event) => setExcluded((previous) => event.target.checked
                          ? previous.filter((id) => id !== item.id) : [...previous, item.id])} />
                      {' '}Merge this record
                    </label>
                  )}
                </li>
              ))}
            </ul>
          </fieldset>
          <p className="muted">Previous citation keys stay usable in PRISM. Review the canonical key in external BibTeX documents.</p>
          <div className="modal-footer">
            <button className="button" type="button" disabled={action.busy} onClick={() => {
              setGroup(undefined);
              action.setError(null);
            }}>Back</button>
            <button className="button primary" type="button"
              disabled={!survivor || action.busy || sources.length === 0 || sources.length > 20}
              onClick={() => {
                if (!survivor) return;
                const body = {
                  target_id: survivor.id,
                  target_version: survivor.version,
                  sources: sources.map(({ id, version }) => ({ id, version })),
                };
                const fingerprint = JSON.stringify(body);
                if (attempt.current?.fingerprint !== fingerprint) attempt.current = { fingerprint, key: uuid() };
                const key = attempt.current.key;
                void action.run(() => api('/research/library/merge', { method: 'POST', body, key }));
              }}>
              {action.busy ? 'Merging…' : 'Merge references'}
            </button>
          </div>
          {sources.length > 20 && <Notice tone="error">Select up to 20 records to merge into the record you keep.</Notice>}
        </>
      ) : !duplicates.loading && duplicates.data && (
        <>
          <p className="muted">Checks standalone library records for matching identifiers or title, author, and year.</p>
          {duplicates.data.items.length === 0 && <p>No duplicate candidates found.</p>}
          {duplicates.data.truncated && <p className="muted">More candidates appear after you review these groups.</p>}
          <ul className={styles.rows}>
            {duplicates.data.items.map((item) => (
              <li className={styles.row} key={`${item.matched_by}:${item.value}`}>
                <div>
                  <span className={styles.rowTitle}>{item.references[0]?.title}</span>
                  <span className={styles.rowMeta}>{reasons[item.matched_by]} · {item.references.length} records</span>
                </div>
                <button className="button small" type="button" onClick={() => {
                  setGroup(item);
                  setExcluded(item.references.slice(21).map(({ id }) => id));
                  setTarget(item.references[0]?.id ?? '');
                }}>Review</button>
              </li>
            ))}
          </ul>
        </>
      )}
    </Modal>
  );
}
