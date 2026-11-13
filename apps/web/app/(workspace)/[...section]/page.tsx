import { redirect } from 'next/navigation';

export default async function Page({ params }: { params: Promise<{ section: string[] }> }) {
  const { section } = await params;
  if (section[0] === 'fitness' || section[0] === 'planner') redirect('/today');
  return null;
}
