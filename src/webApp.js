/**
 * Static files for the web app: /app (the LIFF page), /shared (modules used
 * by both server and browser) and /app/fonts. The page itself holds no data;
 * everything personal comes from /api/app after LINE sign-in.
 */
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.join(here, '..', 'web');
const FONTS = path.join(here, '..', 'assets', 'richmenu-src', 'fonts');

const CSP = [
  "default-src 'self'",
  "script-src 'self' https://static.line-scdn.net",
  "connect-src 'self' https://*.line.me https://*.line-scdn.net",
  "img-src 'self' data: https:",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ');

function headers(res) {
  res.set('Content-Security-Policy', CSP);
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'no-referrer');
}

export function registerWebApp(app, { maxAge = '10m' } = {}) {
  const page = (_req, res) => {
    headers(res);
    res.set('Cache-Control', 'no-cache');
    res.sendFile(path.join(WEB, 'app', 'index.html'));
  };
  app.get(['/app', '/app/'], page);
  app.use('/app/fonts', express.static(FONTS, { maxAge: '30d', immutable: true, fallthrough: false }));
  const opts = { maxAge, index: false, setHeaders: headers, fallthrough: false };
  app.use('/app', express.static(path.join(WEB, 'app'), opts));
  app.use('/shared', express.static(path.join(WEB, 'shared'), opts));
}
