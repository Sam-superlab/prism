import Link from 'next/link';
export default async function ErrorPage({ searchParams }: { searchParams: Promise<{ message?: string }> }) {
  const { message } = await searchParams;
  return (
    <main className="auth-page">
      <div className="panel content-panel">
        <span className="eyebrow">PRISM · SIGN IN</span>
        <h1>Connect to your workspace.</h1>
        <p>{message || 'Sign-in was not completed. Please try again.'}</p>
        <div className="inline-actions">
          <a className="button primary" href="/auth/login">
            Sign in again
          </a>
          <Link className="button" href="/today">
            Back to workspace
          </Link>
        </div>
      </div>
    </main>
  );
}
