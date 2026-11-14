'use client';

import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent, type PointerEvent, type ReactNode } from 'react';
import type { PDFDocumentLoadingTask, PDFDocumentProxy, PDFPageProxy, RenderTask, TextLayer } from 'pdfjs-dist';
import { reflowLiteraturePdfPageWithMap, scanLiteraturePdfRunningMargins, type LiteraturePdfRunningMargins } from '../lib/literature-pdf-reflow';
import { canRecognizeLiteraturePdfScans, recognizeLiteraturePdfPage } from '../lib/literature-pdf-ocr';
import { useLiteratureReaderPreferences } from '../lib/literature-reader-preferences';
import { LiteratureReaderAppearance } from './LiteratureReaderAppearance';
import { LiteratureReadAloud } from './LiteratureReadAloud';
import { LiteraturePdfThumbnails } from './LiteraturePdfThumbnails';
import { Loading, Modal, Notice } from './ui';
import styles from './LiteraturePdfReader.module.css';

type Rect = { x: number; y: number; width: number; height: number };
export type PdfInkPoint = { x: number; y: number };
const maxInkPoints = 512;

export type LiteraturePdfSelection = { page: number; text: string; rects: Rect[]; ink_path?: PdfInkPoint[] | null };
export type LiteraturePdfHighlight = LiteraturePdfSelection & {
  id: string;
  color?: string;
  kind?: 'highlight' | 'underline' | 'note' | 'area' | 'ink';
};

type PdfModule = typeof import('pdfjs-dist');
type LoadedPdf = { module: PdfModule; document: PDFDocumentProxy };
type Outline = { title: string; destination: string | unknown[]; key: string; depth: number };
type TextMark = { from: number; to: number; annotation: LiteraturePdfHighlight };
const noHighlights: readonly LiteraturePdfHighlight[] = [];

const errorMessage = (error: unknown, fallback: string) =>
  error instanceof Error && error.message ? error.message : fallback;

export function LiteraturePdfReader({
  title,
  inline,
  load,
  onClose,
  initialPage = 1,
  modeStorageKey,
  onPageChange,
  onUseForResearch,
  onSelection,
  onAddNote,
  onAddArea,
  onAddInk,
  pendingInk,
  activeAnnotation,
  onOpenNote,
  highlights = noHighlights,
  requestedPage,
  sidePanel,
  showOriginalAnnotations = true,
}: {
  title: string;
  inline?: boolean;
  load: (signal: AbortSignal) => Promise<ArrayBuffer>;
  onClose: () => void;
  initialPage?: number;
  modeStorageKey?: string;
  onPageChange?: (page: number) => void;
  onUseForResearch?: (page: number) => void;
  onSelection?: (selection: LiteraturePdfSelection) => void;
  onAddNote?: (selection: LiteraturePdfSelection) => void;
  onAddArea?: (selection: LiteraturePdfSelection) => void;
  onAddInk?: (selection: LiteraturePdfSelection) => void;
  pendingInk?: LiteraturePdfSelection;
  activeAnnotation?: string;
  onOpenNote?: (id: string) => void;
  highlights?: readonly LiteraturePdfHighlight[];
  requestedPage?: { page: number; revision: number };
  sidePanel?: ReactNode | ((pdf: PDFDocumentProxy) => ReactNode);
  showOriginalAnnotations?: boolean;
}) {
  const loader = useRef(load);
  const openingPage = useRef(initialPage);
  const pageChange = useRef(onPageChange);
  loader.current = load;
  pageChange.current = onPageChange;
  const [pdf, setPdf] = useState<LoadedPdf>();
  const [error, setError] = useState('');
  const [renderError, setRenderError] = useState('');
  const [retry, setRetry] = useState(0);
  const [page, setPage] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [mode, setMode] = useState<'pdf' | 'reading'>('pdf');
  const [splitReading, setSplitReading] = useState(false);
  const splitKey = modeStorageKey ? `${modeStorageKey}.split` : undefined;
  useEffect(() => {
    if (!modeStorageKey) return;
    try {
      setMode(localStorage.getItem(modeStorageKey) === 'reading' ? 'reading' : 'pdf');
      setSplitReading(Boolean(splitKey && localStorage.getItem(splitKey) === 'true'));
    } catch {}
  }, [modeStorageKey, splitKey]);
  const { preferences, updatePreferences } = useLiteratureReaderPreferences();
  const [reflow, setReflow] = useState<ReturnType<typeof reflowLiteraturePdfPageWithMap>>();
  const pageText = useRef<{ page: number; content: Awaited<ReturnType<PDFPageProxy['getTextContent']>>; bounds: number[] }>(null);
  const marginCache = useRef(new Map<number, Promise<LiteraturePdfRunningMargins | undefined>>());
  const [speakingParagraph, setSpeakingParagraph] = useState<number | null>(null);
  const [scanAvailable, setScanAvailable] = useState(false);
  const [scannedPage, setScannedPage] = useState<{ page: number; lines: string[]; error?: string }>();
  const [scanningPage, setScanningPage] = useState(false);
  const scan = useRef<AbortController>(null);
  const scanLines = scannedPage?.page === page ? scannedPage.lines : undefined;
  const readingParagraphs = reflow?.paragraphs.length ? reflow.paragraphs : scanLines;
  useEffect(() => { setScanAvailable(canRecognizeLiteraturePdfScans()); }, []);
  useEffect(() => {
    setScanningPage(false);
    return () => { scan.current?.abort(); scan.current = null; };
  }, [pdf, page, mode]);
  const paragraphSpans = useMemo(() => {
    const groups = reflow?.paragraphs.map(() => [] as number[]) ?? [];
    reflow?.spans.forEach((span, index) => groups[span.paragraph].push(index));
    return groups;
  }, [reflow]);
  const originalSpans = useRef<(HTMLElement | undefined)[]>([]);
  const reading = useRef<HTMLElement>(null);
  const [marksBySpan, setMarksBySpan] = useState<Record<number, TextMark[]>>({});
  const [width, setWidth] = useState(0);
  const [frame, setFrame] = useState<{ width: number; height: number }>();
  const [outline, setOutline] = useState<Outline[]>([]);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [thumbnailsOpen, setThumbnailsOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [find, setFind] = useState('');
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<number[]>([]);
  const [searchError, setSearchError] = useState('');
  const [selection, setSelection] = useState<LiteraturePdfSelection>();
  const [placingNote, setPlacingNote] = useState(false);
  const [placingArea, setPlacingArea] = useState(false);
  const [drawingInk, setDrawingInk] = useState(false);
  const [draftInk, setDraftInk] = useState<PdfInkPoint[]>();
  const inkStroke = useRef<{ pointer: number; points: PdfInkPoint[] }>(null);
  const [draftArea, setDraftArea] = useState<Rect>();
  const [activeAreaId, setActiveAreaId] = useState<string>();
  const areaStart = useRef<{ x: number; y: number; pointer: number }>(null);
  const [painted, setPainted] = useState(false);
  const scroll = useRef<HTMLDivElement>(null);
  const textPane = useRef<HTMLDivElement>(null);
  const originalPane = useRef<HTMLDivElement>(null);
  const canSplit = width >= 600;
  const split = mode === 'reading' && splitReading && canSplit;
  const splitWidth = split ? Math.floor((width - 52) / 2) : width;
  const paper = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const textCache = useRef(new Map<number, string>());
  const activeMarkId = highlights.find((item) => item.id === activeAnnotation && item.page === page)?.id;
  useEffect(() => {
    if (!painted || !activeMarkId) return;
    const frame = requestAnimationFrame(() => {
      paper.current?.querySelector('[data-active-annotation="true"]')?.scrollIntoView({ block: 'center', inline: 'nearest' });
    });
    return () => cancelAnimationFrame(frame);
  }, [activeMarkId, painted]);

  useEffect(() => {
    const abort = new AbortController();
    let worker: Worker | undefined;
    let task: PDFDocumentLoadingTask | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const finish = (message: string) => {
      if (!abort.signal.aborted) setError(message);
    };
    const fail = (message: string) => {
      finish(message);
      abort.abort();
      void task?.destroy().catch(() => {});
      worker?.terminate();
    };

    async function open() {
      setError('');
      setPdf(undefined);
      setOutline([]);
      setResults([]);
      textCache.current.clear();
      marginCache.current.clear();
      pageText.current = null;
      try {
        const [module, bytes] = await Promise.all([
          import('pdfjs-dist/legacy/build/pdf.mjs') as Promise<PdfModule>,
          loader.current(abort.signal),
        ]);
        if (abort.signal.aborted) return;
        worker = new Worker(new URL('pdfjs-dist/legacy/build/pdf.worker.min.mjs', import.meta.url), {
          type: 'module',
        });
        worker.addEventListener('error', () => fail('The PDF reader could not start.'), { once: true });
        task = module.getDocument({
          data: new Uint8Array(bytes),
          worker: module.PDFWorker.create({ port: worker }),
          useSystemFonts: true,
          useWorkerFetch: false,
          useWasm: false,
          enableXfa: false,
        });
        task.onPassword = () => {
          fail('This PDF is password-protected. Open an unlocked copy.');
        };
        const document = await task.promise;
        if (abort.signal.aborted) return;
        setPage(Math.max(1, Math.min(Math.floor(openingPage.current) || 1, document.numPages)));
        setPdf({ module, document });
        setError('');
        void document
          .getOutline()
          .then((items) => {
            if (!abort.signal.aborted) setOutline(flattenOutline(items));
          })
          .catch(() => {});
      } catch (cause) {
        fail(errorMessage(cause, 'Could not open this PDF.'));
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    }

    timeout = setTimeout(() => fail('Opening this PDF timed out. Try again.'), 45_000);
    void open();
    return () => {
      abort.abort();
      if (timeout) clearTimeout(timeout);
      void task?.destroy().catch(() => {});
      worker?.terminate();
    };
  }, [retry]);

  useEffect(() => {
    const viewport = scroll.current;
    if (!viewport) return;
    const observer = new ResizeObserver(() => setWidth(viewport.clientWidth));
    observer.observe(viewport);
    setWidth(viewport.clientWidth);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!pdf || !canvas.current || !layer.current || !width) return;
    const target = canvas.current;
    const textLayer = layer.current;
    const pageFrame = paper.current!;
    let cancel = false;
    let renderTask: RenderTask | undefined;
    let textTask: TextLayer | undefined;
    setPainted(false);
    setReflow(undefined);
    pageText.current = null;
    originalSpans.current = [];
    setRenderError('');
    setSelection(undefined);

    async function render() {
      try {
        const source = await pdf!.document.getPage(page);
        if (cancel) return;
        const content = await source.getTextContent();
        if (cancel) return;
        const base = source.getViewport({ scale: 1 });
        const scale = Math.min(1.2, Math.max(1, splitWidth - (split ? 0 : 32)) / base.width) * zoom;
        const viewport = source.getViewport({ scale });
        const density = Math.max(
          0.05,
          Math.min(
            window.devicePixelRatio || 1,
            2,
            Math.sqrt(16_000_000 / (viewport.width * viewport.height)),
            8192 / Math.max(viewport.width, viewport.height),
          ),
        );
        setFrame({ width: viewport.width, height: viewport.height });
        target.width = Math.max(1, Math.floor(viewport.width * density));
        target.height = Math.max(1, Math.floor(viewport.height * density));
        target.style.width = `${viewport.width}px`;
        target.style.height = `${viewport.height}px`;
        const rotation = viewport.rotation % 360;
        const cssWidth = rotation === 90 || rotation === 270 ? viewport.height : viewport.width;
        const cssHeight = rotation === 90 || rotation === 270 ? viewport.width : viewport.height;
        pageFrame.style.setProperty('--total-scale-factor', String(scale * source.userUnit));
        textLayer.replaceChildren();

        renderTask = source.render({
          canvas: target,
          viewport,
          annotationMode: showOriginalAnnotations ? pdf!.module.AnnotationMode.ENABLE : pdf!.module.AnnotationMode.DISABLE,
          transform: [target.width / viewport.width, 0, 0, target.height / viewport.height, 0, 0],
        });
        textTask = new pdf!.module.TextLayer({
          textContentSource: content,
          container: textLayer,
          viewport,
        });
        // Explicit dimensions also support browsers without CSS round() and rotated page text.
        textLayer.style.width = `${cssWidth}px`;
        textLayer.style.height = `${cssHeight}px`;
        await Promise.all([renderTask.promise, textTask.render()]);
        if (!cancel) {
          textCache.current.set(page, normalizeSearch(textTask.textContentItemsStr.join(' ')));
          let textIndex = 0;
          originalSpans.current = content.items.map((item) => 'str' in item ? textTask!.textDivs[textIndex++] : undefined);
          pageText.current = { page, content, bounds: source.view };
          setPainted(true);
        }
      } catch (cause) {
        if (!cancel) setRenderError(errorMessage(cause, 'Could not render this page.'));
      }
    }
    void render();
    return () => {
      cancel = true;
      renderTask?.cancel();
      textTask?.cancel();
    };
  }, [pdf, page, width, split, splitWidth, zoom, showOriginalAnnotations]);

  useEffect(() => {
    const source = pageText.current;
    if (!pdf || !painted || mode !== 'reading' || source?.page !== page) return;
    const document = pdf.document;
    let cancelled = false;
    async function layout() {
      const nearby = [-2, -1, 1, 2].map((offset) => page + offset).filter((number) => number >= 1 && number <= document.numPages);
      const readMargins = (number: number) => {
        const cached = marginCache.current.get(number);
        if (cached) return cached;
        const pending = document.getPage(number).then(async (candidate) =>
          scanLiteraturePdfRunningMargins(await candidate.getTextContent(), number, candidate.view)).catch(() => undefined);
        marginCache.current.set(number, pending);
        return pending;
      };
      const nearbyMargins = (await Promise.all(nearby.map(readMargins))).filter((item) => item !== undefined);
      if (!cancelled && pageText.current === source) setReflow(reflowLiteraturePdfPageWithMap(source!.content, {
        pageNumber: page, bounds: source!.bounds, nearbyMargins,
      }));
    }
    void layout();
    return () => { cancelled = true; };
  }, [pdf, page, painted, mode]);

  async function readScan() {
    if (!pdf || scan.current) return;
    const controller = new AbortController();
    scan.current = controller;
    setScanningPage(true);
    setScannedPage(undefined);
    try {
      const source = await pdf.document.getPage(page);
      const text = await recognizeLiteraturePdfPage(source, controller.signal);
      if (!controller.signal.aborted) setScannedPage({ page, lines: text.split(/\n/u).map((line) => line.trim()).filter(Boolean) });
    } catch (error) {
      if (!controller.signal.aborted) setScannedPage({ page, lines: [], error: errorMessage(error, 'Could not recognize this scanned page.') });
    } finally {
      if (scan.current === controller) {
        scan.current = null;
        if (!controller.signal.aborted) setScanningPage(false);
      }
    }
  }

  useEffect(() => {
    if (!pdf) return;
    setPlacingNote(false);
    setPlacingArea(false);
    setDrawingInk(false);
    setDraftInk(undefined);
    inkStroke.current = null;
    setDraftArea(undefined);
    areaStart.current = null;
    scroll.current?.scrollTo({ top: 0, left: 0 });
    textPane.current?.scrollTo({ top: 0, left: 0 });
    originalPane.current?.scrollTo({ top: 0, left: 0 });
    pageChange.current?.(page);
  }, [pdf, page]);

  useEffect(() => {
    setSelection(undefined);
    scroll.current?.scrollTo({ top: 0, left: 0 });
    textPane.current?.scrollTo({ top: 0, left: 0 });
    originalPane.current?.scrollTo({ top: 0, left: 0 });
  }, [mode, split]);

  useEffect(() => {
    if (speakingParagraph !== null) {
      reading.current?.querySelector('[data-speaking="true"]')?.scrollIntoView({ block: 'nearest' });
    }
  }, [speakingParagraph]);

  useEffect(() => {
    const requested = requestedPage?.page;
    if (
      pdf &&
      requested !== undefined &&
      Number.isInteger(requested) &&
      requested >= 1 &&
      requested <= pdf.document.numPages
    )
      setPage(requested);
  }, [pdf, requestedPage?.page, requestedPage?.revision]);

  useEffect(() => {
    if (!onSelection || !painted) return;
    const read = () => {
      const selected = window.getSelection();
      const container = layer.current;
      const text = selected?.toString().trim().slice(0, 12_000);
      if (!selected?.rangeCount || !container || !text) return;
      const bounds = paper.current?.getBoundingClientRect();
      if (!bounds || bounds.width <= 0 || bounds.height <= 0) return;
      const selectionRange = selected.getRangeAt(0);
      let boxes: DOMRect[] = [];
      if (container.contains(selected.anchorNode) && container.contains(selected.focusNode)) {
        boxes = Array.from(selectionRange.getClientRects());
      } else if (mode === 'reading' && reading.current?.contains(selected.anchorNode) &&
          reading.current.contains(selected.focusNode)) {
        for (const span of reading.current.querySelectorAll<HTMLElement>('[data-source-span]')) {
          if (!selectionRange.intersectsNode(span)) continue;
          const entry = reflow?.spans[Number(span.dataset.sourceSpan)];
          const node = entry && originalSpans.current[entry.itemIndex]?.firstChild;
          if (!entry || !node || node.nodeType !== Node.TEXT_NODE) continue;
          const range = document.createRange();
          const offsetInSpan = (container: Node, offset: number, fallback: number) => {
            if (!span.contains(container)) return fallback;
            const before = document.createRange();
            before.selectNodeContents(span);
            before.setEnd(container, offset);
            return before.toString().length;
          };
          const from = offsetInSpan(selectionRange.startContainer, selectionRange.startOffset, 0);
          const to = offsetInSpan(selectionRange.endContainer, selectionRange.endOffset, entry.to - entry.from);
          const end = Math.min(node.textContent?.length ?? 0, entry.sourceFrom + to);
          const start = Math.min(end, entry.sourceFrom + from);
          if (start >= end) continue;
          range.setStart(node, start);
          range.setEnd(node, end);
          boxes.push(...Array.from(range.getClientRects()));
        }
      }
      const rects = boxes.flatMap((rect) => {
        const left = Math.max(bounds.left, rect.left);
        const right = Math.min(bounds.right, rect.right);
        const top = Math.max(bounds.top, rect.top);
        const bottom = Math.min(bounds.bottom, rect.bottom);
        if (right - left < 1 || bottom - top < 1) return [];
        return [{ x: (left - bounds.left) / bounds.width, y: (top - bounds.top) / bounds.height,
          width: (right - left) / bounds.width, height: (bottom - top) / bounds.height }];
      }).slice(0, 300);
      if (rects.length) setSelection({ page, text, rects });
    };
    document.addEventListener('selectionchange', read);
    return () => document.removeEventListener('selectionchange', read);
  }, [painted, page, mode, reflow, onSelection]);

  useEffect(() => {
    if (!painted || mode !== 'reading' || !reflow) return;
    const bounds = paper.current?.getBoundingClientRect();
    if (!bounds?.width || !bounds.height) return;
    const annotations = highlights.filter((item) => item.page === page && (item.kind === 'highlight' || item.kind === 'underline' || !item.kind));
    const mapped: Record<number, TextMark[]> = {};
    const overlaps = (box: DOMRect, rect: Rect, horizontal: number) => {
      if (!box.width || !box.height) return false;
      const x = (box.left - bounds.left) / bounds.width;
      const y = (box.top - bounds.top) / bounds.height;
      const w = box.width / bounds.width;
      const h = box.height / bounds.height;
      return Math.min(x + w, rect.x + rect.width) - Math.max(x, rect.x) > w * horizontal &&
        Math.min(y + h, rect.y + rect.height) - Math.max(y, rect.y) > h * 0.5;
    };
    if (annotations.length) {
      for (const [index, span] of reflow.spans.entries()) {
        const node = originalSpans.current[span.itemIndex]?.firstChild;
        if (!node || node.nodeType !== Node.TEXT_NODE || span.sourceTo > (node.textContent?.length ?? 0)) continue;
        const range = document.createRange();
        range.setStart(node, span.sourceFrom);
        range.setEnd(node, span.sourceTo);
        const box = range.getBoundingClientRect();
        const candidates = annotations.filter((item) => item.rects.some((rect) => overlaps(box, rect, 0)));
        if (!candidates.length) continue;
        const fullyCovered = candidates.length === 1 && candidates[0].rects.some((rect) => overlaps(box, rect, 0.995));
        if (fullyCovered) {
          mapped[index] = [{ from: span.from, to: span.to, annotation: candidates[0] }];
          continue;
        }
        const marks: TextMark[] = [];
        let from = span.from;
        for (const character of node.textContent!.slice(span.sourceFrom, span.sourceTo)) {
          const to = from + character.length;
          range.setStart(node, span.sourceFrom + from - span.from);
          range.setEnd(node, span.sourceFrom + to - span.from);
          const characterBox = range.getBoundingClientRect();
          const match = candidates.find((item) => item.rects.some((rect) => overlaps(characterBox, rect, 0.5)));
          const previous = marks.at(-1);
          if (match && previous?.to === from && previous.annotation.id === match.id) previous.to = to;
          else if (match) marks.push({ from, to, annotation: match });
          from = to;
        }
        if (marks.length) mapped[index] = marks;
      }
    }
    setMarksBySpan(mapped);
  }, [highlights, mode, page, painted, reflow]);

  useEffect(() => {
    if (!pdf || !find) {
      setSearching(false);
      setResults([]);
      setSearchError('');
      return;
    }
    let cancelled = false;
    const activePdf = pdf;
    const query = normalizeSearch(find);
    const matches: number[] = [];
    setSearching(true);
    setResults([]);
    setSearchError('');
    async function run() {
      let unavailable = 0;
      for (let number = 1; number <= activePdf.document.numPages; number++) {
        if (cancelled) return;
        try {
          let content = textCache.current.get(number);
          if (content === undefined) {
            const source = await activePdf.document.getPage(number);
            const text = await source.getTextContent();
            if (cancelled) return;
            content = normalizeSearch(text.items.map((item) => ('str' in item ? item.str : '')).join(' '));
            textCache.current.set(number, content);
          }
          if (content.includes(query)) matches.push(number);
        } catch {
          unavailable++;
        }
      }
      if (cancelled) return;
      if (unavailable)
        setSearchError(`Could not search ${unavailable} ${unavailable === 1 ? 'page' : 'pages'}.`);
      setResults(matches);
      setSearching(false);
    }
    void run();
    return () => {
      cancelled = true;
    };
  }, [pdf, find]);

  function go(number: number) {
    if (pdf && Number.isInteger(number) && number >= 1 && number <= pdf.document.numPages) setPage(number);
  }

  async function openDestination(destination: Outline['destination']) {
    if (!pdf) return;
    try {
      const target =
        typeof destination === 'string' ? await pdf.document.getDestination(destination) : destination;
      const address = target?.[0];
      if (typeof address === 'number') go(address + 1);
      else if (address && typeof address === 'object' && 'num' in address && 'gen' in address)
        go((await pdf.document.getPageIndex(address as { num: number; gen: number })) + 1);
    } catch {
      setRenderError('This outline entry could not be opened.');
    }
  }

  function keyboard(event: KeyboardEvent) {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
      event.preventDefault();
      searchInput.current?.focus();
      searchInput.current?.select();
    }
    if (event.target !== scroll.current && event.target !== textPane.current && event.target !== originalPane.current) return;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      go(page + (event.key === 'ArrowLeft' ? -1 : 1));
    }
  }

  function addNote(event: MouseEvent<HTMLDivElement>) {
    if (!placingNote || !painted || !onAddNote || !paper.current) return;
    const { left, top, width, height } = paper.current.getBoundingClientRect();
    if (width <= 0 || height <= 0) return;
    const markerWidth = Math.min(0.045, 22 / width);
    const markerHeight = Math.min(0.045, 22 / height);
    const x = Math.max(0, Math.min(1 - markerWidth, (event.clientX - left) / width - markerWidth / 2));
    const y = Math.max(0, Math.min(1 - markerHeight, (event.clientY - top) / height - markerHeight / 2));
    onAddNote({ page, text: '', rects: [{ x, y, width: markerWidth, height: markerHeight }] });
    setPlacingNote(false);
  }

  function areaPoint(event: PointerEvent<HTMLDivElement>) {
    const { left, top, width, height } = event.currentTarget.getBoundingClientRect();
    return { x: Math.max(0, Math.min(1, (event.clientX - left) / width)),
      y: Math.max(0, Math.min(1, (event.clientY - top) / height)) };
  }

  function trackArea(event: PointerEvent<HTMLDivElement>, finished: boolean) {
    const start = areaStart.current;
    if (!start || start.pointer !== event.pointerId) return;
    const point = areaPoint(event);
    const rect = { x: Math.min(start.x, point.x), y: Math.min(start.y, point.y),
      width: Math.abs(start.x - point.x), height: Math.abs(start.y - point.y) };
    if (!finished) {
      setDraftArea(rect);
      return;
    }
    setDraftArea(undefined);
    areaStart.current = null;
    if (rect.width * event.currentTarget.clientWidth >= 6 && rect.height * event.currentTarget.clientHeight >= 6) {
      onAddArea?.({ page, text: '', rects: [rect] });
      setPlacingArea(false);
    }
  }

  function trackInk(event: PointerEvent<HTMLDivElement>, finished: boolean) {
    const stroke = inkStroke.current;
    if (!stroke || stroke.pointer !== event.pointerId) return;
    const point = areaPoint(event);
    const previous = stroke.points.at(-1)!;
    const moved = Math.hypot((point.x - previous.x) * event.currentTarget.clientWidth,
      (point.y - previous.y) * event.currentTarget.clientHeight);
    if (moved >= (finished ? 0.25 : 1.5)) {
      if (stroke.points.length >= maxInkPoints) stroke.points = stroke.points.filter((_, index) => index % 2 === 0);
      stroke.points.push(point);
    }
    if (!finished) {
      setDraftInk([...stroke.points]);
      return;
    }
    inkStroke.current = null;
    setDraftInk(undefined);
    if (stroke.points.length < 2) return;
    const xs = stroke.points.map((value) => value.x);
    const ys = stroke.points.map((value) => value.y);
    const x = Math.max(0, Math.min(...xs) - 0.002);
    const y = Math.max(0, Math.min(...ys) - 0.002);
    const width = Math.min(1, Math.max(...xs) + 0.002) - x;
    const height = Math.min(1, Math.max(...ys) + 0.002) - y;
    onAddInk?.({ page, text: '', rects: [{ x, y, width, height }], ink_path: stroke.points });
    setDrawingInk(false);
  }

  const activeArea = highlights.find((item) => item.id === activeAreaId && item.kind === 'area' && item.page === page);
  function downloadArea() {
    const source = canvas.current;
    const rect = activeArea?.rects[0];
    if (!source || !rect || !activeArea) return;
    const output = document.createElement('canvas');
    const x = Math.floor(rect.x * source.width);
    const y = Math.floor(rect.y * source.height);
    output.width = Math.min(source.width - x, Math.ceil(rect.width * source.width));
    output.height = Math.min(source.height - y, Math.ceil(rect.height * source.height));
    if (!output.width || !output.height) return;
    output.getContext('2d')?.drawImage(source, x, y, output.width, output.height, 0, 0, output.width, output.height);
    output.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `page-${page}-area.png`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    });
  }

  return (
    <Modal title={title} onClose={onClose} wide inline={inline} className={!inline && mode === 'reading' ? styles.readingModal : undefined}>
      <div className={styles.reader} onKeyDown={keyboard}>
        {error && <Notice tone="error">{error}</Notice>}
        {error && !pdf && (
          <button type="button" className="button" onClick={() => setRetry(retry + 1)}>
            Try again
          </button>
        )}
        {!pdf && !error && <Loading />}
        {pdf && (
          <div className={styles.controls}>
            <div className={styles.toolbar}>
              <button
                type="button"
                className="button small"
                onClick={() => go(page - 1)}
                disabled={page <= 1}
                aria-label="Previous page"
              >
                ‹
              </button>
              <PageNumber key={page} page={page} count={pdf.document.numPages} onGo={go} />
              <button
                type="button"
                className="button small"
                onClick={() => go(page + 1)}
                disabled={page >= pdf.document.numPages}
                aria-label="Next page"
              >
                ›
              </button>
              <button
                type="button"
                className="button small"
                onClick={() => setZoom(Math.max(0.5, zoom - 0.25))}
                disabled={zoom <= 0.5}
                aria-label="Zoom out"
              >
                −
              </button>
              <button
                type="button"
                className="button small"
                onClick={() => setZoom(1)}
                aria-label="Fit page width"
              >
                {zoom === 1 ? 'Fit width' : `${Math.round(zoom * 100)}%`}
              </button>
              <button
                type="button"
                className="button small"
                onClick={() => setZoom(Math.min(3, zoom + 0.25))}
                disabled={zoom >= 3}
                aria-label="Zoom in"
              >
                +
              </button>
              <button type="button" className="button small" aria-pressed={mode === 'reading'}
                onClick={() => {
                  const selected = mode === 'pdf' ? 'reading' : 'pdf';
                  setMode(selected);
                  if (modeStorageKey) try { localStorage.setItem(modeStorageKey, selected); } catch {}
                }}>
                {mode === 'pdf' ? 'Reading mode' : 'Original PDF'}
              </button>
              {mode === 'reading' && canSplit && <button type="button" className="button small" aria-pressed={split}
                onClick={() => {
                  const selected = !splitReading;
                  setSplitReading(selected);
                  if (splitKey) try { localStorage.setItem(splitKey, String(selected)); } catch {}
                }}>Side-by-side</button>}
              {outline.length > 0 && (
                <button
                  type="button"
                  className="button small"
                  onClick={() => setOutlineOpen(!outlineOpen)}
                  aria-expanded={outlineOpen}
                >
                  Outline
                </button>
              )}
              <button type="button" className="button small" aria-expanded={thumbnailsOpen}
                onClick={() => setThumbnailsOpen(!thumbnailsOpen)}>Page thumbnails</button>
              {onUseForResearch && (
                <button type="button" className="button small" onClick={() => onUseForResearch(page)}>
                  Use page in research
                </button>
              )}
              {onSelection && (
                <button
                  type="button"
                  className="button small primary"
                  disabled={!selection}
                  onClick={() => {
                    if (!selection) return;
                    onSelection(selection);
                    setSelection(undefined);
                    window.getSelection()?.removeAllRanges();
                  }}
                >
                  Highlight selection
                </button>
              )}
              {onAddNote && <button type="button" className="button small" disabled={!painted}
                aria-pressed={placingNote} onClick={() => {
                  if (!placingNote && mode === 'reading') setMode('pdf');
                  setPlacingArea(false);
                  setDrawingInk(false);
                  setPlacingNote(!placingNote);
                }}>{placingNote ? 'Cancel placement' : 'Add page note'}</button>}
              {placingNote && <span className="muted small-text">Click a location on the PDF.</span>}
              {onAddArea && <button type="button" className="button small" disabled={!painted} aria-pressed={placingArea}
                onClick={() => {
                  if (!placingArea && mode === 'reading') setMode('pdf');
                  setPlacingNote(false);
                  setDrawingInk(false);
                  setPlacingArea(!placingArea);
                  setDraftArea(undefined);
                }}>{placingArea ? 'Cancel area selection' : 'Mark area'}</button>}
              {placingArea && <span className="muted small-text">Drag over a figure, table, or formula.</span>}
              {onAddInk && <button type="button" className="button small" disabled={!painted || !!pendingInk} aria-pressed={drawingInk}
                onClick={() => {
                  if (!drawingInk && mode === 'reading') setMode('pdf');
                  setPlacingArea(false);
                  setPlacingNote(false);
                  setDrawingInk(!drawingInk);
                  setDraftInk(undefined);
                  inkStroke.current = null;
                }}>{drawingInk ? 'Cancel drawing' : 'Draw ink'}</button>}
              {drawingInk && <span className="muted small-text">Draw a stroke on the PDF.</span>}
              {activeArea && painted && mode === 'pdf' && !placingArea && !placingNote &&
                <button className="button small" type="button" onClick={downloadArea}>Download area image</button>}
            </div>
            <form
              className={styles.toolbar}
              onSubmit={(event) => {
                event.preventDefault();
                setFind(search.trim());
              }}
            >
              <input
                ref={searchInput}
                type="search"
                value={search}
                maxLength={200}
                onChange={(event) => {
                  setSearch(event.target.value);
                  if (!event.target.value.trim()) setFind('');
                }}
                aria-label="Find in PDF"
                placeholder="Find in PDF"
              />
              <button type="submit" className="button small" disabled={!search.trim()}>
                Find
              </button>
              {searching && <span role="status">Searching…</span>}
              {!searching && find && results.length === 0 && <span role="status">No matching pages</span>}
              {results.length > 0 && (
                <label className={styles.pageNumber}>
                  <span>
                    {results.length} matching {results.length === 1 ? 'page' : 'pages'}
                  </span>
                  <select
                    aria-label="Matching pages"
                    value={results.includes(page) ? String(page) : ''}
                    onChange={(event) => go(Number(event.target.value))}
                  >
                    <option value="" disabled>
                      Go to page
                    </option>
                    {results.map((result) => (
                      <option key={result} value={result}>
                        Page {result}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </form>
            {searchError && (
              <p className="muted" role="status">
                {searchError}
              </p>
            )}
            {outlineOpen && outline.length > 0 && (
              <nav className={styles.outline} aria-label="PDF outline">
                {outline.map((item) => (
                  <button
                    key={item.key}
                    type="button"
                    className="button small"
                    style={{ paddingInlineStart: `${12 + 12 * item.depth}px` }}
                    onClick={() => void openDestination(item.destination)}
                  >
                    {item.title}
                  </button>
                ))}
              </nav>
            )}
          </div>
        )}
        {mode === 'reading' && pdf && <LiteratureReaderAppearance preferences={preferences} update={updatePreferences} />}
        {mode === 'reading' && painted && !!readingParagraphs?.length && <LiteratureReadAloud key={page}
          paragraphs={readingParagraphs} onParagraph={setSpeakingParagraph} />}
        {renderError && <Notice tone="error">{renderError}</Notice>}
        <div className={styles.readingArea} data-side-panel={Boolean(sidePanel)} data-thumbnails={thumbnailsOpen || undefined}>
          {pdf && thumbnailsOpen && <LiteraturePdfThumbnails document={pdf.document} page={page} onSelect={go} />}
          <div
            ref={scroll}
            className={styles.scroll}
            data-reader-theme={mode === 'reading' ? preferences.theme : undefined}
            hidden={!pdf}
            tabIndex={0}
            role="region"
            aria-label="PDF page viewer"
            aria-busy={!!pdf && !painted && !renderError}
          >
            <div className={split ? styles.splitView : undefined}>
            <div ref={textPane} className={split ? styles.splitText : undefined}
              role={split ? 'region' : undefined} aria-label={split ? 'Reading text' : undefined} tabIndex={split ? 0 : undefined}>
            {mode === 'reading' && painted && !reflow && <Loading />}
            {mode === 'reading' && painted && reflow && (
              <article ref={reading} className={styles.reflow} aria-label="Reflowed page"
                style={{ fontFamily: preferences.font, fontSize: preferences.fontSize, lineHeight: preferences.lineHeight }}>
                {reflow?.paragraphs.length ? reflow.paragraphs.map((paragraph, index) => {
                  const children: ReactNode[] = [];
                  let from = 0;
                  for (const spanIndex of paragraphSpans[index]) {
                    const span = reflow.spans[spanIndex];
                    children.push(paragraph.slice(from, span.from));
                    const marks = marksBySpan[spanIndex];
                    const parts: ReactNode[] = [];
                    let offset = span.from;
                    for (const mark of marks ?? []) {
                      parts.push(paragraph.slice(offset, mark.from));
                      parts.push(<span key={mark.from} data-kind={mark.annotation.kind ?? 'highlight'}
                        style={{ '--highlight-color': mark.annotation.color ?? '#ffda45' } as CSSProperties}>
                        {paragraph.slice(mark.from, mark.to)}
                      </span>);
                      offset = mark.to;
                    }
                    parts.push(paragraph.slice(offset, span.to));
                    children.push(<span key={spanIndex} data-source-span={spanIndex}>{parts}</span>);
                    from = span.to;
                  }
                  children.push(paragraph.slice(from));
                  return <p key={index} data-speaking={speakingParagraph === index || undefined}>{children}</p>;
                }) : !!scanLines?.length ? <>
                  <p className={styles.originalLabel}>Text recognized from this scan</p>
                  {scanLines.map((line, index) => <p key={index} data-speaking={speakingParagraph === index || undefined}>{line}</p>)}
                </> : <>
                  <p>No selectable text on this page.</p>
                  {scannedPage?.page === page && !scanningPage && <p role="status" className="small-text muted">
                    {scannedPage.error || 'No text was recognized on this page.'}
                  </p>}
                  {scanAvailable && <button type="button" className="button small" disabled={scanningPage} onClick={() => void readScan()}>
                    {scanningPage ? 'Recognizing…' : 'Recognize text on this page'}
                  </button>}
                </>}
                {!split && <p className={styles.originalLabel}>Original page · figures, tables, and formulas</p>}
              </article>
            )}
            </div>
            <div ref={originalPane} className={split ? styles.splitOriginal : undefined}
              role={split ? 'region' : undefined} aria-label={split ? 'Original PDF page' : undefined} tabIndex={split ? 0 : undefined}>
            <div ref={paper} className={styles.paper} style={frame} data-painted={painted}
              data-placing-note={placingNote || placingArea || drawingInk || undefined}
              data-placing-area={placingArea || drawingInk || undefined} onClick={addNote}
              onPointerDown={(event) => {
                if ((!placingArea && !drawingInk) || !event.isPrimary || event.button !== 0) return;
                event.preventDefault();
                const point = areaPoint(event);
                if (drawingInk) {
                  inkStroke.current = { pointer: event.pointerId, points: [point] };
                  setDraftInk([point]);
                } else areaStart.current = { ...point, pointer: event.pointerId };
                event.currentTarget.setPointerCapture(event.pointerId);
              }} onPointerMove={(event) => drawingInk ? trackInk(event, false) : trackArea(event, false)}
              onPointerUp={(event) => drawingInk ? trackInk(event, true) : trackArea(event, true)}
              onPointerCancel={() => {
                areaStart.current = null; inkStroke.current = null;
                setDraftArea(undefined); setDraftInk(undefined);
              }}>
              <canvas ref={canvas} aria-hidden="true" />
              <div className={styles.highlights} aria-hidden="true">
                {highlights
                  .filter((item) => item.page === page && item.kind !== 'note' && item.kind !== 'ink')
                  .flatMap((item) =>
                    item.rects.map((rect, index) => (
                      <span
                        key={`${item.id}:${index}`}
                        data-kind={item.kind ?? 'highlight'}
                        data-active-annotation={activeMarkId === item.id || undefined}
                        style={
                          {
                            left: `${rect.x * 100}%`,
                            top: `${rect.y * 100}%`,
                            width: `${rect.width * 100}%`,
                            height: `${rect.height * 100}%`,
                            '--highlight-color': item.color ?? '#ffda45',
                          } as CSSProperties
                        }
                      />
                    )),
                  )}
              </div>
              <svg aria-hidden="true" className={styles.inkLayer} viewBox="0 0 1 1" preserveAspectRatio="none">
                {highlights.map((item) => item.page === page && item.kind === 'ink' && item.ink_path?.length ?
                  <InkLine key={item.id} points={item.ink_path} color={item.color ?? '#9575dd'} active={activeMarkId === item.id} /> : null)}
                {(draftInk ?? (pendingInk?.page === page ? pendingInk.ink_path : undefined))?.length ?
                  <InkLine points={draftInk ?? pendingInk!.ink_path!} color="#9575dd" preview /> : null}
              </svg>
              {draftArea && <span aria-hidden="true" className={styles.draftArea} style={{
                left: `${draftArea.x * 100}%`, top: `${draftArea.y * 100}%`,
                width: `${draftArea.width * 100}%`, height: `${draftArea.height * 100}%`,
              }} />}
              <div ref={layer} className={styles.textLayer} />
              {!placingNote && !placingArea && !drawingInk && highlights.filter((item) => item.page === page && item.kind === 'note')
                .map((item) => {
                  const [rect] = item.rects;
                  return rect && <button key={item.id} type="button" className={styles.notePin}
                    aria-label="Open page note" onClick={() => onOpenNote?.(item.id)}
                    data-active-annotation={activeMarkId === item.id || undefined}
                    style={{ left: `${(rect.x + rect.width / 2) * 100}%`, top: `${(rect.y + rect.height / 2) * 100}%`,
                      backgroundColor: item.color ?? '#ffda45' }}>≡</button>;
                })}
              {!placingArea && !placingNote && !drawingInk && highlights.filter((item) => item.page === page && item.kind === 'area')
                .map((item) => {
                  const [rect] = item.rects;
                  return rect && <button key={item.id} type="button" className={styles.areaTarget}
                    aria-label="Select marked area" aria-pressed={activeAreaId === item.id}
                    onClick={() => { setActiveAreaId(item.id); onOpenNote?.(item.id); }}
                    style={{ left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.width * 100}%`,
                      height: `${rect.height * 100}%` }} />;
                })}
            </div>
            </div>
            </div>
          </div>
          {pdf && sidePanel && <aside className={styles.sidePanel}>{typeof sidePanel === 'function' ? sidePanel(pdf.document) : sidePanel}</aside>}
        </div>
      </div>
    </Modal>
  );
}

function InkLine({ points, color, preview, active }: { points: readonly PdfInkPoint[]; color: string; preview?: boolean; active?: boolean }) {
  return <polyline points={points.map((point) => `${point.x},${point.y}`).join(' ')} fill="none" stroke={color}
    strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke"
    data-ink-stroke={preview ? 'preview' : 'saved'} data-active-annotation={active || undefined} />;
}

function PageNumber({ page, count, onGo }: { page: number; count: number; onGo: (page: number) => void }) {
  const [value, setValue] = useState(String(page));
  return (
    <form
      className={styles.pageNumber}
      onSubmit={(event) => {
        event.preventDefault();
        const requested = Number(value);
        if (Number.isInteger(requested) && requested >= 1 && requested <= count) onGo(requested);
        else setValue(String(page));
      }}
    >
      <input
        type="number"
        aria-label="Page number"
        value={value}
        min={1}
        max={count}
        onChange={(event) => setValue(event.target.value)}
      />
      <span>of {count}</span>
    </form>
  );
}

function normalizeSearch(value: string) {
  return value.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

function flattenOutline(items: Awaited<ReturnType<PDFDocumentProxy['getOutline']>>) {
  const list: Outline[] = [];
  function visit(nodes: typeof items, prefix: string, depth: number) {
    if (depth > 8) return;
    for (const [index, item] of (nodes ?? []).entries()) {
      if (list.length >= 1000) return;
      const key = `${prefix}${index}`;
      if (item.dest !== null && item.title.trim())
        list.push({ key, title: item.title, destination: item.dest, depth });
      visit(item.items, `${key}.`, depth + 1);
    }
  }
  visit(items, '', 0);
  return list;
}
