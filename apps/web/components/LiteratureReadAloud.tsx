'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { literatureSpeechChunks } from '../lib/literature-read-aloud';
import styles from './LiteraturePdfReader.module.css';

export function LiteratureReadAloud({ paragraphs, onParagraph }: {
  paragraphs: readonly string[];
  onParagraph: (index: number | null) => void;
}) {
  const chunks = useMemo(() => literatureSpeechChunks(paragraphs), [paragraphs]);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [voiceURI, setVoiceURI] = useState('');
  const [rate, setRate] = useState(1);
  const [index, setIndex] = useState(0);
  const [status, setStatus] = useState<'idle' | 'playing' | 'paused'>('idle');
  const [error, setError] = useState('');
  const utterance = useRef<SpeechSynthesisUtterance | null>(null);

  useEffect(() => {
    const engine = window.speechSynthesis;
    const syncVoices = () => setVoices(engine.getVoices().filter((voice) => voice.localService));
    if (!engine || typeof SpeechSynthesisUtterance !== 'function') return;
    syncVoices();
    engine.addEventListener('voiceschanged', syncVoices);
    return () => {
      engine.removeEventListener('voiceschanged', syncVoices);
      if (utterance.current) {
        utterance.current = null;
        engine.cancel();
      }
      onParagraph(null);
    };
  }, [onParagraph]);

  function stop() {
    if (utterance.current) {
      utterance.current = null;
      window.speechSynthesis.cancel();
    }
    onParagraph(null);
    setStatus('idle');
  }

  function play(next: number) {
    const chunk = chunks[next];
    const voice = voices.find((item) => item.voiceURI === voiceURI) ?? voices.find((item) => item.default) ?? voices[0];
    if (!chunk || !voice) return;
    stop();
    setError('');
    const speech = new SpeechSynthesisUtterance(chunk.text);
    speech.voice = voice;
    speech.lang = voice.lang;
    speech.rate = rate;
    speech.onend = () => {
      if (utterance.current !== speech) return;
      utterance.current = null;
      if (next + 1 < chunks.length) play(next + 1);
      else { stop(); setIndex(0); }
    };
    speech.onerror = () => {
      if (utterance.current !== speech) return;
      utterance.current = null;
      stop();
      setError('The selected voice could not read this page.');
    };
    utterance.current = speech;
    setIndex(next);
    setStatus('playing');
    onParagraph(chunk.paragraphIndex);
    window.speechSynthesis.speak(speech);
  }

  function move(next: number) {
    setIndex(next);
    if (status === 'playing') play(next);
    else stop();
  }

  if (!chunks.length) return null;
  return (
    <section className={styles.toolbar} aria-label="Read aloud">
      {voices.length ? <>
        <button className="button small" type="button" onClick={() => {
          if (status === 'playing') {
            window.speechSynthesis.pause();
            setStatus('paused');
          } else if (status === 'paused') {
            window.speechSynthesis.resume();
            setStatus('playing');
          } else play(index);
        }}>{status === 'playing' ? 'Pause reading' : status === 'paused' ? 'Resume reading' : 'Read aloud'}</button>
        <button className="button small" type="button" disabled={index === 0} onClick={() => move(index - 1)}>Previous passage</button>
        <button className="button small" type="button" disabled={index >= chunks.length - 1} onClick={() => move(index + 1)}>Next passage</button>
        {status !== 'idle' && <button className="button small" type="button" onClick={stop}>Stop reading</button>}
        <label>Voice <select value={voiceURI} disabled={status !== 'idle'} onChange={(event) => setVoiceURI(event.target.value)}>
          <option value="">Default device voice</option>
          {voices.map((voice) => <option value={voice.voiceURI} key={voice.voiceURI}>{voice.name} ({voice.lang})</option>)}
        </select></label>
        <label>Speed <select value={rate} disabled={status !== 'idle'} onChange={(event) => setRate(Number(event.target.value))}>
          {[0.75, 1, 1.25, 1.5].map((speed) => <option value={speed} key={speed}>{speed}×</option>)}
        </select></label>
      </> : <span className="muted small-text">Read aloud requires a voice installed on this device.</span>}
      {error && <span role="alert" className="small-text">{error}</span>}
    </section>
  );
}
