export type Chapter = { number: number; title?: string };
export type ChapterRange = { from: number; to: number };
export type StudyScope = { subject?: string; chapters?: ChapterRange };

export function chapterName(chapter: Chapter) {
  return chapter.title ? `Chapter ${chapter.number}: ${chapter.title}` : `Chapter ${chapter.number}`;
}

export function scopedPath(
  path: string,
  { subject, chapters }: StudyScope,
  parameters: Record<string, string> = {},
) {
  const query = new URLSearchParams(parameters);
  if (subject !== undefined) query.set('subject', subject);
  if (chapters) {
    query.set('chapter_from', String(chapters.from));
    query.set('chapter_to', String(chapters.to));
  }
  const encoded = query.toString();
  return encoded ? `${path}?${encoded}` : path;
}
