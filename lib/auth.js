import crypto from 'node:crypto';

export const AUTH_COOKIE_NAME = 'rejestr_finance_auth';
const COOKIE_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

export function sitePassword() {
  // Ustaw w Vercel/GitHub jako Environment Variable. Obsługujemy kilka nazw,
  // ale rekomendowana nazwa to REJESTR_APP_PASSWORD.
  return String(
    process.env.REJESTR_APP_PASSWORD
    || process.env.SITE_PASSWORD
    || process.env.APP_PASSWORD
    || ''
  );
}

export function isAuthEnabled() {
  return sitePassword().length > 0;
}

export function authCookieValue() {
  const password = sitePassword();
  return crypto
    .createHash('sha256')
    .update(`rejestr-finance-comparator:${password}`)
    .digest('hex');
}

function parseCookies(header) {
  const out = {};
  String(header || '').split(';').forEach(part => {
    const idx = part.indexOf('=');
    if (idx === -1) return;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
  });
  return out;
}

function safeEqual(a, b) {
  const aa = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  if (aa.length !== bb.length) return false;
  return crypto.timingSafeEqual(aa, bb);
}

export function checkPassword(input) {
  if (!isAuthEnabled()) return true;
  return safeEqual(String(input || ''), sitePassword());
}

export function hasValidAuthCookie(req) {
  if (!isAuthEnabled()) return true;
  const cookies = parseCookies(req?.headers?.get('cookie'));
  return safeEqual(cookies[AUTH_COOKIE_NAME], authCookieValue());
}

export function authRequiredJson() {
  return Response.json(
    { error: 'Brak autoryzacji. Odśwież stronę i zaloguj się hasłem.' },
    { status: 401 }
  );
}

export function makeAuthCookie(value, maxAge = COOKIE_MAX_AGE_SECONDS) {
  const encoded = encodeURIComponent(value || '');
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `${AUTH_COOKIE_NAME}=${encoded}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}
