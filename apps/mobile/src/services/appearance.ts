export type AppearancePreferences = {
  theme: 'system' | 'light' | 'dark';
  textScale: number;
  reduceMotion: boolean;
};
export const APPEARANCE_KEY = 'appearance:v1';
export const defaultAppearance: AppearancePreferences = {
  theme: 'system',
  textScale: 1,
  reduceMotion: false,
};
export function parseAppearance(raw: string | null | undefined): AppearancePreferences {
  try {
    const value = JSON.parse(raw ?? '{}');
    return {
      theme: ['system', 'light', 'dark'].includes(value.theme) ? value.theme : 'system',
      textScale:
        typeof value.textScale === 'number' && Number.isFinite(value.textScale)
          ? Math.min(1.3, Math.max(0.9, value.textScale))
          : 1,
      reduceMotion: value.reduceMotion === true,
    };
  } catch {
    return { ...defaultAppearance };
  }
}
