import { afterEach, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { initialLanguage, initialPreference, systemLanguage, LanguageProvider, localeFor, persistLanguage, useLanguage } from './i18n';

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
afterEach(() => {
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
});

function browser(language: string, saved: string | null, blocked = false) {
  const values = new Map<string, string>();
  if (saved !== null) values.set('cli-language', saved);
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    navigator: { language },
    localStorage: {
      getItem: (key: string) => { if (blocked) throw new Error('blocked'); return values.get(key) ?? null; },
      setItem: (key: string, value: string) => { if (blocked) throw new Error('blocked'); values.set(key, value); },
    },
  } });
  return values;
}

test('saved language takes precedence over a different navigator language', () => {
  browser('en-US', 'ko');
  expect(initialLanguage()).toBe('ko');
});
test('invalid stored language falls back to navigator language', () => {
  browser('en-US', 'fr');
  expect(initialLanguage()).toBe('en');
});
test('Korean regional navigator language selects Korean without storage', () => {
  browser('ko-KR', null, true);
  expect(initialLanguage()).toBe('ko');
});
test('SSR selects Korean without a browser', () => {
  Reflect.deleteProperty(globalThis, 'window');
  expect(initialLanguage()).toBe('ko');
});
test('preference writes the language code to storage', () => {
  const values = browser('ko-KR', 'ko');
  persistLanguage('en');
  expect(values.get('cli-language')).toBe('en');
});
test('blocked storage does not prevent changing preference', () => {
  browser('en-US', null, true);
  expect(() => persistLanguage('ko')).not.toThrow();
});
test('provider selects the language and translation branch while standalone hooks default to Korean', () => {
  browser('en-US', null);
  const Probe = () => { const { language, t } = useLanguage(); return createElement('output', { 'data-language': language }, t('KO_TOKEN', 'EN_TOKEN')); };
  expect(renderToStaticMarkup(createElement(LanguageProvider, null, createElement(Probe)))).toBe('<output data-language="en">EN_TOKEN</output>');
  expect(renderToStaticMarkup(createElement(Probe))).toBe('<output data-language="ko">KO_TOKEN</output>');
});
test('date locale follows the language code', () => {
  expect([localeFor('ko'), localeFor('en')]).toEqual(['ko-KR', 'en-US']);
});

test('system preference stays distinct from the resolved language', () => {
  const values = browser('ko-KR', null);
  expect(initialPreference()).toBe('system');
  persistLanguage('system');
  expect(values.get('cli-language')).toBe('system');
  expect(initialLanguage()).toBe('ko');
  Object.defineProperty(window.navigator, 'language', { value: 'en-US', configurable: true });
  expect(initialLanguage()).toBe('en');
  expect(initialPreference()).toBe('system');
});
test('system uses ordered supported browser languages with English fallback', () => {
  browser('ja-JP', null);
  expect(systemLanguage()).toBe('en');
  Object.defineProperty(window.navigator, 'languages', { value: ['ja-JP','ko-KR','en-US'], configurable: true });
  expect(systemLanguage()).toBe('ko');
  persistLanguage('en');
  expect(initialLanguage()).toBe('en');
});
