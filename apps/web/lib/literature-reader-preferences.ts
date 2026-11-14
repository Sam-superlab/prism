'use client';

import { useSyncExternalStore } from 'react';

export const literatureReaderFonts = ['serif', 'sans-serif'] as const;
export const literatureReaderFontSizes = [16, 18, 21, 24, 28] as const;
export const literatureReaderLineHeights = ['1.4', '1.65', '2'] as const;
export const literatureReaderThemes = ['workspace', 'light', 'dark', 'sepia'] as const;

export type LiteratureReaderPreferences = {
  font: (typeof literatureReaderFonts)[number];
  fontSize: (typeof literatureReaderFontSizes)[number];
  lineHeight: (typeof literatureReaderLineHeights)[number];
  theme: (typeof literatureReaderThemes)[number];
};

export const defaultLiteratureReaderPreferences: Readonly<LiteratureReaderPreferences> = Object.freeze({
  font: 'serif',
  fontSize: 18,
  lineHeight: '1.65',
  theme: 'workspace',
});

export const literatureReaderPreferencesKey = 'prism.literature-reader.v1';
const eventName = 'prism:literature-reader-preferences';

export function normalizeLiteratureReaderPreferences(value: unknown): LiteratureReaderPreferences {
  const preferences = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const defaults = defaultLiteratureReaderPreferences;
  const option = <T extends number | string>(choices: readonly T[], candidate: unknown, fallback: T) =>
    choices.find((choice) => choice === candidate) ?? fallback;
  return {
    font: option(literatureReaderFonts, preferences.font, defaults.font),
    fontSize: option(literatureReaderFontSizes, preferences.fontSize, defaults.fontSize),
    lineHeight: option(literatureReaderLineHeights, preferences.lineHeight, defaults.lineHeight),
    theme: option(literatureReaderThemes, preferences.theme, defaults.theme),
  };
}

function parseStoredPreferences(value: string | null): LiteratureReaderPreferences {
  if (!value) return defaultLiteratureReaderPreferences;
  try {
    return normalizeLiteratureReaderPreferences(JSON.parse(value));
  } catch {
    return defaultLiteratureReaderPreferences;
  }
}

let snapshot = { raw: null as string | null, preferences: defaultLiteratureReaderPreferences };
let temporaryPreferences: LiteratureReaderPreferences | undefined;

function getPreferences() {
  if (temporaryPreferences) return temporaryPreferences;
  try {
    const raw = window.localStorage.getItem(literatureReaderPreferencesKey);
    if (raw !== snapshot.raw) snapshot = { raw, preferences: parseStoredPreferences(raw) };
  } catch {
    // Reading remains available with the last known preferences.
  }
  return snapshot.preferences;
}

function subscribe(listener: () => void) {
  function onStorage(event: StorageEvent) {
    if (event.key !== null && event.key !== literatureReaderPreferencesKey) return;
    temporaryPreferences = undefined;
    listener();
  }
  window.addEventListener(eventName, listener);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(eventName, listener);
    window.removeEventListener('storage', onStorage);
  };
}

function getServerPreferences() {
  return defaultLiteratureReaderPreferences;
}

function savePreferences(preferences: LiteratureReaderPreferences) {
  const raw = JSON.stringify(preferences);
  try {
    window.localStorage.setItem(literatureReaderPreferencesKey, raw);
    snapshot = { raw, preferences };
    temporaryPreferences = undefined;
  } catch {
    temporaryPreferences = preferences;
  }
  window.dispatchEvent(new Event(eventName));
}

function updatePreferences(changes: Partial<LiteratureReaderPreferences>) {
  savePreferences(normalizeLiteratureReaderPreferences({ ...getPreferences(), ...changes }));
}

function resetPreferences() {
  savePreferences(defaultLiteratureReaderPreferences);
}

export function useLiteratureReaderPreferences() {
  const preferences = useSyncExternalStore(subscribe, getPreferences, getServerPreferences);
  return { preferences, updatePreferences, resetPreferences };
}
