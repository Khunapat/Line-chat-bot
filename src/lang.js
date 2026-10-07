/**
 * The language of the chat being handled right now. Each webhook event and
 * each cron push runs inside withLang(lang, ...), so card builders and reply
 * text pick the right language without passing it through every call, and
 * two chats handled at the same time never mix languages.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { t, normalizeLang } from '../web/shared/i18n.js';

const als = new AsyncLocalStorage();

export function withLang(lang, fn) {
  return als.run(normalizeLang(lang), fn);
}

export function currentLang() {
  return als.getStore() || 'th';
}

/** Translate in the current chat's language. */
export function L(key, vars) {
  return t(currentLang(), key, vars);
}
