import React, { useEffect, useRef, useState } from 'react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { useLanguage } from './i18n';
import { productVersion, repositoryUrl, websiteUrl } from './product';
import { Select } from './select';
import type { LanguagePreference } from './i18n';

export function Button({ tone = 'secondary', className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: 'primary' | 'secondary' | 'danger' }) {
  return <button type="button" {...props} className={`button ${tone} ${className}`} />;
}
export function Panel({ children }: { children: ReactNode }) { return <section className="panel">{children}</section>; }
export function Icon({ name }: { name: string }) {
  const paths: Record<string, string> = { dashboard:'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z', installations:'M4 4h16v6H4z M4 14h16v6H4z M7 7h1 M7 17h1', sessions:'M4 5h16v14H4z M7 9l3 3-3 3 M13 15h4', operations:'M4 6h16 M4 12h16 M4 18h10', policies:'M12 3v4 M12 17v4 M3 12h4 M17 12h4 M8 8l8 8 M16 8l-8 8' };
  return <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name] ?? paths['sessions']}/></svg>;
}
export function SectionHead({ title, count, children }: { title: string; count?: number; children?: ReactNode }) { return <div className="section-head"><h2>{title}{count !== undefined && <span className="section-count">{count}</span>}</h2>{children}</div>; }
export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: string }) { return <span className={`badge ${tone}`}>{children}</span>; }
export function Notice({ children, tone = 'neutral' }: { children: ReactNode; tone?: string }) { return <div className={`notice ${tone}`} role={tone === 'error' ? 'alert' : 'status'}>{children}</div>; }
export function Facts({ items }: { items: readonly (readonly [string, ReactNode])[] }) { return <dl className="facts">{items.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>; }
export function Dialog({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const { t } = useLanguage();
  const ref = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const titleId = React.useId();
  useEffect(() => { const previous = document.activeElement; heading.current?.setAttribute('autofocus',''); ref.current?.showModal(); return () => { ref.current?.close(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus({preventScroll:true}); }; }, []);
  return <dialog ref={ref} className="app-dialog" aria-labelledby={titleId} onCancel={onClose}><header className="dialog-header"><h2 ref={heading} tabIndex={-1} id={titleId}>{title}</h2><Button onClick={onClose}>{t('닫기','Close')}</Button></header><div className="dialog-body stack">{children}</div></dialog>;
}
export function Brand() {
  return <div className="brand"><a className="brand-home" href={websiteUrl} target="_blank" rel="noopener noreferrer" aria-label="About herdr-cli-updater"><img className="brand-mark" src="/assets/symbol-sheep.png" width="256" height="256" alt=""/><span className="brand-wordmark">herdr-cli-updater</span></a><span className="product-version">v{productVersion}</span></div>;
}
export function ProjectLinks() {
  const { t } = useLanguage();
  const key = `cli-repository-clicked:${repositoryUrl}`;
  const [clicked, setClicked] = useState(() => { try { return localStorage.getItem(key)==='true'; } catch { return false; } });
  useEffect(()=>{
    const sync=()=>{try{setClicked(localStorage.getItem(key)==='true');}catch{/* Optional local click history. */}};
    window.addEventListener('storage',sync);window.addEventListener('cli-repository-clicked',sync);
    return ()=>{window.removeEventListener('storage',sync);window.removeEventListener('cli-repository-clicked',sync);};
  },[key]);
  const recordClick=()=>{setClicked(true);try{localStorage.setItem(key,'true');window.dispatchEvent(new Event('cli-repository-clicked'));}catch{/* The link still works without storage. */}};
  const label=t('GitHub 저장소 · 새 탭','GitHub repository · new tab');
  const note=t('노란 별은 이 브라우저의 클릭 기록이며 GitHub Star 여부가 아닙니다.','A yellow star records a click in this browser, not your GitHub Star status.');
  const content=<><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 .75a11.25 11.25 0 0 0-3.558 21.923c.563.104.768-.244.768-.542 0-.267-.01-.975-.015-1.913-3.13.68-3.79-1.508-3.79-1.508-.512-1.3-1.25-1.646-1.25-1.646-1.022-.698.078-.684.078-.684 1.13.08 1.725 1.16 1.725 1.16 1.004 1.72 2.633 1.223 3.274.935.102-.728.393-1.223.715-1.505-2.499-.284-5.126-1.25-5.126-5.562 0-1.23.439-2.233 1.16-3.02-.116-.284-.503-1.428.11-2.978 0 0 .945-.303 3.094 1.154A10.79 10.79 0 0 1 12 6.195c.956.004 1.92.13 2.82.379 2.148-1.457 3.091-1.154 3.091-1.154.615 1.55.228 2.694.112 2.978.722.787 1.158 1.79 1.158 3.02 0 4.323-2.631 5.275-5.138 5.554.404.348.766 1.034.766 2.084 0 1.505-.014 2.72-.014 3.089 0 .3.203.65.774.54A11.252 11.252 0 0 0 12 .75Z"/></svg><span>GitHub</span><svg className="project-star" viewBox="0 0 24 24" fill={clicked?'currentColor':'none'} stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" aria-hidden="true"><path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9Z"/></svg></>;
  return <div className="project-links"><div>{repositoryUrl?<a href={repositoryUrl} target="_blank" rel="noopener noreferrer" data-clicked={clicked} onClick={recordClick} title={`${label}. ${note}`} aria-label={`${label}. ${note}`}>{content}</a>:<button type="button" disabled>{content}</button>}</div>{!repositoryUrl&&<p className="muted">{t('저장소 주소 미설정','Repository URL not configured')}</p>}</div>;
}
export type ThemePreference = 'light' | 'dark' | 'system';
export function parseTheme(value: string | null): ThemePreference {
  return value === 'light' || value === 'dark' ? value : 'system';
}
export function Theme() {
  const { t } = useLanguage();
  const group = React.useId();
  const [theme, setTheme] = useState<ThemePreference>(() => { try { return parseTheme(localStorage.getItem('cli-theme')); } catch { return 'system'; } });
  useEffect(() => { const media = matchMedia('(prefers-color-scheme: dark)'); const apply = () => { document.documentElement.dataset['theme'] = theme === 'system' ? (media.matches ? 'dark' : 'light') : theme; }; apply(); media.addEventListener('change', apply); try { localStorage.setItem('cli-theme', theme); } catch { /* Storage is optional for theme only. */ } return () => media.removeEventListener('change', apply); }, [theme]);
  const options = [{value:'light',label:t('라이트','Light'),path:'M12 3v2m0 14v2M3 12h2m14 0h2M5.6 5.6 7 7m10 10 1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0'}, {value:'dark',label:t('다크','Dark'),path:'M20 13a8 8 0 0 1-9-9 8 8 0 1 0 9 9'}, {value:'system',label:t('시스템','System'),path:'M4 4h16v12H4zM12 16v4m-4 0h8'}] as const;
  return <fieldset className="theme-field"><legend>{t('테마','Appearance')}</legend><div className="theme-options">{options.map(option=><label key={option.value} title={option.label}><input type="radio" name={group} value={option.value} checked={theme===option.value} onChange={()=>setTheme(option.value)}/><span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={option.path}/></svg><span>{option.label}</span></span></label>)}</div></fieldset>;
}
export function Preferences() {
  const { preference, setLanguage, t } = useLanguage();
  return <section className="preferences" aria-label={t('화면 설정','Display settings')}><div className="preferences-content"><Select<LanguagePreference> side="right" label={t('언어','Language')} value={preference} onChange={setLanguage} options={[{value:'system',label:t('시스템','System'),description:t('브라우저 언어 따르기','Follow browser language')},{value:'ko',label:'한국어'},{value:'en',label:'English'}]}/><Theme/></div></section>;
}
