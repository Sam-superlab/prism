export const workspaceShortcuts = [
  { action: 'settings', label: 'Open Settings', key: ',', modifier: 'primary' },
  { action: 'search', label: 'Search workspace', key: 'k', modifier: 'primary' },
  { action: 'capture', label: 'Quick capture', key: 'n', modifier: 'primary-shift' },
  { action: 'sidebar', label: 'Toggle sidebar', key: 'l', modifier: 'primary-shift' },
  { action: 'escape', label: 'Close the current dialog or menu', key: 'escape', modifier: 'none' },
] as const;

type WorkspaceShortcut = (typeof workspaceShortcuts)[number];
export type WorkspaceShortcutAction = WorkspaceShortcut['action'];
export type ShortcutPlatform = 'apple' | 'other';

export function workspaceShortcutFor(event: KeyboardEvent): WorkspaceShortcutAction | undefined {
  if (event.defaultPrevented || event.altKey || event.isComposing || event.repeat) return;
  const shortcut = workspaceShortcuts.find(({ key }) => key === event.key.toLowerCase());
  if (!shortcut) return;
  if (shortcut.modifier === 'none') {
    if (!event.ctrlKey && !event.metaKey && !event.shiftKey) return shortcut.action;
    return;
  }
  if (event.ctrlKey === event.metaKey || event.shiftKey !== (shortcut.modifier === 'primary-shift')) return;
  return shortcut.action;
}

export function shortcutPlatform(userAgent: string): ShortcutPlatform {
  return /Macintosh|iPhone|iPad|iPod/.test(userAgent) ? 'apple' : 'other';
}

export function shortcutKeys(shortcut: WorkspaceShortcut, platform: ShortcutPlatform): string[] {
  if (shortcut.modifier === 'none') return ['Esc'];
  const keys = [platform === 'apple' ? '⌘' : 'Ctrl'];
  if (shortcut.modifier === 'primary-shift') keys.push(platform === 'apple' ? '⇧' : 'Shift');
  return [...keys, shortcut.key.toUpperCase()];
}
