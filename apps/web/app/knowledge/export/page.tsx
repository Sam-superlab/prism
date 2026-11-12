import type { Metadata } from 'next';
import KnowledgeExport from './KnowledgeExport';

export const metadata: Metadata = {
  title: 'Export knowledge · PRISM',
  robots: { index: false, follow: false },
};

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ item?: string | string[] }>;
}) {
  const { item } = await searchParams;
  return <KnowledgeExport initialItemId={typeof item === 'string' ? item : undefined} />;
}
