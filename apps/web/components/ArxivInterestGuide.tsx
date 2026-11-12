'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api, useAction, uuid } from '../lib/api';
import { arxivTaxonomy } from '../lib/arxiv-taxonomy';
import { guideCopy, type GuideLanguage } from '../lib/getting-started-copy';
import type { Job, Page, Subscription } from '../lib/types';
import { StudyPet } from './StudyPet';
import { Field, Icon, Modal, Notice } from './ui';
import styles from './GettingStarted.module.css';

type Subject = (typeof arxivTaxonomy)[number]['id'];
type Area = { code: string; name: string };

export type ArxivInterestDraft = {
  step: 'subjects' | 'areas';
  subjects: string[];
  areas: string[];
};

const emptyDraft: ArxivInterestDraft = { step: 'subjects', subjects: [], areas: [] };
const subjectOrder: Subject[] = ['math', 'cs', 'physics', 'stat', 'eess', 'econ', 'q-bio', 'q-fin'];
const subjectNames = {
  'zh-CN': {
    math: '数学',
    cs: '计算机科学',
    physics: '物理学',
    stat: '统计学',
    eess: '电气工程与系统科学',
    econ: '经济学',
    'q-bio': '定量生物学',
    'q-fin': '定量金融',
  },
  ja: {
    math: '数学',
    cs: '計算機科学',
    physics: '物理学',
    stat: '統計学',
    eess: '電気工学・システム科学',
    econ: '経済学',
    'q-bio': '定量生物学',
    'q-fin': '数理ファイナンス',
  },
};

const copyByLanguage = {
  en: {
    greeting: 'Hi, I’m Pip. Let’s find a few papers for you.',
    subjects: 'What subjects are you interested in?',
    areas: 'Which research areas should I follow for you?',
    search: 'Search areas by name',
    areasHint: 'Choose one or more areas. You can change your subscriptions in Discover.',
    selected: (count: number) => `${count} selected`,
    empty: 'No areas match your search.',
    next: 'Choose research areas',
    back: 'Back',
    finish: 'Show my first round',
    saving: 'Preparing your feed…',
    error: 'I couldn’t prepare your feed. Please try again.',
  },
  'zh-CN': {
    greeting: '你好，我是 Pip。我们一起来找几篇你感兴趣的论文吧。',
    subjects: '你对哪些学科感兴趣？',
    areas: '你想关注哪些研究领域？',
    search: '按名称搜索研究领域',
    areasHint: '选择一个或多个领域。之后可以在 Discover 中调整订阅。',
    selected: (count: number) => `已选 ${count} 个`,
    empty: '没有找到符合搜索条件的领域。',
    next: '选择研究领域',
    back: '返回',
    finish: '查看第一轮论文',
    saving: '正在准备论文列表…',
    error: '暂时无法准备论文列表，请重试。',
  },
  ja: {
    greeting: 'こんにちは、Pip です。興味のある論文を一緒に探しましょう。',
    subjects: 'どの学問分野に興味がありますか？',
    areas: 'どの研究領域をフォローしますか？',
    search: '研究領域を名前で検索',
    areasHint: '研究領域を一つ以上選んでください。購読設定は後で Discover から変更できます。',
    selected: (count: number) => `${count} 件選択中`,
    empty: '一致する研究領域が見つかりません。',
    next: '研究領域を選ぶ',
    back: '戻る',
    finish: '最初の論文を見る',
    saving: '論文リストを準備中…',
    error: '論文リストを準備できませんでした。もう一度お試しください。',
  },
};

function groupsFor(subjects: string[]) {
  return arxivTaxonomy.filter(({ id }) => subjects.includes(id));
}

function areasFor(subjects: string[]): Area[] {
  return groupsFor(subjects).flatMap<Area>(({ categories }) => categories);
}

export function readArxivInterestDraft(value: unknown): ArxivInterestDraft | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const input = value as Partial<ArxivInterestDraft>;
  if (!Array.isArray(input.subjects) || !Array.isArray(input.areas)) return undefined;
  const subjects = subjectOrder.filter((subject) => input.subjects?.includes(subject));
  return {
    step: input.step === 'areas' && subjects.length ? 'areas' : 'subjects',
    subjects,
    areas: areasFor(subjects)
      .filter(({ code }) => input.areas?.includes(code))
      .map(({ code }) => code),
  };
}

// arXiv lists these mathematical areas as aliases of their canonical archives.
function canonicalCategory(code: string) {
  if (code === 'math.IT') return 'cs.IT';
  if (code === 'math.MP') return 'math-ph';
  return code;
}

async function followAreas(areas: string[]) {
  const existing = new Map<string, Subscription>();
  let cursor: string | null = null;
  do {
    const page: Page<Subscription> = await api(
      `/arxiv/subscriptions?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
    );
    for (const item of page.items) {
      if (item.subscription_type === 'category') existing.set(item.subscription_value.toLowerCase(), item);
    }
    cursor = page.next_cursor;
  } while (cursor);

  for (const code of new Set(areas.map(canonicalCategory))) {
    const current = existing.get(code.toLowerCase());
    if (current?.enabled) continue;
    if (current) {
      await api(`/arxiv/subscriptions/${current.id}`, {
        method: 'PATCH',
        body: { enabled: true },
        version: current.version,
      });
    } else {
      await api('/arxiv/subscriptions', {
        method: 'POST',
        body: {
          id: uuid(),
          subscription_type: 'category',
          subscription_value: code,
          enabled: true,
          weight: 1,
        },
      });
    }
  }
  return api<Job>('/arxiv/refresh', { method: 'POST' });
}

export function ArxivInterestGuide({
  language,
  languageControl,
  draft = emptyDraft,
  onChange,
  onSkip,
  onFinish,
}: {
  language: GuideLanguage;
  languageControl: ReactNode;
  draft?: ArxivInterestDraft;
  onChange: (draft: ArxivInterestDraft) => void;
  onSkip: () => void;
  onFinish: (jobId: string) => void;
}) {
  const copy = copyByLanguage[language];
  const guide = guideCopy[language];
  const action = useAction();
  const [query, setQuery] = useState('');
  const saving = useRef(false);
  const question = useRef<HTMLHeadingElement>(null);
  const areasStep = draft.step === 'areas';
  const groups = groupsFor(draft.subjects);
  const search = query.trim().normalize('NFKC').toLowerCase();
  const filtered = groups
    .map((group) => ({
      ...group,
      categories: group.categories.filter(({ name }) => name.toLowerCase().includes(search)),
    }))
    .filter(({ categories }) => categories.length);

  useEffect(() => {
    question.current?.focus({ preventScroll: true });
  }, [areasStep]);

  function toggleSubject(subject: Subject) {
    const subjects = draft.subjects.includes(subject)
      ? draft.subjects.filter((value) => value !== subject)
      : [...draft.subjects, subject];
    const areas = areasFor(subjects)
      .filter(({ code }) => draft.areas.includes(code))
      .map(({ code }) => code);
    onChange({ ...draft, subjects, areas });
  }

  function toggleArea(code: string) {
    const areas = draft.areas.includes(code)
      ? draft.areas.filter((area) => area !== code)
      : [...draft.areas, code];
    onChange({ ...draft, areas });
  }

  async function finish() {
    if (saving.current || !draft.areas.length) return;
    saving.current = true;
    try {
      const job = await action.run(() => followAreas(draft.areas));
      if (job) onFinish(job.id);
    } finally {
      saving.current = false;
    }
  }

  const close = () => {
    if (!saving.current) onSkip();
  };

  return (
    <Modal title={guide.welcome} lang={language} closeLabel={guide.close} onClose={close}>
      <div className={styles.pipIntro}>
        <StudyPet phase="focus" status="ready" />
        <div>
          {!areasStep && <p className="muted">{copy.greeting}</p>}
          <h3 id="arxiv-interest-question" ref={question} tabIndex={-1}>
            {areasStep ? copy.areas : copy.subjects}
          </h3>
        </div>
      </div>
      <div className={styles.interestLanguage}>{languageControl}</div>
      {areasStep ? (
        <>
          <p className="muted">{copy.areasHint}</p>
          <Field label={copy.search}>
            <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} />
          </Field>
          <p className={styles.interestCount} role="status">
            {copy.selected(draft.areas.length)}
          </p>
          <div className={styles.areaList} role="group" aria-labelledby="arxiv-interest-question">
            {!filtered.length && <p className="muted">{copy.empty}</p>}
            {filtered.map(({ id, title, categories }) => (
              <div className={styles.areaGroup} key={id}>
                <h4>{language === 'en' ? title : subjectNames[language][id]}</h4>
                <div className={styles.interestChoices}>
                  {categories.map(({ code, name }) => (
                    <button
                      type="button"
                      key={code}
                      className={styles.interestChoice}
                      aria-pressed={draft.areas.includes(code)}
                      disabled={action.busy}
                      onClick={() => toggleArea(code)}
                    >
                      <span lang="en">{name}</span>
                      {draft.areas.includes(code) && <Icon name="check" size={14} />}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </>
      ) : (
        <div className={styles.interestChoices} role="group" aria-labelledby="arxiv-interest-question">
          {subjectOrder.map((id) => (
            <button
              type="button"
              key={id}
              className={styles.interestChoice}
              aria-pressed={draft.subjects.includes(id)}
              onClick={() => toggleSubject(id)}
            >
              {language === 'en'
                ? arxivTaxonomy.find((group) => group.id === id)?.title
                : subjectNames[language][id]}
              {draft.subjects.includes(id) && <Icon name="check" size={14} />}
            </button>
          ))}
        </div>
      )}
      {action.error && <Notice tone="error">{copy.error}</Notice>}
      <div className={`modal-footer ${styles.actions}`}>
        <button type="button" className="button" disabled={action.busy} onClick={close}>
          {guide.skip}
        </button>
        {areasStep ? (
          <>
            <button
              type="button"
              className="button"
              disabled={action.busy}
              onClick={() => onChange({ ...draft, step: 'subjects' })}
            >
              {copy.back}
            </button>
            <button
              type="button"
              className="button primary"
              disabled={action.busy || !draft.areas.length}
              onClick={() => void finish()}
            >
              {action.busy ? copy.saving : copy.finish}
            </button>
          </>
        ) : (
          <button
            type="button"
            className="button primary"
            disabled={!draft.subjects.length}
            onClick={() => onChange({ ...draft, step: 'areas' })}
          >
            {copy.next}
          </button>
        )}
      </div>
    </Modal>
  );
}
