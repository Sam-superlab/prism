import { redirect } from 'next/navigation';
import Workspace from '../../components/Workspace';

type SearchParams = Record<string, string | string[] | undefined>;

function chapterBound(value: SearchParams[string]) {
  return typeof value === 'string' && /^[1-9]\d{0,5}$/.test(value) ? Number(value) : undefined;
}

export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ section: string[] }>;
  searchParams: Promise<SearchParams>;
}) {
  const { section } = await params;
  if (section[0] === 'fitness') redirect('/today');
  const route = section.join('/');
  const filters = route === 'knowledge' || route === 'review/session' ? await searchParams : {};
  const subject = typeof filters.subject === 'string' ? filters.subject : undefined;
  const from = chapterBound(filters.chapter_from);
  const to = chapterBound(filters.chapter_to);
  const chapters =
    subject !== undefined && from !== undefined && to !== undefined && from <= to ? { from, to } : undefined;
  const reviewCardId =
    route === 'review/session' &&
    typeof filters.card === 'string' &&
    /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(filters.card)
      ? filters.card
      : undefined;
  return <Workspace route={route} studyScope={{ subject, chapters }} reviewCardId={reviewCardId} />;
}
