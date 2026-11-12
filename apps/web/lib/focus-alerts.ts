import type { FocusPhase, FocusSession } from './focus-timer';

export type FocusOptions = { sound: boolean; pet: boolean };
export const defaultFocusOptions: FocusOptions = { sound: true, pet: false };

export type DesktopFocusState = FocusOptions & {
  endsAt: number | null;
  phase: FocusPhase;
  mood: FocusSession['clock']['status'];
  reducedMotion: boolean;
};

type FocusWindow = Window & {
  prismFocus?: { setState: (state: DesktopFocusState) => void };
  webkit?: { messageHandlers?: { prismFocus?: { postMessage: (state: DesktopFocusState) => void } } };
  webkitAudioContext?: typeof AudioContext;
};

export function desktopFocusBridge() {
  const host = window as FocusWindow;
  if (host.prismFocus) return (state: DesktopFocusState) => host.prismFocus?.setState(state);
  const handler = host.webkit?.messageHandlers?.prismFocus;
  if (handler) return (state: DesktopFocusState) => handler.postMessage(state);
}

export function readFocusOptions(key: string): FocusOptions {
  try {
    const saved = JSON.parse(localStorage.getItem(key) ?? '{}');
    return { sound: saved?.sound !== false, pet: saved?.pet === true };
  } catch {
    return defaultFocusOptions;
  }
}

let audio: AudioContext | undefined;

/** Called during an explicit start/resume gesture for browser autoplay policies. */
export function prepareFocusSound() {
  try {
    const Audio = window.AudioContext ?? (window as FocusWindow).webkitAudioContext;
    if (!Audio) return;
    audio ??= new Audio();
    if (audio.state === 'suspended') void audio.resume().catch(() => {});
  } catch {
    // The visible reminder still works without audio.
  }
}

export function playFocusSound() {
  if (!audio || audio.state !== 'running') return;
  for (const [index, frequency] of [660, 880].entries()) {
    const time = audio.currentTime + index * 0.16;
    const oscillator = audio.createOscillator();
    const volume = audio.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.value = frequency;
    volume.gain.setValueAtTime(0.001, time);
    volume.gain.exponentialRampToValueAtTime(0.09, time + 0.03);
    volume.gain.exponentialRampToValueAtTime(0.001, time + 0.36);
    oscillator.connect(volume).connect(audio.destination);
    oscillator.start(time);
    oscillator.stop(time + 0.37);
    oscillator.onended = () => {
      oscillator.disconnect();
      volume.disconnect();
    };
  }
}

export function focusCompletionTitle(phase: FocusPhase) {
  return phase === 'focus' ? 'Focus session complete' : 'Break complete';
}
