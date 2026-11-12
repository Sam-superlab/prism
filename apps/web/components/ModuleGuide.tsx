'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import type { GuideLanguage } from '../lib/getting-started-copy';
import { StudyPet } from './StudyPet';
import styles from './ModuleGuide.module.css';

type Module = 'knowledge' | 'practice' | 'research';
type Progress = { status: 'active' | 'paused' | 'completed'; itemId?: string };
type Copy = {
  title: Record<Module, string>;
  intro: Record<Module, string>;
  begin: Record<Module, string>;
  next: Record<'knowledge' | 'research', string>;
  nextAction: Record<'knowledge' | 'research', string>;
  editor: Record<Module, string>;
  review: string;
  makeCard: string;
  reopen: string;
  skip: string;
  resume: string;
  restart: string;
  sample: string;
  keep: string;
  sampleBook: string;
  sampleChapter: string;
};

export const moduleGuideCopy: Record<GuideLanguage, Copy> = {
  en: {
    title: {
      knowledge: 'Your first knowledge note',
      practice: 'Try an exercise import',
      research: 'Start a research project',
    },
    intro: {
      knowledge: 'Let’s write a definition and see how its formula looks as you type.',
      practice: 'Let’s take one exercise from a PDF and check the extracted math.',
      research: 'Tell me what you’re working on. Then we’ll bring in a note or paper.',
    },
    begin: {
      knowledge: 'Write a definition with Pip',
      practice: 'Start the import with Pip',
      research: 'Set up a project with Pip',
    },
    next: {
      knowledge: 'Your definition is saved. Turn it into a question you can answer from memory.',
      research: 'Your project is ready. Link a note or paper so you can find it under Project materials.',
    },
    nextAction: { knowledge: 'Make a card with Pip', research: 'Find material to link' },
    editor: {
      knowledge:
        'Give your definition a title. Try typing $a+b=b+a$ in Mathematical content, then check the preview and save.',
      practice:
        'Choose a selectable-text PDF, enter its page range, and preview the exercises. You can try my one-page sample, too.',
      research:
        'Name your project and write a short question in Background and objectives. Save when you’re ready.',
    },
    review:
      'Compare the original excerpt with the rendered formula. Check any highlighted uncertainty, select an exercise, and save it.',
    makeCard:
      'Write a question in Prompt, then use Reference answer for the definition you want to remember.',
    reopen: 'Go back to that step',
    skip: 'Skip for now',
    resume: 'Resume with Pip',
    restart: 'Replay guide',
    sample: 'Try Pip’s sample PDF',
    keep: 'Keep this example',
    sampleBook: 'Pip’s practice sample',
    sampleChapter: 'Algebra',
  },
  'zh-CN': {
    title: { knowledge: '写下第一条知识笔记', practice: '试着导入一道习题', research: '开始一个研究项目' },
    intro: {
      knowledge: '我们来写一条定义，看看公式输入后会怎样显示。',
      practice: '我们从 PDF 里选一道题，一起检查提取出来的公式。',
      research: '告诉我你在研究什么，再一起关联一条笔记或一篇论文。',
    },
    begin: { knowledge: '和 Pip 一起写定义', practice: '和 Pip 一起导入', research: '和 Pip 一起建项目' },
    next: {
      knowledge: '定义已保存。把它写成一个可以凭记忆回答的问题吧。',
      research: '项目已准备好。关联一条笔记或一篇论文，之后可以在 Project materials 找到它。',
    },
    nextAction: { knowledge: '和 Pip 一起做卡片', research: '选择要关联的资料' },
    editor: {
      knowledge: '先给定义起个标题。试着在 Mathematical content 中输入 $a+b=b+a$，看一下预览，然后保存。',
      practice: '选择文字可选中的 PDF，填入页码范围，再预览习题。也可以先试用我的单页示例。',
      research: '为项目起个名字，在 Background and objectives 写下一句研究问题，然后保存。',
    },
    review: '对照原文和渲染后的公式，检查高亮的不确定之处，再勾选一道题保存。',
    makeCard: '在 Prompt 写一个问题，在 Reference answer 填入想记住的定义。',
    reopen: '回到这一步',
    skip: '暂时跳过',
    resume: '和 Pip 继续',
    restart: '重看引导',
    sample: '试用 Pip 的示例 PDF',
    keep: '保留示例',
    sampleBook: 'Pip 的习题示例',
    sampleChapter: '代数',
  },
  ja: {
    title: {
      knowledge: '最初の知識ノート',
      practice: '練習問題の取り込み',
      research: '最初の研究プロジェクト',
    },
    intro: {
      knowledge: '定義を書いて、入力した数式がどう表示されるか見てみましょう。',
      practice: 'PDF から問題を一つ取り込み、読み取った数式を確認しましょう。',
      research: '研究したいことを教えてください。関連するノートや論文も一緒にまとめましょう。',
    },
    begin: {
      knowledge: 'Pip と定義を書く',
      practice: 'Pip と取り込む',
      research: 'Pip とプロジェクトを作る',
    },
    next: {
      knowledge: '定義を保存しました。思い出して答えられる質問にしてみましょう。',
      research: 'プロジェクトを作成しました。ノートや論文を関連付けると、Project materials に表示されます。',
    },
    nextAction: { knowledge: 'Pip とカードを作る', research: '関連付ける資料を選ぶ' },
    editor: {
      knowledge:
        'タイトルを入力し、Mathematical content に $a+b=b+a$ と書いてみましょう。プレビューを確認したら保存します。',
      practice:
        '文字を選択できる PDF とページ範囲を指定し、問題をプレビューします。1 ページのサンプルも試せます。',
      research:
        'プロジェクト名を決めて、Background and objectives に研究の問いを一文で書き、保存しましょう。',
    },
    review:
      '原文と表示された数式を見比べます。強調表示された箇所を確認し、取り込みたい問題を選んで保存しましょう。',
    makeCard: 'Prompt に質問を書き、Reference answer に覚えたい定義を入れましょう。',
    reopen: 'このステップを開く',
    skip: '今はスキップ',
    resume: 'Pip と再開',
    restart: 'ガイドをもう一度',
    sample: 'Pip のサンプル PDF を試す',
    keep: 'サンプルを保存',
    sampleBook: 'Pip の練習サンプル',
    sampleChapter: '代数',
  },
};

const initial: Progress = { status: 'active' };

export function useModuleGuide(module: Module, userId?: string, language: GuideLanguage = 'en') {
  const key = userId && `prism.module-guide.v1.${module}.${userId}`;
  const [stored, setStored] = useState<{ key: string; progress: Progress }>();
  const latest = useRef(stored);
  const progress = key && stored?.key === key ? stored.progress : undefined;

  useEffect(() => {
    if (!key) return;
    let progress = initial;
    const url = new URL(window.location.href);
    const requested = url.searchParams.get('guide') === '1';
    try {
      const saved = JSON.parse(localStorage.getItem(key) ?? 'null') as Progress | null;
      if (
        saved &&
        ['active', 'paused', 'completed'].includes(saved.status) &&
        (saved.itemId === undefined || typeof saved.itemId === 'string')
      )
        progress = saved;
      if (requested) {
        progress = progress.status === 'completed' ? initial : { ...progress, status: 'active' };
        localStorage.setItem(key, JSON.stringify(progress));
      }
    } catch {
      // The guide still works when storage is unavailable.
    }
    if (requested) {
      url.searchParams.delete('guide');
      window.history.replaceState(null, '', url);
    }
    latest.current = { key, progress };
    setStored(latest.current);
  }, [key]);

  function update(change: (current: Progress) => Progress | undefined) {
    if (!key || latest.current?.key !== key) return;
    const next = change(latest.current.progress);
    if (!next) return;
    latest.current = { key, progress: next };
    setStored(latest.current);
    try {
      localStorage.setItem(key, JSON.stringify(next));
    } catch {
      // Retain the current progress for this visit.
    }
  }

  return {
    module,
    language,
    copy: moduleGuideCopy[language],
    progress,
    active: progress?.status === 'active',
    continueWith: (itemId: string) =>
      update((current) => (current.status === 'active' ? { ...current, itemId } : undefined)),
    finish: () => update((current) => (current.status === 'active' ? { status: 'completed' } : undefined)),
    pause: () => update((current) => ({ ...current, status: 'paused' })),
    resume: () => update((current) => ({ ...current, status: 'active' })),
    restart: () => update(() => initial),
  };
}

export type ModuleGuideState = ReturnType<typeof useModuleGuide>;

export function ModuleGuide({
  guide,
  continuation,
  action,
  actionDisabled,
  href,
}: {
  guide: ModuleGuideState;
  continuation?: 'knowledge' | 'research';
  action?: () => void;
  actionDisabled?: boolean;
  href?: string;
}) {
  const { copy, language, module, progress } = guide;
  if (!progress) return null;
  if (progress.status !== 'active')
    return (
      <button
        className={`text-link ${styles.reopen}`}
        lang={language}
        onClick={progress.status === 'paused' ? guide.resume : guide.restart}
      >
        {progress.status === 'paused' ? copy.resume : copy.restart}
      </button>
    );

  const actionLabel =
    href && continuation ? copy.reopen : continuation ? copy.nextAction[continuation] : copy.begin[module];
  return (
    <aside className={`panel ${styles.guide}`} aria-label={copy.title[module]} lang={language}>
      <div className={styles.pip}>
        <StudyPet phase="focus" status="ready" />
      </div>
      <div className={styles.message}>
        <h2>{copy.title[module]}</h2>
        <p>{continuation ? copy.next[continuation] : copy.intro[module]}</p>
        <div className={styles.actions}>
          {href ? (
            <Link className="button primary small" href={href}>
              {actionLabel}
            </Link>
          ) : (
            <button className="button primary small" type="button" onClick={action} disabled={actionDisabled}>
              {actionLabel}
            </button>
          )}
          <button className="text-link" type="button" onClick={guide.pause}>
            {copy.skip}
          </button>
        </div>
      </div>
    </aside>
  );
}

export function ModuleGuideHint({ guide, children }: { guide: ModuleGuideState; children: string }) {
  if (!guide.active) return null;
  return (
    <div className={styles.hint} lang={guide.language}>
      <span>{children}</span>
      <button className="text-link" type="button" onClick={guide.pause}>
        {guide.copy.skip}
      </button>
    </div>
  );
}
