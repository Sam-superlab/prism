import type { Entity } from './types';

export type ResearchQuestionStatus = 'open' | 'investigating' | 'resolved';

export const researchQuestionStatusLabels: Record<ResearchQuestionStatus, string> = {
  open: 'Open',
  investigating: 'Investigating',
  resolved: 'Resolved',
};

export const sourceRelations = {
  motivates: 'Motivates',
  supports: 'Supports',
  contradicts: 'Contradicts',
  background: 'Background',
} as const;

export const investigationRelations = {
  attempt: 'Proof attempt',
  experiment: 'Computational experiment',
  conjecture: 'Conjecture',
} as const;

export const resultRelations = {
  result: 'Result',
  counterexample: 'Counterexample',
} as const;

export type QuestionRelation = keyof typeof sourceRelations | keyof typeof investigationRelations | keyof typeof resultRelations;

export interface ResearchQuestionLink extends Entity {
  question_id: string;
  relation_type: QuestionRelation;
  reference_id: string | null;
  attachment_id: string | null;
  page: number | null;
  research_object_id: string | null;
  notes: string;
  question_title: string;
  project_id: string;
  target_title: string;
  target_type: string;
  target_claim_status: string | null;
}

export interface ResearchQuestionSource {
  referenceId: string;
  pdfId: string;
  page: number;
}

export function readResearchQuestionSource(params: URLSearchParams): ResearchQuestionSource | undefined {
  const referenceId = params.get('sourceReference');
  const pdfId = params.get('sourcePdf');
  const page = params.get('sourcePage');
  const uuid = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;
  if (referenceId && pdfId && page && uuid.test(referenceId) && uuid.test(pdfId) && /^[1-9]\d{0,5}$/.test(page))
    return { referenceId, pdfId, page: Number(page) };
}

function sourceParams(source: ResearchQuestionSource) {
  return new URLSearchParams({
    sourceReference: source.referenceId,
    sourcePdf: source.pdfId,
    sourcePage: String(source.page),
  });
}

export function researchQuestionHref(projectId: string, questionId: string, source?: ResearchQuestionSource) {
  const path = `/research/${projectId}/questions/${questionId}`;
  return source ? `${path}?${sourceParams(source)}` : path;
}

export function researchQuestionDraftHref(projectId: string, source: ResearchQuestionSource) {
  const params = sourceParams(source);
  params.set('newQuestion', '1');
  return `/research/${projectId}?${params}`;
}
