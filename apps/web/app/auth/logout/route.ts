import { NextRequest, NextResponse } from 'next/server';
import { clearCookie, deleteServerSession, FLOW_COOKIE, SESSION_COOKIE } from '../../../lib/server-auth';
export async function GET(request: NextRequest) {
  await deleteServerSession(request);
  const response = NextResponse.redirect(new URL('/auth/signed-out', request.url));
  clearCookie(response, SESSION_COOKIE);
  clearCookie(response, FLOW_COOKIE);
  return response;
}
