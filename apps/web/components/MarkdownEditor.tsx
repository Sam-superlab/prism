'use client';

import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown, markdownKeymap } from '@codemirror/lang-markdown';
import { Annotation, Compartment, EditorState, Transaction } from '@codemirror/state';
import { EditorView, keymap, placeholder as editorPlaceholder } from '@codemirror/view';
import { useId, useImperativeHandle, useLayoutEffect, useRef, useState, type Ref } from 'react';
import { liveMarkdownMath } from '../lib/live-markdown-math';
import { liveMarkdownOptions, liveMarkdownPreview } from '../lib/live-markdown-preview';
import styles from './MarkdownEditor.module.css';

const externalValue = Annotation.define<boolean>();

export type MarkdownEditorHandle = { insert: (text: string) => void };

export function MarkdownEditor({
  label,
  hint,
  value,
  onChange,
  rows = 4,
  required,
  disabled,
  maxLength,
  placeholder,
  previewLabel,
  citations,
  ref,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (value: string) => void;
  rows?: number;
  required?: boolean;
  disabled?: boolean;
  maxLength?: number;
  placeholder?: string;
  previewLabel?: string;
  citations?: Record<string, string>;
  ref?: Ref<MarkdownEditorHandle>;
}) {
  const id = useId();
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorView | null>(null);
  const visited = useRef(false);
  const [config] = useState(() => ({ preview: new Compartment(), field: new Compartment() }));
  const [source, setSource] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const props = useRef({ value, onChange, maxLength });
  const contentConfig = useRef({
    disabled, hint, invalid, placeholder, required, source, citations,
  });

  useLayoutEffect(() => {
    props.current = { value, onChange, maxLength };
    contentConfig.current = { disabled, hint, invalid, placeholder, required, source, citations };
  });

  function fieldExtensions(options: typeof contentConfig.current) {
    return [
      EditorState.readOnly.of(!!options.disabled),
      EditorView.editable.of(!options.disabled),
      EditorView.contentAttributes.of({
        id,
        'aria-labelledby': `${id}-label`,
        ...(options.hint || options.invalid ? {
          'aria-describedby': [options.hint && `${id}-hint`, options.invalid && `${id}-error`].filter(Boolean).join(' '),
        } : {}),
        'aria-required': String(!!options.required),
        'aria-invalid': String(options.invalid),
        'aria-disabled': String(!!options.disabled),
        spellcheck: String(!options.source),
      }),
      options.placeholder ? editorPlaceholder(options.placeholder) : [],
    ];
  }

  useLayoutEffect(() => {
    const options = contentConfig.current;
    const view = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: props.current.value,
        extensions: [
          markdown({ extensions: liveMarkdownMath, addKeymap: false }),
          history(),
          keymap.of([...markdownKeymap, ...defaultKeymap, ...historyKeymap]),
          EditorView.lineWrapping,
          config.field.of(fieldExtensions(options)),
          liveMarkdownPreview,
          config.preview.of(liveMarkdownOptions.of({ source: options.source, citations: options.citations })),
          EditorState.transactionFilter.of((transaction) => {
            const limit = props.current.maxLength;
            if (
              limit !== undefined &&
              transaction.docChanged &&
              !transaction.annotation(externalValue) &&
              transaction.newDoc.length > Math.max(limit, transaction.startState.doc.length)
            ) return [];
            return transaction;
          }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged && update.transactions.some((transaction) => !transaction.annotation(externalValue))) {
              setInvalid(false);
              props.current.onChange(update.state.doc.toString());
            }
          }),
        ],
      }),
    });
    editor.current = view;
    return () => {
      editor.current = null;
      view.destroy();
    };
  }, [config, id]);

  useLayoutEffect(() => {
    editor.current?.dispatch({ effects: config.field.reconfigure(fieldExtensions(contentConfig.current)) });
  }, [config, disabled, hint, invalid, placeholder, required, source]);

  useLayoutEffect(() => {
    editor.current?.dispatch({ effects: config.preview.reconfigure(liveMarkdownOptions.of({ source, citations })) });
  }, [config, source, citations]);

  useLayoutEffect(() => {
    const view = editor.current;
    if (!view || view.state.doc.toString() === value) return;
    // Let the editor map its selection through external changes, including corrected import text.
    const previous = view.state.doc.toString();
    let from = 0;
    let suffix = 0;
    while (from < Math.min(previous.length, value.length) && previous[from] === value[from]) from++;
    while (
      suffix < Math.min(previous.length, value.length) - from &&
      previous[previous.length - suffix - 1] === value[value.length - suffix - 1]
    ) suffix++;
    view.dispatch({
      changes: { from, to: previous.length - suffix, insert: value.slice(from, value.length - suffix) },
      annotations: [externalValue.of(true), Transaction.addToHistory.of(false)],
    });
  }, [value]);

  useImperativeHandle(ref, () => ({
    insert(text) {
      const view = editor.current;
      if (!view || view.state.readOnly) return;
      // Before the first edit, citation insertion appends to the existing text.
      if (!visited.current) view.dispatch({ selection: { anchor: view.state.doc.length } });
      view.dispatch({ ...view.state.replaceSelection(text), userEvent: 'input' });
      view.focus();
    },
  }), []);

  return (
    <div className={styles.field}>
      <div className={styles.heading}>
        <label id={`${id}-label`} htmlFor={id} onClick={() => editor.current?.focus()}>{label}</label>
        <button
          type="button"
          className="button small"
          aria-pressed={source}
          aria-label={`Markdown source for ${label}`}
          disabled={disabled}
          onClick={() => {
            setSource(!source);
            editor.current?.focus();
          }}
        >
          Source
        </button>
      </div>
      <section className={styles.canvas} aria-label={previewLabel ?? `${label} editor`}>
        <div
          ref={host}
          className={source ? styles.source : styles.live}
          style={{ minHeight: `${rows * 1.55 + 1.5}em` }}
          onFocus={() => { visited.current = true; }}
        />
        {required && (
          <textarea
            className={styles.constraint}
            aria-hidden="true"
            tabIndex={-1}
            required
            disabled={disabled}
            value={value}
            onChange={() => {}}
            onInvalid={(event) => {
              event.preventDefault();
              setInvalid(true);
              editor.current?.focus();
            }}
          />
        )}
      </section>
      {invalid && <small id={`${id}-error`} role="alert">Enter {label.toLowerCase()} before continuing.</small>}
      {hint && <small id={`${id}-hint`} className="muted">{hint}</small>}
    </div>
  );
}
