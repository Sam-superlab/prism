'use client';

import { useEffect, useId, useState } from 'react';
import type { FocusPhase, FocusSession } from '../lib/focus-timer';
import styles from './StudyPet.module.css';

export function StudyPet({ phase, status }: { phase: FocusPhase; status: FocusSession['clock']['status'] }) {
  const id = useId();
  const [petting, setPetting] = useState(0);
  const resting = phase === 'break' && status === 'running';
  const working = phase === 'focus' && status === 'running';
  const mood = resting ? 'resting' : working ? 'working' : status;

  useEffect(() => {
    if (!petting) return;
    const timeout = window.setTimeout(() => setPetting(0), 650);
    return () => window.clearTimeout(timeout);
  }, [petting]);

  return (
    <button
      type="button"
      className={styles.pet}
      data-mood={mood}
      data-petted={petting ? 'true' : undefined}
      aria-label="Pet study companion"
      title="Pet Pip"
      onClick={() => setPetting((count) => count + 1)}
    >
      <svg className={styles.art} viewBox="0 0 156 112" aria-hidden="true" focusable="false">
        <defs>
          <linearGradient id={`${id}-fur`} x1="0" x2="1" y1="0" y2="1">
            <stop stopColor="#e6fbff" />
            <stop offset=".58" stopColor="#99d5f9" />
            <stop offset="1" stopColor="#a89aee" />
          </linearGradient>
          <linearGradient id={`${id}-gem`} x1="0" x2="1" y1="0" y2="1">
            <stop stopColor="#e4fbff" />
            <stop offset="1" stopColor="#9b8afa" />
          </linearGradient>
        </defs>
        <path
          d="M15 72c9-19 40-34 70-38s57 1 56 12-25 24-56 30c-18 4-38 4-51 0"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.1"
          opacity=".26"
        />
        <path
          className={styles.star}
          d="M120 16h10m-5-5v10M25 51h8m-4-4v8"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          opacity=".62"
        />
        <ellipse cx="78" cy="101" rx="36" ry="5" fill="currentColor" opacity=".12" />
        <g className={styles.float}>
          <g key={petting ? 'pet-' + petting : 'idle'} className={styles.reaction}>
            <path
              className={styles.tail}
              d="M107 82c18 7 29-1 23-13-4-7-13-7-16-2"
              fill="none"
              stroke="#8c8edc"
              strokeWidth="8"
              strokeLinecap="round"
            />
            <path
              d="M43 58c-7-11-8-24-3-35 10 0 22 5 29 13a51 51 0 0 1 20 0c7-8 17-13 28-12 5 11 3 23-4 35 3 5 4 10 4 15 0 16-14 23-39 23S39 90 39 74c0-6 1-11 4-16Z"
              fill={`url(#${id}-fur)`}
              stroke="#5973ae"
              strokeWidth="1.5"
            />
            <path
              d="M47 45c-4-6-6-12-5-17 7 1 15 5 20 11m45 7c4-6 5-12 5-17-7 0-14 4-19 10"
              fill="#8a79c7"
              opacity=".39"
            />
            <path d="M78 44l6 7-6 7-6-7Z" fill="#f7fdff" stroke="#7485c6" strokeWidth="1" />
            <ellipse cx="55" cy="72" rx="5.5" ry="2.5" fill="#a76bb0" opacity=".38" />
            <ellipse cx="101" cy="72" rx="5.5" ry="2.5" fill="#a76bb0" opacity=".38" />
            {resting || petting ? (
              <path
                d={
                  petting
                    ? 'M58 66q4-5 8 0m24 0q4-5 8 0m-24 6q4 5 8 0'
                    : 'M58 64q4 4 8 0m24 0q4 4 8 0m-24 7q4 3 8 0'
                }
                stroke="#293861"
                fill="none"
                strokeWidth="2"
                strokeLinecap="round"
              />
            ) : (
              <>
                <g className={styles.eyes}>
                  <ellipse cx="63" cy="65" rx="2.9" ry={working ? 3 : 3.7} fill="#293861" />
                  <ellipse cx="93" cy="65" rx="2.9" ry={working ? 3 : 3.7} fill="#293861" />
                </g>
                <path d="M74 72q4 4 8 0" stroke="#293861" fill="none" strokeWidth="2" strokeLinecap="round" />
              </>
            )}
            {working ? (
              <path
                d="M63 82q7-3 15 2 8-5 15-2v11q-8-2-15 1-8-3-15-1Z"
                fill="#f8f6ff"
                stroke="#6f81b9"
                strokeWidth="1.3"
                strokeLinejoin="round"
              />
            ) : (
              <path
                d="M60 89q3-4 7 0m22 0q4-4 7 0"
                fill="none"
                stroke="#6f81b9"
                strokeWidth="1.4"
                strokeLinecap="round"
              />
            )}
          </g>
        </g>
        {petting ? (
          <path
            className={styles.heart}
            d="M127 38c-3-8-14-5-12 2 1 5 7 8 12 12 5-4 11-7 12-12 2-7-9-10-12-2Z"
            fill="#dc80a8"
            stroke="#a95082"
            strokeWidth="1"
          />
        ) : (
          <path d="m132 57 5 7-5 7-5-7Z" fill={`url(#${id}-gem)`} stroke="currentColor" strokeWidth="1" />
        )}
      </svg>
    </button>
  );
}
