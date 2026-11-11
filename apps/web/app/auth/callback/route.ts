import { timingSafeEqual } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import {
  type AuthFlow,
  clearCookie,
  createServerSession,
  FLOW_COOKIE,
  SESSION_COOKIE,
  setCookie,
  tokenRequest,
  unseal,
  validateLogin,
} from '../../../lib/server-auth';
export const runtime = 'nodejs';
export async function GET(request: NextRequest) {
  try {
    const flow = unseal<AuthFlow>(request.cookies.get(FLOW_COOKIE)?.value);
    const state = request.nextUrl.searchParams.get('state');
    const code = request.nextUrl.searchParams.get('code');
    if (
      !flow ||
      !state ||
      !code ||
      Date.now() - flow.createdAt > 600000 ||
      Buffer.byteLength(state) !== Buffer.byteLength(flow.state) ||
      !timingSafeEqual(Buffer.from(state), Buffer.from(flow.state))
    )
      throw new Error('This sign-in request has expired or could not be verified. Please sign in again.');
    const session = await tokenRequest(flow.tokenEndpoint, {
      grant_type: 'authorization_code',
      code,
      code_verifier: flow.verifier,
      redirect_uri: flow.redirectUri,
    });
    await validateLogin(session, flow);
    const { idToken: _unused, ...tokens } = session;
    const stored = await createServerSession(tokens);
    const response = NextResponse.redirect(new URL('/today', request.url));
    clearCookie(response, FLOW_COOKIE);
    setCookie(response, SESSION_COOKIE, { id: stored.id }, stored.maxAge);
    return response;
  } catch (error) {
    const response = NextResponse.redirect(
      new URL(
        `/auth/error?message=${encodeURIComponent(error instanceof Error ? error.message : 'Sign-in failed')}`,
        request.url,
      ),
    );
    clearCookie(response, FLOW_COOKIE);
    return response;
  }
}
