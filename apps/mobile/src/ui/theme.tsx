import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AccessibilityInfo, StyleSheet, useColorScheme } from 'react-native';
import { usePrism } from '../state';
import {
  APPEARANCE_KEY,
  defaultAppearance,
  parseAppearance,
  type AppearancePreferences,
} from '../services/appearance';

const light = {
  ink: '#1C1C1E',
  muted: '#63666F',
  canvas: '#F2F2F7',
  paper: '#FFFFFF',
  line: '#D9DCE3',
  purple: '#007AFF',
  pale: '#E5F0FF',
  quiet: '#E8EBF1',
  action: '#0066D6',
  onAccent: '#FFFFFF',
  teal: '#248A3D',
  orange: '#A76600',
  red: '#C9342E',
  warning: '#FFF3DB',
  error: '#FFF0EF',
};
const dark: typeof light = {
  ink: '#F2F2F7',
  muted: '#AEAEB8',
  canvas: '#000000',
  paper: '#1C1C1E',
  line: '#38383D',
  purple: '#0A84FF',
  pale: '#102C4A',
  quiet: '#2C2C2E',
  action: '#0A84FF',
  onAccent: '#000000',
  teal: '#30D158',
  orange: '#FFB340',
  red: '#FF6961',
  warning: '#372B15',
  error: '#361D20',
};
export type Palette = typeof light;
function createStyles(colors: Palette, font: (n: number) => number) {
  return StyleSheet.create({
    screen: { padding: 20, paddingBottom: 40, gap: 15 },
    heading: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 6 },
    kicker: {
      fontSize: font(10),
      letterSpacing: 1.5,
      color: colors.muted,
      fontWeight: '600',
      marginBottom: 10,
    },
    h1: { fontSize: font(32), fontWeight: '700', color: colors.ink, letterSpacing: -1 },
    subtitle: { fontSize: font(14), color: colors.muted, marginTop: 8, lineHeight: font(22) },
    card: {
      borderRadius: 20,
      borderWidth: 1,
      borderColor: colors.line,
      backgroundColor: colors.paper,
      padding: 18,
      gap: 10,
    },
    cardTitle: { fontSize: font(17), lineHeight: font(23), fontWeight: '600', color: colors.ink },
    body: { fontSize: font(15), lineHeight: font(24), color: colors.muted },
    sectionTitle: {
      fontSize: font(14),
      fontWeight: '600',
      color: colors.muted,
      letterSpacing: 0.5,
      marginBottom: 3,
    },
    row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
    button: {
      minHeight: 47,
      borderRadius: 12,
      backgroundColor: colors.action,
      justifyContent: 'center',
      alignItems: 'center',
      paddingHorizontal: 17,
      paddingVertical: 12,
    },
    smallButton: { minHeight: 44, paddingHorizontal: 13, paddingVertical: 9 },
    quietButton: { backgroundColor: colors.quiet },
    dangerButton: { backgroundColor: colors.red },
    buttonText: { color: colors.onAccent, fontSize: font(15), fontWeight: '600' },
    chip: { alignSelf: 'flex-start', borderRadius: 7, paddingHorizontal: 8, paddingVertical: 5 },
    chipText: { fontSize: font(12), fontWeight: '600' },
    empty: { padding: 30, alignItems: 'center', gap: 10 },
    emptyMark: { fontSize: font(42), color: colors.purple },
    input: {
      backgroundColor: colors.paper,
      borderWidth: 1,
      borderColor: colors.line,
      padding: 13,
      minHeight: 47,
      borderRadius: 11,
      color: colors.ink,
      fontSize: font(16),
      lineHeight: font(22),
    },
    label: { color: colors.ink, fontSize: font(14), fontWeight: '600', marginTop: 5 },
    help: { fontSize: font(13), color: colors.muted, lineHeight: font(21) },
    option: {
      paddingHorizontal: 13,
      paddingVertical: 10,
      minHeight: 44,
      borderRadius: 10,
      backgroundColor: colors.quiet,
      justifyContent: 'center',
    },
    selectedOption: { backgroundColor: colors.pale, borderColor: colors.purple, borderWidth: 1 },
    selectedText: { color: colors.ink, fontSize: font(15), fontWeight: '600' },
    sheetHeader: {
      paddingHorizontal: 20,
      paddingVertical: 12,
      borderBottomWidth: 1,
      borderColor: colors.line,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
    },
  });
}
type AppearanceState = {
  preferences: AppearancePreferences;
  update: (patch: Partial<AppearancePreferences>) => Promise<void>;
  colors: Palette;
  styles: ReturnType<typeof createStyles>;
  isDark: boolean;
  reduceMotion: boolean;
  font: (size: number) => number;
};
const AppearanceContext = createContext<AppearanceState | null>(null);
export function AppearanceProvider({ children }: { children: React.ReactNode }) {
  const p = usePrism();
  const systemTheme = useColorScheme();
  const [preferences, setPreferences] = useState(defaultAppearance);
  const [systemReducedMotion, setSystemReducedMotion] = useState(false);
  const latest = useRef(defaultAppearance);
  const generation = useRef(0);
  const writes = useRef<Promise<unknown>>(Promise.resolve());
  const store = p.runtime?.store;
  useEffect(() => {
    let live = true;
    const version = ++generation.current;
    void store
      ?.meta(APPEARANCE_KEY)
      .then((raw) => {
        if (live && version === generation.current) {
          const next = parseAppearance(raw);
          latest.current = next;
          setPreferences(next);
        }
      })
      .catch(p.report);
    return () => {
      live = false;
    };
  }, [store, p.report]);
  useEffect(() => {
    let live = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((value) => {
      if (live) setSystemReducedMotion(value);
    });
    const listener = AccessibilityInfo.addEventListener('reduceMotionChanged', setSystemReducedMotion);
    return () => {
      live = false;
      listener.remove();
    };
  }, []);
  const update = useCallback(
    async (patch: Partial<AppearancePreferences>) => {
      const next = parseAppearance(JSON.stringify({ ...latest.current, ...patch }));
      if (!store) throw new Error('Local preferences are not ready yet.');
      const version = ++generation.current;
      latest.current = next;
      const write = writes.current
        .catch(() => undefined)
        .then(() => store.setMeta(APPEARANCE_KEY, JSON.stringify(next)));
      writes.current = write;
      await write;
      if (version === generation.current) setPreferences(next);
    },
    [store],
  );
  const isDark = preferences.theme === 'dark' || (preferences.theme === 'system' && systemTheme === 'dark');
  const value = useMemo(() => {
    const colors = isDark ? dark : light;
    const font = (size: number) => Math.round(size * preferences.textScale * 10) / 10;
    return {
      preferences,
      update,
      colors,
      styles: createStyles(colors, font),
      isDark,
      reduceMotion: preferences.reduceMotion || systemReducedMotion,
      font,
    };
  }, [preferences, update, isDark, systemReducedMotion]);
  return <AppearanceContext.Provider value={value}>{children}</AppearanceContext.Provider>;
}
export function useAppearance() {
  const appearance = useContext(AppearanceContext);
  if (!appearance) throw new Error('Missing appearance provider');
  return appearance;
}
