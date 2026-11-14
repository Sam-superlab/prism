'use client';

import { useEffect, useState } from 'react';
import {
  bibliographyCaptureLimit,
  parseBibliographyCaptureTransfer,
  type BibliographyCapture,
} from '../lib/bibliography-capture';
import { Field, Modal, Notice } from './ui';

export function BrowserCaptureImport({
  onClose,
  onCapture,
}: {
  onClose: () => void;
  onCapture: (capture: BibliographyCapture) => void;
}) {
  const [source, setSource] = useState('');
  const [error, setError] = useState('');
  const [reading, setReading] = useState(false);
  const [canReadClipboard, setCanReadClipboard] = useState(false);
  const [canConnect, setCanConnect] = useState(false);
  const [saveCode, setSaveCode] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [connectionNotice, setConnectionNotice] = useState('');
  useEffect(() => {
    setCanReadClipboard(typeof navigator.clipboard?.readText === 'function');
    if (location.hostname !== '127.0.0.1') return;
    const controller = new AbortController();
    void fetch('/api/browser-capture', { cache: 'no-store', signal: controller.signal })
      .then((response) => { if (!controller.signal.aborted) setCanConnect(response.status === 204); })
      .catch(() => {});
    return () => controller.abort();
  }, []);

  async function changeConnection(method: 'POST' | 'DELETE') {
    if (connecting) return;
    setConnecting(true);
    setConnectionNotice('');
    try {
      const response = await fetch('/api/browser-capture', { method, cache: 'no-store', headers: { 'X-PRISM-Browser-Capture': 'desktop' } });
      if (method === 'DELETE' && response.status === 204) {
        setSaveCode('');
        setConnectionNotice('Save code revoked.');
        return;
      }
      if (method !== 'POST' || response.status !== 201) throw new Error('Could not change the browser save code.');
      const { code } = await response.json() as { code: string };
      setSaveCode(code);
    } catch {
      setConnectionNotice('Could not change the browser save code. Try again.');
    } finally { setConnecting(false); }
  }

  function review(value: string) {
    setError('');
    try {
      onCapture(parseBibliographyCaptureTransfer(value));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not read the copied reference.');
    }
  }

  async function reviewClipboard() {
    if (reading) return;
    setReading(true);
    setError('');
    try {
      const value = await navigator.clipboard.readText();
      review(value);
    } catch {
      setError('Clipboard access is unavailable. Paste the copied reference into the field.');
    } finally {
      setReading(false);
    }
  }
  return (
    <Modal title="Capture from browser" onClose={() => { if (!reading && !connecting) onClose(); }}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!reading) review(source);
        }}
      >
        <p>Open PRISM Browser Capture on the source page. Copy the reference, or include page text to save a readable snapshot.</p>
        <Field label="Copied reference">
          <textarea
            rows={6}
            required
            value={source}
            maxLength={bibliographyCaptureLimit}
            onChange={(event) => {
              setSource(event.target.value);
              setError('');
            }}
          />
        </Field>
        {error && <Notice tone="error">{error}</Notice>}
        <div className="modal-footer">
          {canReadClipboard && <button type="button" className="button small"
            disabled={reading} onClick={() => void reviewClipboard()}>{reading ? 'Reading clipboard…' : 'Review from clipboard'}</button>}
          <button type="button" className="button" disabled={reading || connecting} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button primary" disabled={reading || !source.trim()}>
            Review reference
          </button>
        </div>
      </form>
      {canConnect && <details>
        <summary>Save directly from the extension</summary>
        <p>Generate a code, then paste it into PRISM Browser Capture on the source page. It can save one reference to this desktop workspace for 10 minutes.</p>
        <div className="inline-actions">
          <button type="button" className="button" disabled={connecting} onClick={() => void changeConnection('POST')}>{saveCode ? 'Replace save code' : 'Generate save code'}</button>
          <button type="button" className="button" disabled={connecting} onClick={() => void changeConnection('DELETE')}>Revoke save code</button>
        </div>
        {saveCode && <Field label="One-time save code">
          <input readOnly type="text" value={saveCode} onFocus={(event) => event.currentTarget.select()} />
        </Field>}
        {saveCode && typeof navigator.clipboard?.writeText === 'function' && <button type="button" className="button" onClick={() => void navigator.clipboard.writeText(saveCode)
          .then(() => setConnectionNotice('Save code copied.')).catch(() => setConnectionNotice('Select and copy the code above.'))}>Copy save code</button>}
        {connectionNotice && <p role="status">{connectionNotice}</p>}
      </details>}
    </Modal>
  );
}
