'use client';

import { useEffect, useState } from 'react';
import { Field, Notice } from './ui';

const preferenceKey = 'prism.shared-workspace-url.v1';

function sharedWorkspaceUrl(value: string) {
  if (value.length > 1000) return '';
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return '';
    if (url.hostname === 'localhost' || url.hostname.endsWith('.localhost') || url.hostname.startsWith('127.') ||
      url.hostname === '[::1]') return '';
    return url.href;
  } catch {
    return '';
  }
}

export function SharedWorkspaceSettings() {
  const [input, setInput] = useState('');
  const [address, setAddress] = useState('');
  const [message, setMessage] = useState('');
  useEffect(() => {
    try {
      const value = sharedWorkspaceUrl(localStorage.getItem(preferenceKey) ?? '');
      setAddress(value);
      setInput(value);
    } catch {}
  }, []);

  return <section className="panel content-panel" aria-labelledby="shared-workspace">
    <div className="panel-heading"><h2 id="shared-workspace">Shared workspace</h2></div>
    <p className="muted">Open a hosted PRISM workspace in your browser. Sign in to the same workspace on each device to continue reading. Your local library stays on this device.</p>
    <form onSubmit={(event) => {
      event.preventDefault();
      const value = sharedWorkspaceUrl(input.trim());
      if (!value && input.trim()) { setMessage('Enter a valid HTTPS workspace address.'); return; }
      try {
        if (value) localStorage.setItem(preferenceKey, value);
        else localStorage.removeItem(preferenceKey);
        setAddress(value);
        setInput(value);
        setMessage('');
      } catch {
        setMessage('Could not save the workspace address on this device.');
      }
    }}>
      <Field label="Shared workspace address">
        <input type="url" maxLength={1000} placeholder="https://prism.example.com" value={input}
          onChange={(event) => { setInput(event.target.value); setMessage(''); }} />
      </Field>
      {message && <Notice tone="error">{message}</Notice>}
      <div className="inline-actions">
        <button className="button small" type="submit" disabled={input.trim() === address}>Save address</button>
        {address && <a className="button small" href={address} target="_blank" rel="noopener noreferrer">Open shared workspace</a>}
      </div>
    </form>
  </section>;
}
