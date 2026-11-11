import Link from 'next/link';
export default function SignedOut() {
  return (
    <main className="auth-page">
      <div className="panel content-panel">
        <span className="eyebrow">PRISM · WORKSPACE</span>
        <h1>You are signed out.</h1>
        <p>Your sign-in session has been cleared from this browser.</p>
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
