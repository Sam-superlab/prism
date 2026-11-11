'use client';
import { useEffect, useState } from 'react';
import {
  APPEARANCE_KEY,
  DEFAULT_APPEARANCE,
  applyAppearance,
  normalizeAppearance,
  type Appearance,
} from '../lib/appearance';
import { Icon } from './ui';

export function AppearancePanel() {
  const [value, setValue] = useState<Appearance>(DEFAULT_APPEARANCE);
  const [storageAvailable, setStorageAvailable] = useState(true);
  useEffect(() => {
    try {
      const p = normalizeAppearance(JSON.parse(localStorage.getItem(APPEARANCE_KEY) || '{}'));
      setValue(p);
      applyAppearance(p);
    } catch {
      setStorageAvailable(false);
    }
    const changed = (event: StorageEvent) => {
      if (event.key !== APPEARANCE_KEY) return;
      try {
        const p = normalizeAppearance(JSON.parse(event.newValue || '{}'));
        setValue(p);
        applyAppearance(p);
      } catch {}
    };
    window.addEventListener('storage', changed);
    return () => window.removeEventListener('storage', changed);
  }, []);
  function update(patch: Partial<Appearance>) {
    const next = normalizeAppearance({ ...value, ...patch });
    setValue(next);
    applyAppearance(next);
    try {
      localStorage.setItem(APPEARANCE_KEY, JSON.stringify(next));
      setStorageAvailable(true);
    } catch {
      setStorageAvailable(false);
    }
  }
  return (
    <section className="panel content-panel appearance-panel" aria-labelledby="appearance-heading">
      <div className="panel-heading">
        <div>
          <h2 id="appearance-heading">Appearance</h2>
        </div>
        <Icon name="settings" />
      </div>
      <fieldset className="appearance-theme">
        <legend>Theme</legend>
        <div className="theme-options">
          {(['light', 'dark', 'system'] as const).map((theme) => (
            <button
              type="button"
              key={theme}
              className={`theme-option ${value.theme === theme ? 'selected' : ''}`}
              aria-pressed={value.theme === theme}
              onClick={() => update({ theme })}
            >
              <span className={`theme-preview ${theme}`} aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
              <span>{theme === 'system' ? 'Automatic' : theme === 'light' ? 'Light' : 'Dark'}</span>
              {value.theme === theme && <Icon name="check" size={14} />}
            </button>
          ))}
        </div>
      </fieldset>
      <div className="appearance-row">
        <div>
          <label htmlFor="appearance-text-size">Text size</label>
          <p>Scale interface text without changing your content.</p>
        </div>
        <output htmlFor="appearance-text-size">{value.textSize} px</output>
      </div>
      <div className="appearance-range">
        <span aria-hidden="true">A</span>
        <input
          id="appearance-text-size"
          type="range"
          min="13"
          max="20"
          step="1"
          value={value.textSize}
          onChange={(e) => update({ textSize: Number(e.target.value) })}
        />
        <span aria-hidden="true">A</span>
      </div>
      <div className="appearance-row">
        <div>
          <label htmlFor="appearance-reading-font">Reading typeface</label>
          <p>For notes and explanations. Math keeps its own typography.</p>
        </div>
        <select
          id="appearance-reading-font"
          value={value.readingFont}
          onChange={(e) => update({ readingFont: e.target.value as Appearance['readingFont'] })}
        >
          <option value="system">System</option>
          <option value="serif">Serif</option>
        </select>
      </div>
      <div className="appearance-row">
        <div>
          <label htmlFor="appearance-density">Layout density</label>
          <p>Choose how much breathing room you prefer.</p>
        </div>
        <select
          id="appearance-density"
          value={value.density}
          onChange={(e) => update({ density: e.target.value as Appearance['density'] })}
        >
          <option value="comfortable">Comfortable</option>
          <option value="compact">Compact</option>
        </select>
      </div>
      <div className="appearance-row">
        <div>
          <span className="appearance-label">Accent color</span>
          <p>A subtle highlight throughout your workspace.</p>
        </div>
        <div className="accent-options" role="group" aria-label="Accent color">
          {(['blue', 'indigo', 'teal'] as const).map((accent) => (
            <button
              type="button"
              key={accent}
              className={`accent-swatch ${accent}`}
              aria-label={accent[0].toUpperCase() + accent.slice(1)}
              aria-pressed={value.accent === accent}
              onClick={() => update({ accent })}
            >
              {value.accent === accent && <Icon name="check" size={14} />}
            </button>
          ))}
        </div>
      </div>
      <div className="appearance-row">
        <div>
          <label htmlFor="appearance-contrast">Contrast</label>
          <p>Make borders and secondary labels more distinct.</p>
        </div>
        <select
          id="appearance-contrast"
          value={value.contrast}
          onChange={(e) => update({ contrast: e.target.value as Appearance['contrast'] })}
        >
          <option value="standard">Standard</option>
          <option value="increased">Increased</option>
        </select>
      </div>
      <label className="appearance-row switch-row">
        <span>
          <span className="appearance-label">Reduce motion</span>
          <small>Your system accessibility preference is always respected.</small>
        </span>
        <input
          type="checkbox"
          role="switch"
          checked={value.reducedMotion}
          onChange={(e) => update({ reducedMotion: e.target.checked })}
        />
      </label>
      <label className="appearance-row switch-row">
        <span>
          <span className="appearance-label">Translucent surfaces</span>
          <small>Frosted sidebar and toolbar. Increased contrast uses solid surfaces.</small>
        </span>
        <input
          type="checkbox"
          role="switch"
          checked={value.transparency}
          onChange={(e) => update({ transparency: e.target.checked })}
        />
      </label>
      <div className="appearance-footer">
        <span role="status">
          {storageAvailable
            ? 'Saved automatically on this device.'
            : 'Changes apply for this session. Device storage is unavailable.'}
        </span>
        <button type="button" className="text-link" onClick={() => update(DEFAULT_APPEARANCE)}>
          Reset appearance
        </button>
      </div>
    </section>
  );
}
