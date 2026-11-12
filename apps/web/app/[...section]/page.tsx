import { redirect } from 'next/navigation';
import Workspace from '../../components/Workspace';

type SearchParams = Record<string, string | string[] | undefined>;

function chapterBound(value: SearchParams[string]) {
  return typeof value === 'string' && /^[1-9]\d{0,5}$/.test(value) ? Number(value) : undefined;
}

function entityId(value: SearchParams[string]) {
  return typeof value === 'string' && /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(value)
    ? value
    : undefined;
}

export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ section: string[] }>;
  searchParams: Promise<SearchParams>;
}) {
  const { section } = await params;
  if (section[0] === 'fitness' || section[0] === 'planner') redirect('/today');
  const route = section.join('/');
  const filters =
    route === 'knowledge' ||
    route === 'review/session' ||
    route === 'discover' ||
    route.startsWith('research/')
      ? await searchParams
      : {};
  const subject = typeof filters.subject === 'string' ? filters.subject : undefined;
  const from = chapterBound(filters.chapter_from);
  const to = chapterBound(filters.chapter_to);
  const chapters =
    subject !== undefined && from !== undefined && to !== undefined && from <= to ? { from, to } : undefined;
  const reviewCardId = route === 'review/session' ? entityId(filters.card) : undefined;
  const discoverView = route === 'discover' && filters.view === 'for-you' ? 'for-you' : undefined;
  const discoverRefresh = discoverView ? entityId(filters.refresh) : undefined;
  return (
    <Workspace
      route={route}
      studyScope={{ subject, chapters }}
      reviewCardId={reviewCardId}
      discoverView={discoverView}
      discoverRefresh={discoverRefresh}
      researchObjectId={route.startsWith('research/') ? entityId(filters.object) : undefined}
    />
  );
}
