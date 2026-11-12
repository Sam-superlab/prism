'use client';

import { useEffect, useRef, useState } from 'react';
import { api, useAction, useResource, uuid } from '../lib/api';
import { desktopFocusBridge } from '../lib/focus-alerts';
import {
  bibliographyBibtex,
  citationKey,
  referenceUrl,
  zoteroKeyPattern,
  type BibliographyItem,
  type ReferenceFields,
  type ZoteroCollection,
  type ZoteroPage,
} from '../lib/zotero-reference';
import { ErrorState, Field, Icon, KnowledgeMarkdown, Loading, Modal, Notice } from './ui';
import styles from './ResearchReferences.module.css';

type Bibliography = { items: BibliographyItem[] };

export function useProjectBibliography(projectId: string) {
  return useResource<Bibliography>(`/research/projects/${projectId}/bibliography`);
}

function authorYear(item: ReferenceFields) {
  return [item.authors.join(', '), item.year].filter(Boolean).join(' · ');
}

function sameReference(a: ReferenceFields, b: ReferenceFields) {
  return (
    (a.zotero_key && a.zotero_key === b.zotero_key) ||
    (a.doi && a.doi.toLowerCase() === b.doi?.toLowerCase()) ||
    (a.arxiv_id && a.arxiv_id.toLowerCase() === b.arxiv_id?.toLowerCase())
  );
}

export function ResearchReferences({
  projectId,
  bibliography,
  onAddPaper,
}: {
  projectId: string;
  bibliography: ReturnType<typeof useProjectBibliography>;
  onAddPaper?: () => void;
}) {
  const [dialog, setDialog] = useState<'manual' | 'zotero' | null>(null);
  const [desktop, setDesktop] = useState(false);
  useEffect(() => setDesktop(Boolean(desktopFocusBridge())), []);
  const items = bibliography.data?.items ?? [];
  const action = useAction(bibliography.reload);
  useEffect(() => {
    const hash = window.location.hash.slice(1);
    if (bibliography.data && /^reference-[a-f0-9-]{36}$/i.test(hash))
      document.getElementById(hash)?.scrollIntoView({ block: 'nearest' });
  }, [bibliography.data]);

  function downloadBibtex() {
    const url = URL.createObjectURL(
      new Blob([bibliographyBibtex(items)], { type: 'text/plain;charset=utf-8' }),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = 'references.bib';
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return (
    <section className={`panel content-panel ${styles.references}`} aria-label="References">
      <h2>References</h2>
      <div className={styles.actions}>
        {onAddPaper && (
          <button className="button small" type="button" onClick={onAddPaper}>
            Choose paper
          </button>
        )}
        <button className="button small" type="button" onClick={() => setDialog('manual')}>
          <Icon name="plus" size={15} /> Add reference
        </button>
        {desktop && (
          <button className="button small" type="button" onClick={() => setDialog('zotero')}>
            Browse Zotero
          </button>
        )}
        {items.length > 0 && (
          <button className="button small" type="button" onClick={downloadBibtex}>
            Export BibTeX
          </button>
        )}
      </div>
      <ErrorState error={bibliography.error} retry={bibliography.reload} />
      {action.error && <Notice tone="error">{action.error}</Notice>}
      {bibliography.loading && !bibliography.data && <Loading />}
      {bibliography.data && !items.length && (
        <p className="muted small-text">Add a reference or link a paper from Discover.</p>
      )}
      <ul className={styles.rows}>
        {items.map((item) => {
          const url = referenceUrl(item);
          return (
            <li className={styles.row} key={`${item.kind}:${item.id}`} id={`reference-${item.id}`}>
              <div>
                {url ? (
                  <a className={`text-link ${styles.rowTitle}`} href={url} target="_blank" rel="noreferrer">
                    {item.title}
                  </a>
                ) : (
                  <span className={styles.rowTitle}>{item.title}</span>
                )}
                <span className={`small-text muted ${styles.rowMeta}`}>{authorYear(item)}</span>
                <div className={styles.inlineActions}>
                  {desktop && item.zotero_key && zoteroKeyPattern.test(item.zotero_key) && (
                    <a
                      className="text-link small-text"
                      href={`zotero://select/library/items/${item.zotero_key}`}
                    >
                      Open in Zotero
                    </a>
                  )}
                </div>
              </div>
              {item.kind === 'reference' && (
                <button
                  className="icon-button"
                  type="button"
                  aria-label={`Remove reference ${item.title}`}
                  disabled={action.busy}
                  onClick={() =>
                    void action.run(() =>
                      api(`/research/references/${item.id}`, { method: 'DELETE', version: item.version }),
                    )
                  }
                >
                  <Icon name="close" size={15} />
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {dialog === 'manual' && (
        <ManualReference
          projectId={projectId}
          onClose={() => setDialog(null)}
          onAdded={() => {
            setDialog(null);
            bibliography.reload();
          }}
        />
      )}
      {dialog === 'zotero' && (
        <ZoteroBrowser
          projectId={projectId}
          existing={items}
          onClose={() => setDialog(null)}
          onAdded={bibliography.reload}
        />
      )}
    </section>
  );
}

function ManualReference({
  projectId,
  onClose,
  onAdded,
}: {
  projectId: string;
  onClose: () => void;
  onAdded: () => void;
}) {
  const action = useAction(onAdded);
  const [id] = useState(uuid);
  return (
    <Modal title="Add reference" onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          const value = (name: string) => String(data.get(name) ?? '').trim();
          const year = value('year');
          void action.run(() =>
            api('/research/references', {
              method: 'POST',
              body: {
                id,
                project_id: projectId,
                title: value('title'),
                authors: value('authors')
                  .split(';')
                  .map((author) => author.trim())
                  .filter(Boolean),
                year: year ? Number(year) : null,
                doi: value('doi').replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '') || null,
                arxiv_id: value('arxiv_id').replace(/^arxiv:\s*/i, '') || null,
                url: value('url') || null,
              },
            }),
          );
        }}
      >
        <Field label="Title">
          <input name="title" required maxLength={500} />
        </Field>
        <Field label="Authors" hint="Separate authors with semicolons.">
          <input name="authors" maxLength={4000} />
        </Field>
        <div className="form-grid">
          <Field label="Year">
            <input name="year" type="number" min={1} max={9999} />
          </Field>
          <Field label="DOI">
            <input name="doi" maxLength={280} />
          </Field>
        </div>
        <div className="form-grid">
          <Field label="arXiv ID">
            <input name="arxiv_id" maxLength={80} />
          </Field>
          <Field label="URL">
            <input name="url" type="url" maxLength={2000} />
          </Field>
        </div>
        {action.error && <Notice tone="error">{action.error}</Notice>}
        <div className="modal-footer">
          <button className="button primary" disabled={action.busy}>
            Save reference
          </button>
        </div>
      </form>
    </Modal>
  );
}

function ZoteroBrowser({
  projectId,
  existing,
  onClose,
  onAdded,
}: {
  projectId: string;
  existing: BibliographyItem[];
  onClose: () => void;
  onAdded: () => void;
}) {
  const [collection, setCollection] = useState<ZoteroCollection | null>(null);
  const [collectionOffset, setCollectionOffset] = useState(0);
  const [offset, setOffset] = useState(0);
  const [query, setQuery] = useState('');
  const [added, setAdded] = useState<ReferenceFields[]>([]);
  const [busyItem, setBusyItem] = useState<string | null>(null);
  const ids = useRef(new Map<string, string>());
  const collections = useResource<ZoteroPage<ZoteroCollection>>(
    collection ? null : `/zotero?start=${collectionOffset}`,
  );
  const results = useResource<ZoteroPage<ReferenceFields>>(
    collection ? `/zotero?collection=${collection.key}&start=${offset}&q=${encodeURIComponent(query)}` : null,
  );
  const action = useAction(onAdded);

  async function add(item: ReferenceFields) {
    if (!item.zotero_key) return;
    const key = item.zotero_key;
    const id = ids.current.get(key) ?? uuid();
    ids.current.set(key, id);
    setBusyItem(key);
    await action.run(async () => {
      await api('/research/references', {
        method: 'POST',
        body: { ...item, id, project_id: projectId },
      });
      setAdded((saved) => [...saved, item]);
    });
    setBusyItem(null);
  }

  return (
    <Modal title="Browse Zotero" onClose={onClose}>
      <p className="modal-description">
        Choose a collection, then add individual references to this project.
      </p>
      {action.error && <Notice tone="error">{action.error}</Notice>}
      {collection ? (
        <>
          <div className={styles.toolbar}>
            <button className="button small" type="button" onClick={() => setCollection(null)}>
              Back to collections
            </button>
            <strong>{collection.name}</strong>
          </div>
          <form
            className={styles.toolbar}
            onSubmit={(event) => {
              event.preventDefault();
              setQuery(String(new FormData(event.currentTarget).get('q') ?? '').trim());
              setOffset(0);
            }}
          >
            <input
              aria-label="Search this collection"
              name="q"
              maxLength={120}
              placeholder="Search this collection"
            />
            <button className="button small" type="submit">
              Search
            </button>
          </form>
          <ErrorState error={results.error} retry={results.reload} />
          {results.loading && <Loading />}
          {!results.loading && !results.error && results.data && (
            <>
              {!results.data.items.length && <p className="muted">No references on this page.</p>}
              <ul className={styles.rows}>
                {results.data.items.map((item) => {
                  const saved = [...existing, ...added].some((reference) => sameReference(reference, item));
                  return (
                    <li key={item.zotero_key} className={styles.row}>
                      <div>
                        <span className={styles.rowTitle}>{item.title}</span>
                        <span className={`small-text muted ${styles.rowMeta}`}>{authorYear(item)}</span>
                      </div>
                      <button
                        className="button small"
                        type="button"
                        disabled={saved || action.busy}
                        onClick={() => void add(item)}
                      >
                        {saved ? 'Added' : busyItem === item.zotero_key ? 'Adding…' : 'Add reference'}
                      </button>
                    </li>
                  );
                })}
              </ul>
              <PageButtons offset={offset} next={results.data.next} setOffset={setOffset} />
            </>
          )}
        </>
      ) : (
        <>
          <ErrorState error={collections.error} retry={collections.reload} />
          {collections.loading && <Loading />}
          {!collections.loading && !collections.error && collections.data && (
            <>
              {!collections.data.items.length && <p className="muted">No collections on this page.</p>}
              <ul className={styles.rows}>
                {collections.data.items.map((item) => (
                  <li className={styles.row} key={item.key}>
                    <button
                      type="button"
                      className={`button small ${styles.collection}`}
                      onClick={() => {
                        setOffset(0);
                        setQuery('');
                        setCollection(item);
                      }}
                    >
                      {item.name}
                    </button>
                  </li>
                ))}
              </ul>
              <PageButtons
                offset={collectionOffset}
                next={collections.data.next}
                setOffset={setCollectionOffset}
              />
            </>
          )}
        </>
      )}
    </Modal>
  );
}

function PageButtons({
  offset,
  next,
  setOffset,
}: {
  offset: number;
  next: number | null;
  setOffset: (offset: number) => void;
}) {
  if (!offset && next === null) return null;
  return (
    <div className={styles.pagination}>
      <button
        className="button small"
        type="button"
        disabled={!offset}
        onClick={() => setOffset(Math.max(0, offset - 25))}
      >
        Previous page
      </button>
      <button
        className="button small"
        type="button"
        disabled={next === null}
        onClick={() => next !== null && setOffset(next)}
      >
        Next page
      </button>
    </div>
  );
}

export function CitationField({
  label,
  value,
  onChange,
  references,
  rows,
  required,
  preview,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  references: BibliographyItem[];
  rows: number;
  required?: boolean;
  preview?: boolean;
}) {
  const input = useRef<HTMLTextAreaElement>(null);
  const [key, setKey] = useState('');
  function insert() {
    const textarea = input.current;
    if (!textarea || !references.some((reference) => citationKey(reference) === key)) return;
    const start = textarea.selectionStart;
    const token = `[@${key}]`;
    onChange(value.slice(0, start) + token + value.slice(textarea.selectionEnd));
    requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(start + token.length, start + token.length);
    });
  }
  return (
    <>
      <Field label={label}>
        <textarea
          ref={input}
          required={required}
          rows={rows}
          className="code-editor"
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      </Field>
      {(references.length > 0 || preview) && (
        <div className={styles.citationControls}>
          {references.length > 0 && (
            <div className={styles.toolbar}>
              <select
                aria-label={`Reference for ${label}`}
                value={key}
                onChange={(event) => setKey(event.target.value)}
              >
                <option value="">Choose a reference</option>
                {references.map((item) => (
                  <option key={citationKey(item)} value={citationKey(item)}>
                    {item.title}
                  </option>
                ))}
              </select>
              <button className="button small" type="button" disabled={!key} onClick={insert}>
                Insert citation
              </button>
            </div>
          )}
          {preview && value && (
            <details>
              <summary>Rendered preview</summary>
              <ResearchMarkdown content={value} references={references} />
            </details>
          )}
        </div>
      )}
    </>
  );
}

export function ResearchMarkdown({
  content,
  references,
}: {
  content: string;
  references: BibliographyItem[];
}) {
  const citations = Object.fromEntries(
    references.map((item) => [
      citationKey(item),
      [item.authors[0]?.split(',')[0] || item.title, item.year].filter(Boolean).join(', '),
    ]),
  );
  return <KnowledgeMarkdown content={content} citations={citations} />;
}
