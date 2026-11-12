'use client';
import {
  Children,
  cloneElement,
  isValidElement,
  useEffect,
  useId,
  useRef,
  type ReactElement,
  type ReactNode,
} from 'react';
import katex from 'katex';
import { ApiError } from '../lib/api';

const icons: Record<string, ReactNode> = {
  today: (
    <>
      <rect x="3" y="4" width="18" height="17" rx="3" />
      <path d="M7 2v4m10-4v4M3 10h18m-14 5h3m4 0h3" />
    </>
  ),
  knowledge: (
    <>
      <path d="M4 4h6a3 3 0 0 1 3 3v14a5 5 0 0 0-5-2H4zM20 4h-4a3 3 0 0 0-3 3v14a5 5 0 0 1 5-2h2z" />
    </>
  ),
  research: (
    <>
      <path d="m9 3 2 5-7 10a2 2 0 0 0 2 3h12a2 2 0 0 0 2-3L13 8l2-5M8 3h8M8 15h8" />
    </>
  ),
  fitness: (
    <>
      <path d="m3 9 3-3m-3 9L9 3m6 18 6-6M9 21l12-12M7 7l10 10M2 12l10-10m0 20 10-10" />
    </>
  ),
  discover: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="m16 8-3 5-5 3 3-5z" />
    </>
  ),
  planner: (
    <>
      <rect x="3" y="4" width="18" height="17" rx="3" />
      <path d="m7 10 2 2 4-4m-6 8h10" />
    </>
  ),
  settings: (
    <>
      <path d="m9 3-1 3-3 1-2 5 2 5 3 1 1 3h6l1-3 3-1 2-5-2-5-3-1-1-3z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  arrow: <path d="M4 12h16m-6-6 6 6-6 6" />,
  check: <path d="m5 12 4 4L19 6" />,
  close: <path d="m6 6 12 12M6 18 18 6" />,
  search: (
    <>
      <circle cx="10" cy="10" r="6" />
      <path d="m15 15 5 5" />
    </>
  ),
  pin: <path d="m9 3 6 0-1 6 4 4H6l4-4-1-6M12 13v8" />,
  chevron: <path d="m9 5 7 7-7 7" />,
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  menu: <path d="M4 6h16M4 12h16M4 18h16" />,
  refresh: (
    <>
      <path d="M20 7v5h-5M4 17v-5h5" />
      <path d="M6 7a7 7 0 0 1 12-1l2 3M4 15l2 3a7 7 0 0 0 12-1" />
    </>
  ),
  edit: (
    <>
      <path d="m15 4 5 5L8 21H3v-5zM12 7l5 5" />
    </>
  ),
  trash: (
    <>
      <path d="M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7" />
    </>
  ),
  external: (
    <>
      <path d="M14 3h7v7m0-7L10 14M10 3H3v18h18v-7" />
    </>
  ),
  bookmark: <path d="M6 3h12v18l-6-4-6 4z" />,
};
export function Icon({
  name,
  size = 20,
  className = '',
}: {
  name: string;
  size?: number;
  className?: string;
}) {
  return (
    <svg
      className={`prism-icon ${className}`.trim()}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      {icons[name] || icons.knowledge}
    </svg>
  );
}
export function Badge({ children, tone = '' }: { children: ReactNode; tone?: string }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}
export function Empty({
  icon = 'knowledge',
  title,
  children,
  action,
}: {
  icon?: string;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <span className="empty-icon">
        <Icon name={icon} size={27} />
      </span>
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}
export function Loading() {
  return (
    <div className="loading-state" role="status">
      <span className="spinner" />
      Loading your workspace…
    </div>
  );
}
export function ErrorState({ error, retry }: { error: Error | null; retry?: () => void }) {
  if (!error) return null;
  return (
    <div className="error-box" role="alert">
      <p>{error.message}</p>
      <div className="inline-actions">
        {retry && (
          <button className="button small" onClick={retry}>
            Try again
          </button>
        )}
        {error instanceof ApiError && error.status === 401 && (
          <a className="button small primary" href="/auth/login">
            Sign in to PRISM
          </a>
        )}
      </div>
    </div>
  );
}
export function Notice({ children, tone = '' }: { children: ReactNode; tone?: string }) {
  return <div className={`notice ${tone}`}>{children}</div>;
}
export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  const id = useId();
  return (
    <label className="field">
      <span id={id}>{label}</span>
      {Children.map(children, (child) => {
        if (
          !isValidElement(child) ||
          typeof child.type !== 'string' ||
          !['input', 'textarea', 'select'].includes(child.type)
        )
          return child;
        return cloneElement(
          child as ReactElement<{ 'aria-labelledby'?: string; 'aria-describedby'?: string }>,
          { 'aria-labelledby': id, ...(hint ? { 'aria-describedby': `${id}-hint` } : {}) },
        );
      })}
      {hint && <small id={`${id}-hint`}>{hint}</small>}
    </label>
  );
}
export function Modal({
  title,
  children,
  onClose,
  wide = false,
  lang,
  closeLabel = 'Close',
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
  lang?: string;
  closeLabel?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const el = ref.current;
    const previous = document.activeElement as HTMLElement | null;
    el?.showModal();
    el?.querySelector<HTMLElement>(
      'input:not([disabled]), textarea:not([disabled]), select:not([disabled])',
    )?.focus({ preventScroll: true });
    const handler = (e: Event) => {
      // Dismissing a file picker can dispatch a bubbling cancel event.
      if (e.target !== el) return;
      e.preventDefault();
      close.current();
    };
    el?.addEventListener('cancel', handler);
    return () => {
      el?.removeEventListener('cancel', handler);
      previous?.focus({ preventScroll: true });
    };
  }, []);
  return (
    <dialog
      ref={ref}
      lang={lang}
      aria-labelledby={titleId}
      className={`modal ${wide ? 'wide' : ''}`}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      <header>
        <h2 id={titleId}>{title}</h2>
        <button className="icon-button" aria-label={closeLabel} onClick={onClose}>
          <Icon name="close" />
        </button>
      </header>
      {children}
    </dialog>
  );
}
export function MathContent({ content, className = '' }: { content: string; className?: string }) {
  const pieces = content.split(/(\$\$[\s\S]*?\$\$|\$[^\n$]+\$)/g);
  return (
    <div className={`math-content ${className}`}>
      {pieces.map((part, i) => {
        const display = part.startsWith('$$') && part.endsWith('$$');
        const inline = !display && part.startsWith('$') && part.endsWith('$');
        if (!display && !inline) return <span key={i}>{part}</span>;
        try {
          const html = katex.renderToString(part.slice(display ? 2 : 1, display ? -2 : -1), {
            displayMode: display,
            throwOnError: false,
            trust: false,
            strict: 'warn',
          });
          return (
            <span
              key={i}
              className={display ? 'math-block' : 'math-inline'}
              dangerouslySetInnerHTML={{ __html: html }}
            />
          );
        } catch {
          return <code key={i}>{part}</code>;
        }
      })}
    </div>
  );
}
export const knowledgeTypes = [
  'definition',
  'theorem',
  'lemma',
  'proposition',
  'corollary',
  'proof',
  'example',
  'counterexample',
  'exercise',
  'note',
];
export const labels: Record<string, string> = {
  definition: 'Definition',
  theorem: 'Theorem',
  lemma: 'Lemma',
  proposition: 'Proposition',
  corollary: 'Corollary',
  proof: 'Proof',
  example: 'Example',
  counterexample: 'Counterexample',
  exercise: 'Exercise',
  note: 'Note',
  question: 'Research question',
  conjecture: 'Conjecture',
  proof_attempt: 'Proof attempt',
  experiment: 'Experiment',
  observation: 'Observation',
  literature_note: 'Literature note',
  needs_verification: 'Needs verification',
  computationally_verified: 'Computationally verified',
  proved: 'Proved',
  disproved: 'Disproved',
  unverified: 'Unverified',
  user_verified: 'User verified',
  source_verified: 'Source verified',
  active: 'In progress',
  paused: 'Paused',
  completed: 'Completed',
  archived: 'Archived',
  ready: 'Ready',
  in_progress: 'In progress',
  backlog: 'Backlog',
  blocked: 'Blocked',
  general: 'Personal task',
  research: 'Research',
  reading: 'Reading',
  workout: 'Workout',
  strength: 'Strength',
  cardio: 'Cardio',
  recovery: 'Recovery / Rest',
  unread: 'Unread',
  read: 'Read',
  not_relevant: 'Not relevant',
  statement: 'Statement',
  hypotheses: 'Hypotheses',
  application: 'Application',
  custom: 'Custom',
  related: 'Related',
  depends_on: 'Depends on',
  example_of: 'Example of',
  proof_of: 'Proof of',
};
export const label = (value: string) => labels[value] || value;
