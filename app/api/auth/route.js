export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import {
  authCookieValue,
  checkPassword,
  hasValidAuthCookie,
  isAuthEnabled,
  makeAuthCookie
} from '../../../lib/auth.js';

export async function GET(req) {
  return Response.json({
    passwordEnabled: isAuthEnabled(),
    authenticated: hasValidAuthCookie(req)
  });
}

export async function POST(req) {
  const body = await req.json().catch(() => ({}));

  if (!isAuthEnabled()) {
    return Response.json({ ok: true, passwordEnabled: false, authenticated: true });
  }

  if (!checkPassword(body.password)) {
    return Response.json({ error: 'Nieprawidłowe hasło.' }, { status: 401 });
  }

  const res = Response.json({ ok: true, passwordEnabled: true, authenticated: true });
  res.headers.append('Set-Cookie', makeAuthCookie(authCookieValue()));
  return res;
}

export async function DELETE() {
  const res = Response.json({ ok: true, authenticated: false });
  res.headers.append('Set-Cookie', makeAuthCookie('', 0));
  return res;
}
