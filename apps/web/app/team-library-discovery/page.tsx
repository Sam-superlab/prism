import type { Metadata } from 'next';
import { PublicLiteratureLibraries } from '../../components/PublicLiteratureLibraries';

export const metadata: Metadata = { title: 'Public team libraries · PRISM', robots: { index: false, follow: false } };

export default async function TeamLibraryDiscovery({ searchParams }: { searchParams: Promise<{ library?: string }> }) {
  const { library } = await searchParams;
  const id = library && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(library) ? library : undefined;
  return <PublicLiteratureLibraries id={id} />;
}
