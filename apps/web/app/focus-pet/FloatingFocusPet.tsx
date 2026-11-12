'use client';

import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { StudyPet } from '../../components/StudyPet';
import type { FocusPhase, FocusSession } from '../../lib/focus-timer';
import styles from './FloatingFocusPet.module.css';

type FocusState = {
  endsAt: number | null;
  phase: FocusPhase;
  mood: FocusSession['clock']['status'];
  reducedMotion: boolean;
};

type PetWindow = {
  prismFocusState?: unknown;
  webkit?: {
    messageHandlers?: {
      prismPet?: {
        postMessage: (message: {
          action: 'ready' | 'hide' | 'open' | 'drag';
          dx?: number;
          dy?: number;
        }) => void;
      };
    };
  };
  prismFocus?: {
    hidePet?: () => void;
    openFocus?: () => void;
    dragPet?: (dx: number, dy: number) => void;
  };
};

const defaultState: FocusState = { endsAt: null, phase: 'focus', mood: 'ready', reducedMotion: false };

const readBridge = () => window as unknown as PetWindow;

function readState(value: unknown): FocusState | undefined {
  if (typeof value !== 'object' || value === null) return;
  const { endsAt, phase, mood, reducedMotion } = value as Partial<FocusState>;
  if (
    (phase !== 'focus' && phase !== 'break') ||
    (mood !== 'ready' && mood !== 'running' && mood !== 'paused' && mood !== 'finished') ||
    typeof reducedMotion !== 'boolean'
  )
    return;
  if (mood === 'running' && (typeof endsAt !== 'number' || !Number.isFinite(endsAt))) return;
  return { endsAt: mood === 'running' ? endsAt! : null, phase, mood, reducedMotion };
}

function readout(state: FocusState, now: number) {
  const phase = state.phase === 'focus' ? 'Focus' : 'Break';
  if (state.mood === 'running' && state.endsAt !== null && now < state.endsAt) {
    const seconds = Math.ceil((state.endsAt - now) / 1000);
    const time = `${Math.floor(seconds / 60)
      .toString()
      .padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;
    return { mood: state.mood, label: `${phase} · ${time}` };
  }
  if (state.mood === 'finished' || state.mood === 'running')
    return { mood: 'finished' as const, label: `${phase} complete` };
  if (state.mood === 'paused') return { mood: state.mood, label: `${phase} paused` };
  return { mood: state.mood, label: state.phase === 'focus' ? 'Ready to focus' : 'Ready for a break' };
}

export function FloatingFocusPet() {
  const [state, setState] = useState(defaultState);
  const [now, setNow] = useState(0);
  const [actions, setActions] = useState({ hide: false, open: false });
  const [menuOpen, setMenuOpen] = useState(false);
  const [motion, setMotion] = useState<'running' | 'settling'>();
  const [direction, setDirection] = useState<'left' | 'right'>('right');
  const menuTrigger = useRef<HTMLElement | null>(null);
  const drag = useRef<
    { id: number; x: number; y: number; clientY: number; verticalSign?: number; moved: boolean } | undefined
  >(undefined);
  const suppressClick = useRef(false);

  useEffect(() => {
    const bridge = readBridge();
    const mac = bridge.webkit?.messageHandlers?.prismPet;
    setActions({
      hide: Boolean(mac || bridge.prismFocus?.hidePet),
      open: Boolean(mac || bridge.prismFocus?.openFocus),
    });

    const apply = (value: unknown) => {
      const next = readState(value);
      if (next) {
        setNow(Date.now());
        setState(next);
      }
    };
    const sync = (event: Event) => apply((event as CustomEvent).detail);
    window.addEventListener('prism:focus-state', sync);
    apply(bridge.prismFocusState);
    mac?.postMessage({ action: 'ready' });
    return () => window.removeEventListener('prism:focus-state', sync);
  }, []);

  useEffect(() => {
    if (state.mood !== 'running' || state.endsAt === null) return;
    const end = state.endsAt;
    let timer: number;
    const refresh = () => {
      const timestamp = Date.now();
      setNow(timestamp);
      if (timestamp < end) timer = window.setTimeout(refresh, Math.min(1000, end - timestamp));
    };
    refresh();
    return () => window.clearTimeout(timer);
  }, [state]);

  function request(action: 'hide' | 'open') {
    const bridge = readBridge();
    const mac = bridge.webkit?.messageHandlers?.prismPet;
    if (mac) mac.postMessage({ action });
    else if (action === 'hide') bridge.prismFocus?.hidePet?.();
    else bridge.prismFocus?.openFocus?.();
  }

  function startDrag(event: PointerEvent<HTMLElement>) {
    const target = event.target as Element;
    if (target.closest('[data-pet-menu]')) return;
    setMenuOpen(false);
    if (event.button !== 0) return;
    suppressClick.current = false;
    const bridge = readBridge();
    if (
      !(bridge.webkit?.messageHandlers?.prismPet || bridge.prismFocus?.dragPet) ||
      (target.closest('button') && !target.closest('[data-pet-drag]'))
    )
      return;
    drag.current = {
      id: event.pointerId,
      x: event.screenX,
      y: event.screenY,
      clientY: event.clientY,
      moved: false,
    };
    (target.closest('button') ?? event.currentTarget).setPointerCapture(event.pointerId);
  }

  function moveDrag(event: PointerEvent<HTMLElement>) {
    const previous = drag.current;
    if (previous?.id !== event.pointerId) return;
    const dx = event.screenX - previous.x;
    const screenDY = event.screenY - previous.y;
    if (!previous.moved && Math.hypot(dx, screenDY) < 4) return;
    if (!dx && !screenDY) return;
    const bridge = readBridge();
    const mac = bridge.webkit?.messageHandlers?.prismPet;
    const clientDY = event.clientY - previous.clientY;
    // WebKit may expose screen Y in Cocoa coordinates. Calibrate against the
    // first vertical move before changing the panel's position.
    const verticalSign =
      previous.verticalSign ?? (screenDY && clientDY ? Math.sign(screenDY * clientDY) : undefined);
    const dy = mac ? screenDY * (verticalSign ?? 0) : screenDY;
    drag.current = {
      id: event.pointerId,
      x: event.screenX,
      y: event.screenY,
      clientY: event.clientY,
      verticalSign,
      moved: true,
    };
    if (dx) setDirection(dx < 0 ? 'left' : 'right');
    suppressClick.current = true;
    setMotion('running');
    if (mac) mac.postMessage({ action: 'drag', dx, dy });
    else bridge.prismFocus?.dragPet?.(dx, dy);
  }

  function endDrag(event: PointerEvent<HTMLElement>) {
    if (drag.current?.id !== event.pointerId) return;
    if (drag.current.moved) setMotion('settling');
    drag.current = undefined;
  }

  function openMenu(target: EventTarget) {
    menuTrigger.current = (target as Element).closest('button');
    setMenuOpen(true);
  }

  const display = readout(state, now);

  return (
    <main
      className={styles.shell}
      data-reduced-motion={state.reducedMotion ? 'true' : undefined}
      data-phase={state.phase}
      data-motion={motion}
      data-direction={direction}
      aria-label="Study companion"
      onPointerDown={startDrag}
      onPointerMove={moveDrag}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onLostPointerCapture={endDrag}
      onClickCapture={(event) => {
        if (event.detail === 0 || !suppressClick.current) return;
        suppressClick.current = false;
        event.preventDefault();
        event.stopPropagation();
      }}
      onContextMenu={(event) => {
        if (!actions.hide) return;
        event.preventDefault();
        openMenu(event.target);
      }}
      onKeyDown={(event) => {
        if (!actions.hide) return;
        if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
          event.preventDefault();
          openMenu(event.target);
        }
        if (event.key !== 'Escape') return;
        if (menuOpen) {
          setMenuOpen(false);
          menuTrigger.current?.focus();
        } else request('hide');
      }}
    >
      <div className={styles.handle} aria-hidden="true" />
      <div className={styles.runner} data-pet-drag>
        <StudyPet phase={state.phase} status={display.mood} motion={motion} direction={direction} />
      </div>
      {menuOpen && (
        <div className={styles.context} data-pet-menu>
          <button
            type="button"
            autoFocus
            onClick={() => {
              setMenuOpen(false);
              request('hide');
            }}
          >
            Hide desktop companion
          </button>
        </div>
      )}
      <div className={styles.tray}>
        {actions.open ? (
          <button
            className={styles.open}
            aria-label={`Open focus timer. ${display.label}`}
            title="Open focus timer"
            onClick={() => request('open')}
          >
            {display.label}
          </button>
        ) : (
          <span className={styles.open}>{display.label}</span>
        )}
        {actions.hide && (
          <button
            className={styles.hide}
            aria-label="Hide study companion"
            title="Hide study companion"
            onClick={() => request('hide')}
          >
            <svg viewBox="0 0 12 12" aria-hidden="true">
              <path d="m3 3 6 6M9 3 3 9" />
            </svg>
          </button>
        )}
      </div>
    </main>
  );
}
