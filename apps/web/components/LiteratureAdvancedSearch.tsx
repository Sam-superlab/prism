'use client';

import { useState } from 'react';
import {
  completeLiteratureCondition, defaultLiteratureCondition, literatureSearchFields, literatureSearchOperators, operatorsForField,
  type LiteratureCondition, type LiteratureSearchField, type LiteratureSearchOperator,
} from '../lib/literature-advanced-search';
import { Modal } from './ui';
import styles from './ResearchReferences.module.css';

type Collection = { id: string; name: string };
type ConditionProps = { condition: LiteratureCondition; update: (condition: LiteratureCondition) => void; depth: number;
  collections: readonly Collection[]; remove?: () => void };
const groupModes = { all: 'All conditions', any: 'Any condition', not: 'Exclude matching', rule: 'One condition' } as const;
const fieldValues: Partial<Record<LiteratureSearchField, readonly [string, string][]>> = {
  attachment_format: [['pdf', 'PDF'], ['epub', 'EPUB'], ['webpage', 'Page snapshot']],
  source: [['reference', 'Library reference'], ['arxiv', 'arXiv paper']],
  annotation_color: ['Yellow', 'Green', 'Blue', 'Pink', 'Purple'].map((label) => [label.toLowerCase(), label]),
};

export function LiteratureAdvancedSearch({ initial, collections, onApply, onClose }: {
  initial: LiteratureCondition | null; collections: readonly Collection[];
  onApply: (condition: LiteratureCondition) => void; onClose: () => void;
}) {
  const [condition, setCondition] = useState<LiteratureCondition>(() => initial ?? { all: [defaultLiteratureCondition()] });
  const complete = completeLiteratureCondition(condition);
  return <Modal title="Advanced search" onClose={onClose} wide>
    <form onSubmit={(event) => {
      event.preventDefault();
      if (complete) onApply(condition);
    }}>
      <ConditionEditor condition={condition} update={setCondition} collections={collections} depth={1} />
      <div className="modal-footer">
        <button type="button" className="button" onClick={onClose}>Cancel</button>
        <button type="submit" className="button primary" disabled={!complete}>Apply conditions</button>
      </div>
    </form>
  </Modal>;
}

function ConditionEditor({ condition, update, depth, collections, remove }: ConditionProps) {
  const mode = 'all' in condition ? 'all' : 'any' in condition ? 'any' : 'not' in condition ? 'not' : 'rule';
  const children = 'all' in condition ? condition.all : 'any' in condition ? condition.any : 'not' in condition ? [condition.not] : [];
  const changeChildren = (next: LiteratureCondition[]) => {
    if (mode === 'all') update({ all: next });
    if (mode === 'any') update({ any: next });
    if (mode === 'not' && next[0]) update({ not: next[0] });
  };
  return <div className={styles.searchCondition} data-group={mode !== 'rule' || undefined}>
    <div className={styles.inlineActions}>
      {depth < 5 && <select aria-label="Condition mode" value={mode} onChange={(event) => {
        const next = event.target.value;
        const members = children.length ? children : [condition];
        if (next === 'all') update({ all: members });
        else if (next === 'any') update({ any: members });
        else if (next === 'not') update({ not: members[0] });
        else update('field' in members[0] ? members[0] : defaultLiteratureCondition());
      }}>
        {Object.entries(groupModes).map(([value, name]) => <option key={value} value={value}>{name}</option>)}
      </select>}
      {'field' in condition && <>
        <select aria-label="Field" value={condition.field} onChange={(event) => update(defaultLiteratureCondition(event.target.value as LiteratureSearchField))}>
          {Object.entries(literatureSearchFields).map(([field, name]) => <option key={field} value={field}>{name}</option>)}
        </select>
        <select aria-label="Operator" value={condition.operator} onChange={(event) => update({ ...condition, operator: event.target.value as LiteratureSearchOperator })}>
          {operatorsForField(condition.field).map((operator) => <option key={operator} value={operator}>{literatureSearchOperators[operator]}</option>)}
        </select>
        <ConditionValue condition={condition} update={update} collections={collections} />
      </>}
      {remove && <button type="button" className="button small" onClick={remove}>Remove condition</button>}
    </div>
    {children.map((child, i) => <ConditionEditor key={i} condition={child} depth={depth + 1} collections={collections}
      update={(next) => changeChildren(children.map((item, index) => index === i ? next : item))}
      remove={children.length > 1 ? () => changeChildren(children.filter((_, index) => i !== index)) : undefined} />)}
    {(mode === 'all' || mode === 'any') && children.length < 12 && <div className={styles.inlineActions}>
      <button type="button" className="button small" onClick={() => changeChildren([...children, defaultLiteratureCondition()])}>Add condition</button>
      {depth < 4 && <button type="button" className="button small"
        onClick={() => changeChildren([...children, { any: [defaultLiteratureCondition()] }])}>Add group</button>}
    </div>}
  </div>;
}

function ConditionValue({ condition, update, collections }: {
  condition: Extract<LiteratureCondition, { field: string }>; update: ConditionProps['update']; collections: readonly Collection[];
}) {
  const { field, value } = condition;
  const values = field === 'collection' ? collections.map((collection) => [collection.id, collection.name]) : fieldValues[field];
  if (field === 'has_attachment') return <select aria-label="Value" value={String(value)}
    onChange={(event) => update({ ...condition, value: event.target.value === 'true' })}>
    <option value="true">Yes</option><option value="false">No</option>
  </select>;
  if (values) return <select aria-label="Value" value={String(value)} onChange={(event) => update({ ...condition, value: event.target.value })}>
    <option value="" disabled>Choose a value</option>
    {values.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
  </select>;
  const inputType = field === 'year' ? 'number' : field === 'date_added' || field === 'date_modified' ? 'date' : 'text';
  return <input aria-label="Value" type={inputType} min={field === 'year' ? 1 : undefined}
    max={field === 'year' ? 9999 : undefined} maxLength={inputType === 'text' ? 300 : undefined} value={String(value)}
    onChange={(event) => update({ ...condition, value: field === 'year' && event.target.value ? Number(event.target.value) : event.target.value })} />;
}
