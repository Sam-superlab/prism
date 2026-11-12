import Workspace from '../../components/Workspace';
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ section: string[] }>;
  searchParams: Promise<{ card?: string | string[] }>;
}) {
  const [{ section }, { card }] = await Promise.all([params, searchParams]);
  const route = section.join('/');
  const reviewCardId =
    route === 'review/session' &&
    typeof card === 'string' &&
    /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(card)
      ? card
      : undefined;
  return <Workspace route={route} reviewCardId={reviewCardId} />;
}
