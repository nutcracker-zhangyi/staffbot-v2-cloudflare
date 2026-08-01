import { manageSecurityHeaders, securityHeaders } from './security.js';

export const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };
export const HTML_HEADERS = { 'content-type': 'text/html; charset=utf-8', ...securityHeaders() };
export const MANAGE_HTML_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  ...manageSecurityHeaders()
};
export const TEXT_HEADERS = { 'content-type': 'text/plain; charset=utf-8' };
export const CSV_HEADERS = {
  'content-type': 'text/csv; charset=utf-8',
  'content-disposition': 'attachment',
  ...securityHeaders()
};

const SESSION_COOKIE = 'staffbot_admin_session';

export async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

export function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, ...securityHeaders(), ...extraHeaders } });
}

export function html(text) {
  return new Response(text, { headers: HTML_HEADERS });
}

export function manageDocument(text) {
  return new Response(text, { headers: MANAGE_HTML_HEADERS });
}

export function sessionCookieValue(cookieHeader) {
  const parts = cookieHeader.split(';').map((part) => part.trim());
  for (const part of parts) {
    const [key, ...rest] = part.split('=');
    if (key === SESSION_COOKIE) return decodeURIComponent(rest.join('='));
  }
  return '';
}

export function setSessionCookie(token, expiresAt) {
  return {
    'set-cookie': `${SESSION_COOKIE}=${encodeURIComponent(token)}; Expires=${new Date(expiresAt).toUTCString()}; Path=/; HttpOnly; Secure; SameSite=Lax`
  };
}

export function clearSessionCookie() {
  return {
    'set-cookie': `${SESSION_COOKIE}=; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/; HttpOnly; Secure; SameSite=Lax`
  };
}
