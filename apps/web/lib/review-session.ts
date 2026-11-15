'use client';

import { useCallback, useMemo, useSyncExternalStore } from 'react';

type Rating = 'again' | 'hard' | 'good' | 'easy';

export type PendingReview = {
  card_id: string;
  device_id: string;
  rating: Rating;
  reviewed_at: string;
  duration_ms: number;
  base_version: string;
  idempotency_key: string;
  proof_stuck_step_ids?: string[];
};

export type ReviewSession = {
  id: string;
  updatedAt: number;
  cards: { id: string; lastReviewedAt: string | null }[];
  cursor: string | null;
  position: number;
  reviewed: { title: string; due: string; rating: Rating; durationMs: number }[];
  draft?: { text: string; revealed: boolean; stuck: string[]; hintsUsed: number };
  pending?: { command: PendingReview; title: string };
  conflict?: string;
};

export type ReviewProgress = { href: string; reviewed: number; total: number };

const changeEvent = 'prism:review-progress-changed';
const prefix = 'prism.review-session.v1.';
const memory = new Map<string, string>();

function read(key: string) {
  try {
    return memory.get(key) ?? localStorage.getItem(key);
  } catch {
    return memory.get(key) ?? null;
  }
}

function parse(raw: string | null): Record<string, ReviewSession> {
  if (!raw) return {};
  try {
    const data = JSON.parse(raw);
    return Object.fromEntries(
      Object.entries(data).filter(([href, value]) => {
        const session = value as ReviewSession | null;
        return /^\/review\/session(?:\?|$)/.test(href)
          && session && typeof session.id === 'string' && Number.isInteger(session.position)
          && session.position >= 0 && Number.isFinite(session.updatedAt)
          && Array.isArray(session.cards) && Array.isArray(session.reviewed);
      }),
    ) as Record<string, ReviewSession>;
  } catch {
    return {};
  }
}

function useSessions(userId: string | undefined) {
  const key = userId && prefix + userId;
  const subscribe = useCallback((listener: () => void) => {
    if (!key) return () => {};
    const change = (event: Event) => {
      if (event instanceof StorageEvent ? !event.key || event.key === key :
        (event as CustomEvent<string>).detail === key) listener();
    };
    window.addEventListener(changeEvent, change);
    window.addEventListener('storage', change);
    return () => {
      window.removeEventListener(changeEvent, change);
      window.removeEventListener('storage', change);
    };
  }, [key]);
  const snapshot = useCallback(() => key ? read(key) : null, [key]);
  const raw = useSyncExternalStore(subscribe, snapshot, () => null);
  return useMemo(() => parse(raw), [raw]);
}

export function useReviewSession(userId: string | undefined, href: string) {
  return useSessions(userId)[href];
}

export function useReviewProgress(userId: string | undefined): ReviewProgress | null {
  const sessions = useSessions(userId);
  return useMemo(() => {
    const latest = Object.entries(sessions)
      .filter(([, session]) => session.position < session.cards.length)
      .sort(([, a], [, b]) => b.updatedAt - a.updatedAt)[0];
    if (!latest) return null;
    const [href, session] = latest;
    return { href, reviewed: session.reviewed.length, total: session.cards.length };
  }, [sessions]);
}

export function updateReviewSession(
  userId: string,
  href: string,
  change: (current: ReviewSession | undefined) => ReviewSession | undefined,
) {
  const key = prefix + userId;
  const sessions = parse(read(key));
  const current = sessions[href];
  const updated = change(current);
  if (!updated || updated === current) return updated;
  const next = { ...updated, updatedAt: Date.now() };
  sessions[href] = next;
  const raw = JSON.stringify(sessions);
  try {
    localStorage.setItem(key, raw);
    memory.delete(key);
  } catch {
    memory.set(key, raw);
  }
  window.dispatchEvent(new CustomEvent(changeEvent, { detail: key }));
  return next;
}
