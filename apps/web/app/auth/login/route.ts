import { createHash, randomBytes } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { apiBase, FLOW_COOKIE, oauthClient, setCookie } from '../../../lib/server-auth';
export const runtime = 'nodejs';
export async function GET(request: NextRequest) {
  try {
    const { clientId } = oauthClient();
    const response = await fetch(`${apiBase()}/api/v1/auth/config`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error('Sign-in is not configured. Contact your deployment administrator.');
    const config = (await response.json()) as {
      issuer: string;
      authorization_endpoint: string;
      token_endpoint: string;
    };
    const verifier = randomBytes(48).toString('base64url');
    const state = randomBytes(32).toString('base64url');
    const nonce = randomBytes(32).toString('base64url');
    const redirectUri =
      process.env.PRISM_OIDC_REDIRECT_URI || new URL('/auth/callback', request.url).toString();
    const target = new URL(config.authorization_endpoint);
    for (const [key, value] of Object.entries({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: 'openid profile email offline_access',
      state,
      nonce,
      code_challenge_method: 'S256',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    }))
      target.searchParams.set(key, value);
    const redirect = NextResponse.redirect(target);
    setCookie(
      redirect,
      FLOW_COOKIE,
      {
        verifier,
        state,
        nonce,
        issuer: config.issuer,
        redirectUri,
        tokenEndpoint: config.token_endpoint,
        createdAt: Date.now(),
      },
      600,
    );
    return redirect;
  } catch (error) {
    return NextResponse.redirect(
      new URL(
        `/auth/error?message=${encodeURIComponent(error instanceof Error ? error.message : 'Sign-in failed')}`,
        request.url,
      ),
    );
  }
}
