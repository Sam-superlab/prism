'use client';

import {
  literatureReaderFonts, literatureReaderFontSizes, literatureReaderLineHeights, literatureReaderThemes,
  type LiteratureReaderPreferences,
} from '../lib/literature-reader-preferences';
import styles from './LiteraturePdfReader.module.css';

const fontNames = { serif: 'Serif', 'sans-serif': 'Sans serif' } as const;
const spacingNames = { '1.4': 'Compact', '1.65': 'Standard', '2': 'Wide' } as const;
const themeNames = { workspace: 'Workspace', light: 'Light', dark: 'Dark', sepia: 'Sepia' } as const;

export function LiteratureReaderAppearance({ preferences, update }: {
  preferences: Readonly<LiteratureReaderPreferences>;
  update: (changes: Partial<LiteratureReaderPreferences>) => void;
}) {
  return <div className={styles.toolbar} aria-label="Reading appearance">
    <label>Font <select value={preferences.font} onChange={(event) => update({ font: event.target.value as LiteratureReaderPreferences['font'] })}>
      {literatureReaderFonts.map((value) => <option value={value} key={value}>{fontNames[value]}</option>)}
    </select></label>
    <label>Font size <select value={preferences.fontSize} onChange={(event) => update({ fontSize: Number(event.target.value) as LiteratureReaderPreferences['fontSize'] })}>
      {literatureReaderFontSizes.map((value) => <option value={value} key={value}>{value} px</option>)}
    </select></label>
    <label>Line spacing <select value={preferences.lineHeight} onChange={(event) => update({ lineHeight: event.target.value as LiteratureReaderPreferences['lineHeight'] })}>
      {literatureReaderLineHeights.map((value) => <option value={value} key={value}>{spacingNames[value]}</option>)}
    </select></label>
    <label>Reading theme <select value={preferences.theme} onChange={(event) => update({ theme: event.target.value as LiteratureReaderPreferences['theme'] })}>
      {literatureReaderThemes.map((value) => <option value={value} key={value}>{themeNames[value]}</option>)}
    </select></label>
  </div>;
}
