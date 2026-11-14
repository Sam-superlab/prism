'use client';

import { useEffect, useRef } from 'react';
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import styles from './LiteraturePdfThumbnails.module.css';

const nearbyPageCount = 13;
const previewWidth = 90;
const previewHeight = 118;

type RenderJob = { target: HTMLElement; cancelled: boolean; task?: RenderTask };

export function LiteraturePdfThumbnails({
  document,
  page,
  onSelect,
}: {
  document: PDFDocumentProxy;
  page: number;
  onSelect: (page: number) => void;
}) {
  const list = useRef<HTMLOListElement>(null);
  const activeButton = useRef<HTMLButtonElement>(null);
  const renderedDocument = useRef<PDFDocumentProxy>(null);
  const first = Math.max(
    1,
    Math.min(page - Math.floor(nearbyPageCount / 2), document.numPages - nearbyPageCount + 1),
  );
  const last = Math.min(document.numPages, first + nearbyPageCount - 1);
  const pages = Array.from({ length: last - first + 1 }, (_, index) => first + index);

  useEffect(() => {
    const root = list.current;
    const current = activeButton.current;
    if (!root || !current) return;
    const bounds = root.getBoundingClientRect();
    const active = current.getBoundingClientRect();
    if (active.top < bounds.top || active.bottom > bounds.bottom)
      root.scrollTop += active.top + active.height / 2 - bounds.top - bounds.height / 2;
  }, [document, first, last, page]);

  useEffect(() => {
    const root = list.current;
    if (!root) return;
    const targets = [...root.querySelectorAll<HTMLElement>('[data-thumbnail-page]')];
    if (renderedDocument.current !== document) {
      renderedDocument.current = document;
      for (const target of targets) {
        target.replaceChildren();
        delete target.dataset.thumbnailState;
      }
    }
    if (typeof IntersectionObserver === 'undefined') {
      for (const target of targets) target.dataset.thumbnailState = 'unavailable';
      return;
    }

    let closed = false;
    let active: RenderJob | undefined;
    const visible = new Set<HTMLElement>();
    const pageOf = (target: HTMLElement) => Number(target.dataset.thumbnailPage);

    function cancel(job: RenderJob) {
      job.cancelled = true;
      job.task?.cancel();
    }

    async function render(job: RenderJob) {
      try {
        const source = await document.getPage(pageOf(job.target));
        if (job.cancelled) return;
        const base = source.getViewport({ scale: 1 });
        if (
          !Number.isFinite(base.width) ||
          !Number.isFinite(base.height) ||
          base.width <= 0 ||
          base.height <= 0
        )
          throw new Error('Invalid PDF page size.');
        const scale = Math.min(previewWidth / base.width, previewHeight / base.height);
        const viewport = source.getViewport({ scale });
        const canvas = job.target.ownerDocument.createElement('canvas');
        const density = Math.min(2, window.devicePixelRatio || 1);
        canvas.width = Math.max(1, Math.round(viewport.width * density));
        canvas.height = Math.max(1, Math.round(viewport.height * density));
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;
        job.task = source.render({
          canvas,
          viewport,
          transform: [canvas.width / viewport.width, 0, 0, canvas.height / viewport.height, 0, 0],
        });
        await job.task.promise;
        if (!job.cancelled) {
          job.target.replaceChildren(canvas);
          job.target.dataset.thumbnailState = 'ready';
        }
      } catch {
        if (!job.cancelled) job.target.dataset.thumbnailState = 'unavailable';
      } finally {
        if (active === job) active = undefined;
        next();
      }
    }

    function next() {
      if (closed || active) return;
      const target = [...visible]
        .filter((item) => !item.dataset.thumbnailState)
        .sort((first, second) => Math.abs(pageOf(first) - page) - Math.abs(pageOf(second) - page))[0];
      if (target) {
        active = { target, cancelled: false };
        void render(active);
      }
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const { target, isIntersecting } of entries) {
          const preview = target as HTMLElement;
          if (isIntersecting) visible.add(preview);
          else visible.delete(preview);
        }
        if (active && !visible.has(active.target)) cancel(active);
        next();
      },
      { root, threshold: 0.1 },
    );
    for (const target of targets) observer.observe(target);
    return () => {
      closed = true;
      observer.disconnect();
      if (active) cancel(active);
    };
  }, [document, first, last, page]);

  return (
    <nav aria-label="PDF thumbnails" className={styles.strip}>
      <ol ref={list} className={styles.list}>
        {pages.map((number) => (
          <li key={number}>
            <button
              ref={number === page ? activeButton : undefined}
              className={styles.page}
              type="button"
              aria-label={`Page ${number}`}
              aria-current={number === page ? 'page' : undefined}
              onClick={() => onSelect(number)}
            >
              <span className={styles.preview} data-thumbnail-page={number} aria-hidden="true" />
              <span>{number}</span>
            </button>
          </li>
        ))}
      </ol>
    </nav>
  );
}
