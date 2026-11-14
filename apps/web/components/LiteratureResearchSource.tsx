'use client';

import Link from 'next/link';
import { useState } from 'react';
import { api, useResource } from '../lib/api';
import { researchQuestionDraftHref, researchQuestionHref, type ResearchQuestionSource } from '../lib/research-question-links';
import type { Project, ResearchObject } from '../lib/types';
import { ErrorState, Field, Loading, Modal } from './ui';

async function readChoices<T>(path: string, signal: AbortSignal): Promise<T[]> {
  const [resource, search] = path.split('?');
  const params = new URLSearchParams(search);
  const choices: T[] = [];
  let cursor: string | null = null;
  do {
    if (cursor) params.set('cursor', cursor);
    const batch = await api<{ items: T[]; next_cursor: string | null }>(`${resource}?${params}`, { signal });
    choices.push(...batch.items);
    cursor = batch.next_cursor;
  } while (cursor);
  return choices;
}

export function LiteratureResearchSource({ source, title, onClose }: {
  source: ResearchQuestionSource;
  title: string;
  onClose: () => void;
}) {
  const projects = useResource<Project[]>('/research/projects?limit=100', readChoices<Project>);
  const [projectId, setProjectId] = useState('');
  const available = projects.data?.filter((project) => project.status !== 'archived') ?? [];
  const project = available.find((item) => item.id === projectId) ?? available[0];
  return (
    <Modal title="Use page in research" onClose={onClose}>
      <p>{title} · PDF page {source.page}</p>
      <ErrorState error={projects.error} retry={projects.reload} />
      {projects.loading && <Loading />}
      {project && (
        <>
          <Field label="Research project">
            <select value={project.id} onChange={(event) => setProjectId(event.target.value)}>
              {available.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
            </select>
          </Field>
          <QuestionChoices key={project.id} projectId={project.id} source={source} onClose={onClose} />
        </>
      )}
      {projects.data && !project && (
        <p>Create a project in <Link className="text-link" href="/research" onClick={onClose}>Research</Link> to use this page.</p>
      )}
    </Modal>
  );
}

function QuestionChoices({ projectId, source, onClose }: {
  projectId: string;
  source: ResearchQuestionSource;
  onClose: () => void;
}) {
  const questions = useResource<ResearchObject[]>(
    `/research/projects/${projectId}/objects?object_type=question&limit=100`,
    readChoices<ResearchObject>,
  );
  const [selected, setSelected] = useState('');
  const available = questions.data?.filter((item) => item.object_type === 'question') ?? [];
  const question = available.find((item) => item.id === selected) ?? available[0];
  return (
    <>
      <ErrorState error={questions.error} retry={questions.reload} />
      {questions.loading && <Loading />}
      {question && (
        <Field label="Research question">
          <select value={question.id} onChange={(event) => setSelected(event.target.value)}>
            {available.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
          </select>
        </Field>
      )}
      {questions.data && !question && <p className="muted">There are no questions in this project yet.</p>}
      <div className="modal-footer">
        <Link className="button" href={researchQuestionDraftHref(projectId, source)} onClick={onClose}>
          New question from this page
        </Link>
        {question && (
          <Link className="button primary" href={researchQuestionHref(projectId, question.id, source)} onClick={onClose}>
            Link this page
          </Link>
        )}
      </div>
    </>
  );
}
