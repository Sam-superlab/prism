'use client';

import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { uuid } from '../lib/api';
import {
  customCitationStyleLimit,
  customCitationStyleMaxBytes,
  readCustomCitationStyles,
  saveCustomCitationStyles,
  validateCustomCitationStyle,
  type CustomLiteratureCitationStyle,
} from '../lib/bibliography-custom-csl';
import { citationKey, type BibliographyItem } from '../lib/bibliography';
import { Field, Modal, Notice } from './ui';
import type { LiteratureCitationDetail, LiteratureCitationStyle } from '../lib/bibliography-csl';
import styles from './LiteratureCitationPreview.module.css';

type Engine = typeof import('../lib/bibliography-csl');
const stylePreferenceKey = 'prism.literature.csl-selected.v1';
const referenceId = (item: BibliographyItem) => `${item.kind}:${item.id}`;
const normalizedSearch = (value: string) =>
  value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().trim();

export function LiteratureCitationPreview({
  load,
  onClose,
}: {
  load: (signal: AbortSignal) => Promise<readonly BibliographyItem[]>;
  onClose: () => void;
}) {
  const [excluded, setExcluded] = useState<Set<string>>(() => new Set());
  const [style, setStyle] = useState('apa');
  const [custom, setCustom] = useState<CustomLiteratureCitationStyle[]>([]);
  const [styleError, setStyleError] = useState('');
  const [installing, setInstalling] = useState(false);
  const generation = useRef(0);
  useEffect(() => {
    const styles = readCustomCitationStyles(localStorage);
    setCustom(styles);
    try {
      const preferred = localStorage.getItem(stylePreferenceKey);
      if (
        preferred &&
        (styles.some((entry) => entry.id === preferred) ||
          ['apa', 'ieee', 'chicago-author-date'].includes(preferred))
      )
        setStyle(preferred);
    } catch {
      // Citation formatting remains usable without browser storage.
    }
    return () => {
      generation.current++;
    };
  }, []);
  const [styleQuery, setStyleQuery] = useState('');
  const [referenceQuery, setReferenceQuery] = useState('');
  const deferredReferenceQuery = useDeferredValue(referenceQuery);
  const [details, setDetails] = useState<Record<string, LiteratureCitationDetail>>({});
  const [editingReference, setEditingReference] = useState('');
  const [status, setStatus] = useState('');
  const [failure, setFailure] = useState('');
  const [data, setData] = useState<{ engine: Engine; items: readonly BibliographyItem[] }>();
  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([import('../lib/bibliography-csl'), load(controller.signal)])
      .then(([engine, items]) => {
        if (!controller.signal.aborted) setData({ engine, items });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setFailure(error instanceof Error ? error.message : 'Could not load references.');
      });
    return () => controller.abort();
  }, [load]);
  function selectStyle(id: string) {
    setStyle(id);
    setStatus('');
    setStyleError('');
    try {
      localStorage.setItem(stylePreferenceKey, id);
    } catch {
      // Keep the selected style for this dialog.
    }
  }

  function editDetail(key: string, changes: Partial<LiteratureCitationDetail>) {
    setDetails((previous) => ({ ...previous, [key]: { ...previous[key], ...changes } }));
    setStatus('');
  }

  function persistStyles(next: CustomLiteratureCitationStyle[]) {
    setCustom(next);
    try {
      saveCustomCitationStyles(localStorage, next);
    } catch {
      setStyleError(
        'Could not save styles on this device. Your change is available until you close this dialog.',
      );
    }
  }

  async function installStyle(file: File) {
    if (!data || installing) return;
    setStyleError('');
    setStatus('');
    if (custom.length >= customCitationStyleLimit) {
      setStyleError('Remove an imported style before adding another.');
      return;
    }
    const sequence = ++generation.current;
    setInstalling(true);
    try {
      if (file.size > customCitationStyleMaxBytes) throw new Error('Choose a citation style under 250 KB.');
      const validated = validateCustomCitationStyle(await file.text());
      if (generation.current !== sequence) return;
      const existing = custom.find((entry) => entry.xml === validated.xml);
      if (existing) {
        selectStyle(existing.id);
        return;
      }
      const next = { id: 'custom-' + uuid(), ...validated };
      const sample = data.items.length
        ? data.items.slice(0, 2)
        : [
            {
              id: 'sample',
              version: '1',
              kind: 'reference' as const,
              title: 'Sample article',
              authors: ['Example, Ada'],
              year: 2024,
              doi: null,
              arxiv_id: null,
              url: null,
              zotero_key: null,
              publication: { type: 'article', journal: 'Example Journal' },
            },
          ];
      data.engine.formatLiteratureCitations(sample, next);
      selectStyle(next.id);
      persistStyles([...custom, next]);
    } catch (cause) {
      if (generation.current === sequence)
        setStyleError(cause instanceof Error ? cause.message : 'Could not import this citation style.');
    } finally {
      if (generation.current === sequence) setInstalling(false);
    }
  }

  const references = useMemo(
    () =>
      data?.items.map((item) => ({
        item,
        key: referenceId(item),
        search: normalizedSearch(
          [item.title, ...item.authors, item.year, citationKey(item), ...(item.citation_aliases ?? [])].join(
            ' ',
          ),
        ),
      })) ?? [],
    [data],
  );
  const included = useMemo(() => references.filter(({ key }) => !excluded.has(key)), [references, excluded]);
  const filteredReferences = useMemo(() => {
    const terms = normalizedSearch(deferredReferenceQuery).split(/\s+/u).filter(Boolean);
    return references.filter(({ search }) => terms.every((term) => search.includes(term)));
  }, [references, deferredReferenceQuery]);
  const selectedReference = included.find(({ key }) => key === editingReference) ?? included[0];
  const selectedDetails = selectedReference ? details[selectedReference.key] : undefined;
  const styleTerm = normalizedSearch(styleQuery);
  const hasStyleMatch = (entry: { id: string; label: string }) =>
    normalizedSearch(`${entry.label} ${entry.id}`).includes(styleTerm);
  const builtinStyles = data?.engine.literatureCitationStyles.filter(
    (entry) => entry.id === style || hasStyleMatch(entry),
  );
  const customStyles = custom.filter((entry) => entry.id === style || hasStyleMatch(entry));

  const { formatted, formatError } = useMemo(() => {
    if (!included.length || !data) return {};
    const selected =
      custom.find((entry) => entry.id === style) ??
      (data.engine.literatureCitationStyles.some((entry) => entry.id === style)
        ? (style as LiteratureCitationStyle)
        : 'apa');
    try {
      return {
        formatted: data.engine.formatLiteratureCitations(
          included.map(({ item }) => item),
          selected,
          'en-US',
          included.map(({ key }) => details[key]),
        ),
      };
    } catch (error) {
      return { formatError: error instanceof Error ? error.message : 'Could not format these references.' };
    }
  }, [custom, data, details, included, style]);
  async function copy(value: string, label: string) {
    try {
      await navigator.clipboard.writeText(value);
      setStatus(`${label} copied.`);
    } catch {
      setStatus('Clipboard unavailable. Select the text to copy it manually.');
    }
  }

  return (
    <Modal title="Formatted citations" onClose={onClose} wide>
      {failure && <Notice tone="error">{failure}</Notice>}
      {formatError && <Notice tone="error">{formatError}</Notice>}
      {!data && !failure && <p role="status">Loading references…</p>}
      {data && data.items.length === 0 && <p>No references to format.</p>}
      {data && (
        <>
          {(custom.length > 0 || data.engine.literatureCitationStyles.length > 5) && (
            <Field label="Search citation styles">
              <input
                type="search"
                value={styleQuery}
                onChange={(event) => setStyleQuery(event.target.value)}
              />
            </Field>
          )}
          <Field label="Citation style">
            <select value={style} onChange={(event) => selectStyle(event.target.value)}>
              {builtinStyles?.map(({ id, label }) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
              {customStyles.length > 0 && (
                <optgroup label="Imported styles">
                  {customStyles.map(({ id, label }) => (
                    <option key={id} value={id}>
                      {label}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
          </Field>
          {styleTerm && ![...data.engine.literatureCitationStyles, ...custom].some(hasStyleMatch) && (
            <p className="small-text muted">No citation styles match your search.</p>
          )}
          <details>
            <summary>Manage citation styles</summary>
            <Field label="Import CSL style" hint="Choose an independent .csl file to use on this device.">
              <input
                type="file"
                accept=".csl,application/xml,text/xml"
                disabled={installing}
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  event.currentTarget.value = '';
                  if (file) void installStyle(file);
                }}
              />
            </Field>
            {installing && <p role="status">Reading citation style…</p>}
            {custom.some((entry) => entry.id === style) && (
              <button
                type="button"
                className="button small"
                disabled={installing}
                onClick={() => {
                  selectStyle('apa');
                  persistStyles(custom.filter((entry) => entry.id !== style));
                  setStyleQuery('');
                }}
              >
                Remove selected style
              </button>
            )}
          </details>
          {styleError && <Notice tone="error">{styleError}</Notice>}
        </>
      )}
      {!!references.length && (
        <details>
          <summary>Included references ({included.length})</summary>
          <div className={styles.section}>
            <Field label="Find references" hint="Search by title, author, year, or citation key.">
              <input
                type="search"
                value={referenceQuery}
                onChange={(event) => setReferenceQuery(event.target.value)}
              />
            </Field>
            {references.length > 1 && (
              <div className={styles.actions}>
                <button
                  type="button"
                  className="button small"
                  disabled={!included.length}
                  onClick={() => {
                    setExcluded(new Set(references.map(({ key }) => key)));
                    setStatus('');
                  }}
                >
                  Clear selection
                </button>
                <button
                  type="button"
                  className="button small"
                  disabled={!filteredReferences.some(({ key }) => excluded.has(key))}
                  onClick={() => {
                    setExcluded((previous) => {
                      const next = new Set(previous);
                      for (const { key } of filteredReferences) next.delete(key);
                      return next;
                    });
                    setStatus('');
                  }}
                >
                  {normalizedSearch(deferredReferenceQuery)
                    ? 'Include matching references'
                    : 'Include all references'}
                </button>
              </div>
            )}
            {filteredReferences.length > 0 ? (
              <ul className={styles.references}>
                {filteredReferences.map(({ item, key }) => (
                  <li key={key}>
                    <label className={styles.reference}>
                      <input
                        type="checkbox"
                        checked={!excluded.has(key)}
                        onChange={(event) => {
                          const checked = event.target.checked;
                          setExcluded((previous) => {
                            const next = new Set(previous);
                            if (checked) next.delete(key);
                            else next.add(key);
                            return next;
                          });
                          setStatus('');
                        }}
                      />
                      <span>{item.title}</span>
                    </label>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="small-text muted">No references match your search.</p>
            )}
            {included.length === 0 && (
              <p className="small-text muted">Include at least one reference to format a citation.</p>
            )}
          </div>
        </details>
      )}
      {data && selectedReference && (
        <details>
          <summary>Citation details</summary>
          <div className={styles.section}>
            {included.length > 1 && (
              <Field label="Citation reference">
                <select
                  value={selectedReference.key}
                  onChange={(event) => setEditingReference(event.target.value)}
                >
                  {included.map(({ item, key }) => (
                    <option key={key} value={key}>
                      {item.title} ({citationKey(item)})
                    </option>
                  ))}
                </select>
              </Field>
            )}
            <div className="form-grid">
              <Field label="Locator type">
                <select
                  value={selectedDetails?.label ?? 'page'}
                  onChange={(event) =>
                    editDetail(selectedReference.key, {
                      label: event.target.value as LiteratureCitationDetail['label'],
                    })
                  }
                >
                  {data.engine.literatureCitationLocators.map(([id, label]) => (
                    <option key={id} value={id}>
                      {label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field
                label={
                  !selectedDetails?.label || selectedDetails.label === 'page' ? 'Page or range' : 'Locator'
                }
              >
                <input
                  value={selectedDetails?.locator ?? ''}
                  maxLength={80}
                  placeholder={selectedDetails?.label === 'section' ? '2.3' : '24–26'}
                  onChange={(event) => editDetail(selectedReference.key, { locator: event.target.value })}
                />
              </Field>
              <Field label="Prefix">
                <input
                  value={selectedDetails?.prefix ?? ''}
                  maxLength={100}
                  onChange={(event) => editDetail(selectedReference.key, { prefix: event.target.value })}
                />
              </Field>
              <Field label="Suffix">
                <input
                  value={selectedDetails?.suffix ?? ''}
                  maxLength={100}
                  onChange={(event) => editDetail(selectedReference.key, { suffix: event.target.value })}
                />
              </Field>
            </div>
            <label className={styles.reference}>
              <input
                type="checkbox"
                checked={selectedDetails?.suppressAuthor ?? false}
                onChange={(event) =>
                  editDetail(selectedReference.key, { suppressAuthor: event.target.checked })
                }
              />
              <span>Omit author in citation</span>
            </label>
          </div>
        </details>
      )}
      {formatted && (
        <>
          <Field label="In-text citation">
            <textarea readOnly rows={3} value={formatted.citation} />
          </Field>
          <button
            className="button small"
            type="button"
            onClick={() => void copy(formatted!.citation, 'Citation')}
          >
            Copy citation
          </button>
          <Field label="Bibliography">
            <textarea readOnly rows={9} value={formatted.bibliography} />
          </Field>
          <button
            className="button small"
            type="button"
            onClick={() => void copy(formatted!.bibliography, 'Bibliography')}
          >
            Copy bibliography
          </button>
        </>
      )}
      {status && <p role="status">{status}</p>}
      <p className="small-text muted">
        Styles from{' '}
        <a className="text-link" href="https://citationstyles.org/" target="_blank" rel="noreferrer">
          Citation Style Language
        </a>
        .
      </p>
    </Modal>
  );
}
