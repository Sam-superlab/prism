'use client';

import { useState } from 'react';
import { api, useAction, uuid } from '../../lib/api';
import type { BibliographyItem } from '../../lib/bibliography';
import { researchQuestionStatusLabels, type ResearchQuestionStatus } from '../../lib/research-question-links';
import type { ResearchObject } from '../../lib/types';
import { MarkdownEditor } from '../MarkdownEditor';
import { CitationField } from '../ResearchReferences';
import { Field, Modal, Notice, label } from '../ui';
import styles from './ResearchQuestion.module.css';

export function ResearchObjectEditor({
  projectId,
  object,
  types = ['question', 'conjecture', 'theorem', 'lemma', 'proof_attempt', 'counterexample', 'experiment', 'observation', 'literature_note'],
  title: modalTitle,
  onCommit,
  references,
  onClose,
  onSaved,
}: {
  projectId: string;
  object?: ResearchObject;
  types?: readonly string[];
  title?: string;
  onCommit?: (object: ResearchObject, linkId: string) => Promise<void>;
  references: BibliographyItem[];
  onClose: () => void;
  onSaved: (object: ResearchObject) => void;
}) {
  const [creationId] = useState(uuid);
  const [linkId] = useState(uuid);
  const [title, setTitle] = useState(object?.title || '');
  const [type, setType] = useState(object?.object_type || types[0]);
  const [questionStatus, setQuestionStatus] = useState<ResearchQuestionStatus>(object?.question_status ?? 'open');
  const [content, setContent] = useState(object?.content || '');
  const [claim, setClaim] = useState(object?.claim_status || 'needs_verification');
  const [proof, setProof] = useState(object?.proof_content || '');
  const [reference, setReference] = useState(object?.evidence_reference || '');
  const [scope, setScope] = useState(String(object?.evidence_metadata.scope || ''));
  const [result, setResult] = useState(String(object?.evidence_metadata.result || ''));
  const [created, setCreated] = useState<ResearchObject>();
  const action = useAction();
  return (
    <Modal title={modalTitle ?? (object ? 'Edit research object' : 'Add research object')} onClose={onClose} wide>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (type !== 'question' && claim === 'proved' && !proof.trim() && !reference.trim()) {
            action.setError('A proved claim requires proof text or a reference.');
            return;
          }
          void action.run(async () => {
            // If linking fails after creation, keep the same record so the relationship can be retried.
            const saved = created ?? await api<ResearchObject>(object ? `/research/objects/${object.id}` : `/research/projects/${projectId}/objects`, {
              method: object ? 'PATCH' : 'POST',
              version: object?.version,
              body: {
                ...(object ? { base_snapshot: object } : { id: creationId }),
                title,
                object_type: type,
                content,
                ...(type === 'question' ? {
                  question_status: questionStatus,
                  ...(!object ? { claim_status: 'needs_verification' } : {}),
                } : {
                  claim_status: claim,
                  proof_content: proof || null,
                  evidence_reference: reference || null,
                  evidence_metadata: {
                    ...(object?.evidence_metadata || {}),
                    ...(scope ? { scope } : {}),
                    ...(result ? { result } : {}),
                  },
                }),
              },
            });
            if (onCommit) {
              if (!object) setCreated(saved);
              await onCommit(saved, linkId);
            }
            onSaved(saved);
          });
        }}
      >
        <fieldset disabled={Boolean(created)} className={styles.editorFields}>
        <div className="form-grid">
          <Field label="Title">
            <input autoFocus required maxLength={300} value={title} onChange={(e) => setTitle(e.target.value)} />
          </Field>
          {(types.length > 1 && object?.object_type !== 'question') && <Field label="Object type">
            <select value={type} onChange={(e) => setType(e.target.value)}>
              {types.map((x) => (
                <option key={x} value={x}>
                  {label(x)}
                </option>
              ))}
            </select>
          </Field>}
        </div>
        <CitationField label={type === 'question' ? 'Question statement' : 'Content'} rows={6} value={content} onChange={setContent} references={references} required />
        {type === 'question' ? (
          <Field label="Question status">
            <select value={questionStatus} onChange={(e) => setQuestionStatus(e.target.value as ResearchQuestionStatus)}>
              {Object.entries(researchQuestionStatusLabels).map(([status, title]) =>
                <option key={status} value={status}>{title}</option>)}
            </select>
          </Field>
        ) : <>
        <Field label="Mathematical claim status">
          <select value={claim} onChange={(e) => setClaim(e.target.value)}>
            {['needs_verification', 'conjecture', 'computationally_verified', 'proved', 'disproved'].map(
              (x) => (
                <option key={x} value={x}>
                  {label(x)}
                </option>
              ),
            )}
          </select>
        </Field>
        {claim === 'computationally_verified' && (
          <div className="form-grid">
            <MarkdownEditor label="Verification scope"
                required
                rows={3}
                value={scope}
                onChange={setScope}
                placeholder="Parameter range, samples, algorithm, and code version" />
            <MarkdownEditor label="Results / evidence"
                required
                rows={3}
                value={result}
                onChange={setResult}
                placeholder="Record the results and their limitations" />
          </div>
        )}
        <CitationField label="Proof text / proof attempt" rows={5} value={proof} onChange={setProof} references={references} />
        <Field label="Proof or evidence reference">
          <input
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            placeholder="Literature, code, logs, or proof location"
          />
        </Field>
        <Notice>
          Claim status changes enter the project timeline. Computational evidence does not establish a general
          proof.
        </Notice>
        </>}
        </fieldset>
        {created && action.error && <Notice>The record is saved. Retry to finish linking it.</Notice>}
        {action.error && <Notice tone="error">{action.error}</Notice>}
        <div className="modal-footer">
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button className="button primary" disabled={action.busy}>
            {created ? 'Retry link' : type === 'question' ? 'Save question' : 'Save research object'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
