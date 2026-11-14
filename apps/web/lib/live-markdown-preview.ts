import { syntaxTree } from '@codemirror/language';
import { Facet, StateEffect, StateField, type EditorState, type Range } from '@codemirror/state';
import { Decoration, EditorView, WidgetType } from '@codemirror/view';
import katex from 'katex';
import { readLiveMath } from './live-markdown-math';
import { isKnowledgeImageSource, pdfAreaImageSource } from './knowledge-image-sources';

const focusChanged = StateEffect.define<boolean>();
const hidden = Decoration.replace({});
const heading = /^(?:ATX|Setext)Heading([1-6])$/;
const inlineStyles = {
  StrongEmphasis: ['strong', 'prism-md-strong', 'EmphasisMark'],
  Emphasis: ['em', 'prism-md-emphasis', 'EmphasisMark'],
  Strikethrough: ['s', 'prism-md-strike', 'StrikethroughMark'],
  InlineCode: ['code', 'prism-md-code', 'CodeMark'],
} as const;

class PreviewWidget extends WidgetType {
  private stopImage?: () => void;
  constructor(
    readonly kind: 'math' | 'display' | 'citation' | 'bullet' | 'task' | 'rule' | 'image',
    readonly text: string,
    readonly imageSource?: string,
  ) {
    super();
  }

  eq(other: PreviewWidget) {
    return this.kind === other.kind && this.text === other.text && this.imageSource === other.imageSource;
  }

  toDOM(view: EditorView) {
    const element: HTMLElement = document.createElement(this.kind === 'display' || this.kind === 'rule' ? 'div' : 'span');
    element.className = `prism-md-widget prism-md-${this.kind}`;

    if (this.kind === 'math' || this.kind === 'display') {
      katex.render(this.text, element, { displayMode: this.kind === 'display', throwOnError: false, trust: false });
    } else if (this.kind === 'image' && this.imageSource) {
      const image = document.createElement('img');
      const source = this.imageSource;
      if (pdfAreaImageSource(source)) {
        let active = true;
        let stop: (() => void) | undefined;
        this.stopImage = () => { active = false; stop?.(); };
        void import('./literature-pdf-area-image').then(({ displayLiteraturePdfAreaImage }) => {
          if (active) stop = displayLiteraturePdfAreaImage(image, source);
        }).catch(() => {});
      } else image.src = source;
      image.alt = this.text;
      image.addEventListener('load', () => view.requestMeasure(), { once: true });
      element.append(image);
    } else if (this.kind === 'rule') {
      element.append(document.createElement('hr'));
    } else {
      element.textContent = this.text;
    }
    element.addEventListener('mousedown', (event) => {
      if (event.button === 0 && !event.shiftKey && !view.state.readOnly) event.preventDefault();
    });
    element.addEventListener('click', (event) => {
      if (event.shiftKey || view.state.readOnly) return;
      const start = view.posAtDOM(element);
      view.focus();
      // Place the caret inside the source range, beyond any block widget boundary.
      view.dispatch({ selection: { anchor: start + 1 }, effects: focusChanged.of(true) });
    });
    return element;
  }

  destroy() { this.stopImage?.(); }
}

function decorations(state: EditorState, focused: boolean, citations?: Record<string, string>) {
  const ranges: Range<Decoration>[] = [];
  const { doc, selection } = state;
  const touches = (from: number, to: number) =>
    focused && selection.ranges.some((range) => range.from <= to && range.to >= from);
  const hide = (from: number, to: number) => {
    if (from < to) ranges.push(hidden.range(from, to));
  };
  const mark = (from: number, to: number, className: string, tagName = 'span') => {
    if (from < to) ranges.push(Decoration.mark({ class: className, tagName }).range(from, to));
  };
  const replace = (from: number, to: number, widget: PreviewWidget, block = false) => {
    ranges.push(Decoration.replace({ widget, block, inclusive: false }).range(from, to));
  };
  const styleLine = (position: number, className: string, attributes?: Record<string, string>) => {
    ranges.push(Decoration.line({ attributes: { ...attributes, class: className } }).range(doc.lineAt(position).from));
  };
  const skipSpace = (pos: number) => pos + (doc.sliceString(pos, pos + 1) === ' ' ? 1 : 0);

  syntaxTree(state).iterate({
    enter({ name, from, to, node }) {
      const active = touches(from, to);
      const header = heading.exec(name);
      if (header) {
        const line = doc.lineAt(from);
        styleLine(from, `prism-md-heading prism-md-h${header[1]}`, { role: 'heading', 'aria-level': header[1] });
        if (!active) {
          for (const marker of node.getChildren('HeaderMark')) {
            if (marker.to <= line.to) {
              hide(marker.from === from ? marker.from : marker.from - 1, skipSpace(marker.to));
            } else {
              ranges.push(Decoration.replace({ block: true }).range(doc.lineAt(marker.from).from, marker.to));
            }
          }
        }
        return;
      }

      if (Object.hasOwn(inlineStyles, name)) {
        const [tag, css, markerName] = inlineStyles[name as keyof typeof inlineStyles];
        mark(from, to, css, tag);
        if (!active) for (const marker of node.getChildren(markerName)) hide(marker.from, marker.to);
        return;
      }

      switch (name) {
        case 'DisplayMath':
        case 'InlineMath': {
          if (active) return false;
          const display = name === 'DisplayMath';
          const latex = readLiveMath(doc.sliceString(from, to), display);
          if (latex) {
            const block = display && doc.lineAt(from).to < to;
            replace(from, to, new PreviewWidget(display ? 'display' : 'math', latex), block);
          }
          return false;
        }
        case 'QuoteMark':
          styleLine(from, 'prism-md-quote');
          if (!touches(doc.lineAt(from).from, doc.lineAt(from).to)) hide(from, skipSpace(to));
          break;
        case 'ListMark': {
          const line = doc.lineAt(from);
          const listMarker = doc.sliceString(from, to);
          styleLine(from, 'prism-md-list');
          if (!touches(line.from, line.to) && /^[*+-]$/.test(listMarker)) {
            if (node.nextSibling?.name === 'Task') hide(from, skipSpace(to));
            else replace(from, to, new PreviewWidget('bullet', '•'));
          }
          break;
        }
        case 'TaskMarker':
          if (!touches(doc.lineAt(from).from, doc.lineAt(from).to)) {
            replace(from, to, new PreviewWidget('task', doc.sliceString(from, to) === '[ ]' ? '☐' : '☑'));
          }
          break;
        case 'HorizontalRule':
          if (!active) replace(from, to, new PreviewWidget('rule', ''), true);
          break;
        case 'FencedCode':
        case 'CodeBlock': {
          const markers = node.getChildren('CodeMark');
          const fenced = name === 'FencedCode';
          const closed = markers.length > 1;
          const first = doc.lineAt(from).number;
          const last = doc.lineAt(to).number;
          for (let line = first; line <= last; line++) {
            const current = doc.line(line);
            styleLine(current.from, 'prism-md-code-line');
            if (fenced && closed && !active && (line === first || line === last)) hide(current.from, current.to);
          }
          return false;
        }
        case 'Link':
        case 'Image': {
          if (active) return;
          const citation = name === 'Link' && /^\[@([a-z0-9_./:+-]{1,180})\]$/i.exec(doc.sliceString(from, to));
          if (citation && citations && Object.hasOwn(citations, citation[1])) {
            replace(from, to, new PreviewWidget('citation', `(${citations[citation[1]]})`));
            return false;
          }
          const markers = node.getChildren('LinkMark');
          if (markers.length < 4 || doc.sliceString(markers[2].from, markers[2].to) !== '(') return;
          const labelFrom = markers[0].to;
          const labelTo = markers[1].from;
          if (labelFrom === labelTo || doc.lineAt(from).number !== doc.lineAt(to).number) return;
          if (name === 'Image') {
            const url = node.getChild('URL');
            const src = url && doc.sliceString(url.from, url.to).replace(/^<(.*)>$/, '$1');
            replace(from, to, new PreviewWidget('image', doc.sliceString(labelFrom, labelTo),
              src && isKnowledgeImageSource(src) ? src : undefined));
            return false;
          }
          mark(labelFrom, labelTo, 'prism-md-link');
          hide(from, labelFrom);
          hide(labelTo, to);
          break;
        }
        case 'Escape':
          if (!active) hide(from, from + 1);
          break;
      }
    },
  });
  return Decoration.set(ranges, true);
}

type PreviewOptions = { source: boolean; citations?: Record<string, string> };

export const liveMarkdownOptions = Facet.define<PreviewOptions, PreviewOptions>({
  combine: (values) => values[0] ?? { source: false },
});

const preview = StateField.define({
  create(state) {
    return { focused: false, ranges: previewRanges(state, false) };
  },
  update(current, transaction) {
    let { focused } = current;
    for (const effect of transaction.effects) if (effect.is(focusChanged)) focused = effect.value;
    const before = transaction.startState;
    const after = transaction.state;
    if (
      focused === current.focused &&
      before.facet(liveMarkdownOptions) === after.facet(liveMarkdownOptions) &&
      !transaction.docChanged &&
      (!focused || before.selection.eq(after.selection)) &&
      syntaxTree(before) === syntaxTree(after)
    ) return current;
    return { focused, ranges: previewRanges(after, focused) };
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.ranges),
});

function previewRanges(state: EditorState, focused: boolean) {
  const { source, citations } = state.facet(liveMarkdownOptions);
  return source ? Decoration.none : decorations(state, focused, citations);
}

export const liveMarkdownPreview = [
  preview,
  EditorView.focusChangeEffect.of((_state, focusing) => focusChanged.of(focusing)),
];
