import React, { createContext, useContext, useEffect, useState } from 'react';

export type Language = 'ko' | 'en';
export type LanguagePreference = Language | 'system';
export const localeFor = (language: Language): 'ko-KR' | 'en-US' => language === 'ko' ? 'ko-KR' : 'en-US';

export function initialPreference(): LanguagePreference {
  if (typeof window === 'undefined') return 'system';
  try {
    const saved = window.localStorage.getItem('cli-language');
    if (saved === 'ko' || saved === 'en') return saved;
  } catch { /* Storage may be blocked by the browser. */ }
  return 'system';
}

export function systemLanguage(): Language {
  if (typeof window === 'undefined') return 'ko';
  for (const locale of window.navigator.languages?.length ? window.navigator.languages : [window.navigator.language]) {
    const code = locale.toLowerCase().split('-')[0];
    if (code === 'ko' || code === 'en') return code;
  }
  return 'en';
}

export function initialLanguage(): Language {
  const preference = initialPreference();
  return preference === 'system' ? systemLanguage() : preference;
}

export function persistLanguage(language: LanguagePreference): void {
  if (typeof window === 'undefined') return;
  try { window.localStorage.setItem('cli-language', language); }
  catch { /* The in-memory preference still works without storage. */ }
}

type LanguageContext = {
  language: Language;
  preference: LanguagePreference;
  setLanguage: (language: LanguagePreference) => void;
  t: (ko: string, en: string) => string;
};
const Context = createContext<LanguageContext>({ language: 'ko', preference: 'system', setLanguage: () => {}, t: ko => ko });

export function LanguageProvider({ children }: { children: React.ReactNode }) {
  const [preference, setLanguage] = useState<LanguagePreference>(initialPreference);
  const [system, setSystem] = useState<Language>(systemLanguage);
  const language = preference === 'system' ? system : preference;
  useEffect(() => {
    const changed = () => setSystem(systemLanguage());
    window.addEventListener('languagechange', changed);
    return () => window.removeEventListener('languagechange', changed);
  }, []);
  useEffect(() => { persistLanguage(preference); }, [preference]);
  useEffect(() => {
    document.documentElement.lang = language;
    const title = 'Console | herdr-cli-updater';
    const name = 'herdr-cli-updater Console';
    const description = language === 'ko'
      ? '이 컴퓨터에 설치된 CLI, 터미널 세션과 업데이트를 관리하는 로컬 서비스입니다.'
      : 'Local management app for installed CLIs, terminal sessions and updates on this computer.';
    document.title = title;
    for (const [selector,content] of [
      ['meta[name="application-name"]',name], ['meta[name="description"]',description],
      ['meta[property="og:site_name"]',name], ['meta[property="og:title"]',title],
      ['meta[property="og:description"]',description],
    ] as const) document.querySelector(selector)?.setAttribute('content',content);
  }, [language]);
  return <Context.Provider value={{ language, preference, setLanguage, t: (ko, en) => language === 'ko' ? ko : en }}>{children}</Context.Provider>;
}

export const useLanguage = () => useContext(Context);
