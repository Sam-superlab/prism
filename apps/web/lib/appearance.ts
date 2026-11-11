export type Appearance = {
  theme: 'system' | 'light' | 'dark';
  textSize: number;
  density: 'comfortable' | 'compact';
  accent: 'blue' | 'indigo' | 'teal';
  readingFont: 'system' | 'serif';
  reducedMotion: boolean;
  transparency: boolean;
  contrast: 'standard' | 'increased';
};
export const APPEARANCE_KEY = 'prism.appearance.v1';
export const DEFAULT_APPEARANCE: Appearance = {
  theme: 'system',
  textSize: 15,
  density: 'comfortable',
  accent: 'blue',
  readingFont: 'system',
  reducedMotion: false,
  transparency: true,
  contrast: 'standard',
};
export function normalizeAppearance(value: unknown): Appearance {
  const v = value && typeof value === 'object' ? (value as Partial<Appearance>) : {};
  return {
    theme: ['system', 'light', 'dark'].includes(v.theme ?? '') ? v.theme! : 'system',
    textSize:
      typeof v.textSize === 'number' && Number.isFinite(v.textSize)
        ? Math.min(20, Math.max(13, Math.round(v.textSize)))
        : 15,
    density: v.density === 'compact' ? 'compact' : 'comfortable',
    accent: ['blue', 'indigo', 'teal'].includes(v.accent ?? '') ? v.accent! : 'blue',
    readingFont: v.readingFont === 'serif' ? 'serif' : 'system',
    reducedMotion: v.reducedMotion === true,
    transparency: v.transparency !== false,
    contrast: v.contrast === 'increased' ? 'increased' : 'standard',
  };
}
export function applyAppearance(p: Appearance) {
  const root = document.documentElement;
  root.dataset.theme = p.theme;
  root.dataset.density = p.density;
  root.dataset.accent = p.accent;
  root.dataset.readingFont = p.readingFont;
  root.dataset.reducedMotion = String(p.reducedMotion);
  root.dataset.transparency = String(p.transparency);
  root.dataset.contrast = p.contrast;
  root.style.setProperty('--text-scale', String(p.textSize / 15));
}
// All values are normalized before reaching CSS; the script runs before the first paint.
export const APPEARANCE_BOOTSTRAP = `(function(){try{var v=JSON.parse(localStorage.getItem('${APPEARANCE_KEY}')||'{}')||{};var r=document.documentElement;var e=function(x,a,d){return a.indexOf(x)>=0?x:d};r.dataset.theme=e(v.theme,['system','light','dark'],'system');r.dataset.density=e(v.density,['comfortable','compact'],'comfortable');r.dataset.accent=e(v.accent,['blue','indigo','teal'],'blue');r.dataset.readingFont=e(v.readingFont,['system','serif'],'system');r.dataset.reducedMotion=String(v.reducedMotion===true);r.dataset.transparency=String(v.transparency!==false);r.dataset.contrast=e(v.contrast,['standard','increased'],'standard');var n=typeof v.textSize==='number'&&isFinite(v.textSize)?Math.max(13,Math.min(20,Math.round(v.textSize))):15;r.style.setProperty('--text-scale',String(n/15));}catch(e){}})();`;
