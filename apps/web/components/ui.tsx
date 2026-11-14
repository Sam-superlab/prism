'use client';
import {
  Children,
  cloneElement,
  isValidElement,
  memo,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import katex from 'katex';
import Markdown from 'react-markdown';
import remarkMath from 'remark-math';
import { ApiError } from '../lib/api';
import { authReturnPath } from '../lib/auth-return-path';
import { isKnowledgeImageSource, pdfAreaImageSource } from '../lib/knowledge-image-sources';
import markdownStyles from './KnowledgeMarkdown.module.css';

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
  library: <path d="M4 5v14m4-14v14m4-14v14m3-13 5 12" />,
  detailsPane: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M15 5v14m2-10h2m-2 3h2" /></>,
  folder: <path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />,
  file: <path d="M6 3h8l4 4v14H6ZM14 3v5h4M9 12h6m-6 4h6" />,
  fileSearch: <><path d="M13 21H5V3h9l4 4v4m-4-8v5h4" /><circle cx="15" cy="15.5" r="3.5" /><path d="m18 18 3 3" /></>,
  import: <path d="M12 3v12m-4-4 4 4 4-4M4 15v5h16v-5" />,
  export: <path d="M12 15V3m-4 4 4-4 4 4M4 15v5h16v-5" />,
  annotation: <path d="M4 4h16v12H9l-5 4ZM8 8h8m-8 4h6" />,
  feed: <><path d="M4 4c9 0 16 7 16 16M4 11c5 0 9 4 9 9" /><circle cx="5" cy="19" r="1" /></>,
  users: <><circle cx="9" cy="7" r="3" /><path d="M3 20v-2a6 6 0 0 1 12 0v2M16 4a3 3 0 0 1 0 6m2 4a4 4 0 0 1 3 4v2" /></>,
  quote: <path d="M4 12h5v6H4v-6c0-3 2-5 5-6m6 6h5v6h-5v-6c0-3 2-5 5-6" />,
  duplicates: <><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V4H4v12h4" /></>,
  select: <><rect x="4" y="4" width="16" height="16" rx="3" /><path d="m8 12 3 3 5-6" /></>,
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
  graph: (
    <>
      <path d="m8 6 7 3m-8 0-2 7m12-4 2 5m-9 2h6" />
      <circle cx="7" cy="6" r="2.5" />
      <circle cx="17" cy="10" r="2.5" />
      <circle cx="6" cy="19" r="2.5" />
      <circle cx="19" cy="19" r="2.5" />
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
  const needsLogin = error instanceof ApiError && error.status === 401;
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
        {needsLogin && (
          <a
            className="button small primary"
            href="/auth/login"
            onClick={(event) => {
              const destination = authReturnPath(window.location.pathname + window.location.search);
              if (destination !== '/today')
                event.currentTarget.href = `/auth/login?returnTo=${encodeURIComponent(destination)}`;
            }}
          >
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
  inline = false,
  suspended = false,
  dismissOnBackdrop = true,
  className,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
  lang?: string;
  closeLabel?: string;
  inline?: boolean;
  suspended?: boolean;
  dismissOnBackdrop?: boolean;
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (inline || suspended) return;
    const el = ref.current;
    const previous = document.activeElement as HTMLElement | null;
    el?.showModal();
    el?.querySelector<HTMLElement>(
      'input:not([disabled]), textarea:not([disabled]), select:not([disabled])',
    )?.focus({ preventScroll: true });
    const handler = (e: Event) => {
      // A dismissed file picker dispatches its own bubbling cancel event.
      if (e.target !== el) return;
      e.preventDefault();
      close.current();
    };
    el?.addEventListener('cancel', handler);
    return () => {
      el?.removeEventListener('cancel', handler);
      el?.close();
      previous?.focus({ preventScroll: true });
    };
  }, [inline, suspended]);
  return (
    <dialog
      ref={ref}
      lang={lang}
      aria-labelledby={titleId}
      open={inline || undefined}
      className={['modal', wide && 'wide', inline && 'inline-reader', className].filter(Boolean).join(' ')}
      onClick={(e) => {
        if (!inline && dismissOnBackdrop && e.target === ref.current) onClose();
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
        const delimiterLength = display ? 2 : 1;
        return <Formula key={i} latex={part.slice(delimiterLength, -delimiterLength)} display={display} />;
      })}
    </div>
  );
}
function Formula({ latex, display }: { latex: string; display: boolean }) {
  try {
    const html = katex.renderToString(latex, {
      displayMode: display,
      throwOnError: false,
      trust: false,
      strict: 'warn',
    });
    return (
      <span className={display ? 'math-block' : 'math-inline'} dangerouslySetInnerHTML={{ __html: html }} />
    );
  } catch {
    const delimiter = display ? '$$' : '$';
    return <code>{delimiter + latex + delimiter}</code>;
  }
}

function KnowledgePdfFigure({ src, alt }: { src: string; alt: string }) {
  const image = useRef<HTMLImageElement>(null);
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    const element = image.current;
    if (!element) return;
    let cancelled = false;
    let stop: (() => void) | undefined;
    void import('../lib/literature-pdf-area-image').then(({ displayLiteraturePdfAreaImage }) => {
      if (!cancelled) stop = displayLiteraturePdfAreaImage(element, src, () => setUnavailable(true));
    }).catch(() => {
      if (!cancelled) {
        element.dataset.prismPdfFigure = 'unavailable';
        setUnavailable(true);
      }
    });
    return () => { cancelled = true; stop?.(); };
  }, [src]);
  return <>
    <img ref={image} alt={alt} data-prism-pdf-figure="loading" hidden={unavailable} />
    {unavailable && <a href={src}>{alt} · Open PDF source</a>}
  </>;
}

type MarkdownNode = { type: string; value?: string; children?: MarkdownNode[] };
function remarkCitations(citations: Record<string, string>) {
  return (tree: MarkdownNode) => {
    function visit(node: MarkdownNode) {
      if (node.type === 'text' && node.value) {
        node.value = node.value.replace(/\[@([a-z0-9_./:+-]{1,180})\]/gi, (token, key: string) =>
          Object.hasOwn(citations, key) ? `(${citations[key]})` : token,
        );
      }
      node.children?.forEach(visit);
    }
    visit(tree);
  };
}

export const KnowledgeMarkdown = memo(function KnowledgeMarkdown({
  content,
  className = '',
  citations,
  interactive = true,
}: {
  content: string;
  className?: string;
  citations?: Record<string, string>;
  interactive?: boolean;
}) {
  return (
    <div className={['math-content', markdownStyles.prose, className].filter(Boolean).join(' ')}>
      <Markdown
        remarkPlugins={citations ? [remarkMath, [remarkCitations, citations]] : [remarkMath]}
        components={{
          ...(!interactive ? { a: ({ children }: { children?: ReactNode }) => <span>{children}</span> } : {}),
          code({ className, children, node }) {
            const classes = className?.split(' ') || [];
            if (!classes.includes('math-inline') && !classes.includes('math-display')) {
              return <code className={className}>{children}</code>;
            }
            const start = node?.position?.start.offset;
            const display =
              classes.includes('math-display') || (start !== undefined && content.startsWith('$$', start));
            return <Formula latex={String(children).replace(/\n$/, '')} display={display} />;
          },
          pre({ children, node }) {
            const code = node?.children[0];
            const classes = code?.type === 'element' ? code.properties.className : undefined;
            if (Array.isArray(classes) && classes.includes('math-display')) return children;
            return <pre>{children}</pre>;
          },
          img({ src, alt }) {
            if (typeof src === 'string' && isKnowledgeImageSource(src)) {
              if (pdfAreaImageSource(src)) return <KnowledgePdfFigure key={src} src={src} alt={alt || 'PDF figure'} />;
              return <img src={src} alt={alt || ''} />;
            }
            return alt || null;
          },
        }}
      >
        {content}
      </Markdown>
    </div>
  );
});
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
