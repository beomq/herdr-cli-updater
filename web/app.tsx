import React, { useEffect, useRef, useState } from 'react';
import type { AppCommand, AppSnapshot, AppOperation, ManagedSession, PaneSessionPolicy, UpdatePolicy } from '../src/app/types';
import type { Installation } from '../src/protocol';
import { AccessError, exchangeFragment, newerSnapshot, readSnapshot, sendCommand } from './client';
import { Badge, Button, Dialog, Facts, Icon, Notice, Panel, SectionHead, Brand, Preferences, ProjectLinks } from './primitives';
import { Select } from './select';
import { NativeRestarts } from './native-restarts';
import { Catalog } from './catalog';
import { CatalogUpdates, CatalogUpdateHistory, catalogHistory, usesCatalogUpdatePolicy } from './catalog-updates';
import { PaneSessionChoice, paneSessionLabels } from './pane-session-choice';
import { installationError } from './install-status';
import { AgentMark } from './agent-mark';
import { catalogContainsInstallation, catalogSnapshot, dashboardSummary, engineReviewBinding, engineUpdateAction, installedCatalog, outdatedSessions, supportedSnapshot } from './dashboard';
import { CatalogDashboardRow, UpdateControl, VersionEvidence } from './catalog-dashboard';
import { CatalogBulkActions } from './catalog-bulk';
import { AutomationSettings, AutomationToggle, workspaceBusy } from './automation-settings';
import type { CatalogId } from '../src/app/catalog-types';
import { isSupportedCli } from '../src/app/catalog-types';
import './workspace.css';

import { LanguageProvider, localeFor, useLanguage } from './i18n';

type Act = (command: AppCommand) => Promise<boolean>;
export type View = 'updates' | 'sessions' | 'history' | 'add';
const primaryViews = ['updates','sessions','history'] as const;
const legacyViews: Readonly<Record<string,View>> = {dashboard:'updates',policies:'updates',operations:'history',installations:'add'};
export function parseView(value: string | null): View {
  if(value==='updates'||value==='sessions'||value==='history'||value==='add')return value;
  return (value!==null&&Object.hasOwn(legacyViews,value)?legacyViews[value]:undefined)??'updates';
}
const viewIcons: Record<View,string> = {updates:'dashboard',sessions:'sessions',history:'operations',add:'installations'};
const families: Record<Installation['family']|'gjc'|'opencode',string> = {omo:'OmO',omp:'OMP',pi:'Pi',claude:'Claude',codex:'Codex',gjc:'Gajae Code',opencode:'OpenCode',agy:'Antigravity',cursor:'Cursor',grok:'Grok'};
function useCopy() {
const {language,t} = useLanguage();
const viewNames: Record<View,string> = {updates:t("업데이트", "Updates"),sessions:t("터미널 세션", "Terminal sessions"),history:t("기록", "History"),add:t("CLI 추가", "Add CLI")};
const sessionNames: Record<ManagedSession['state'],string> = {starting:t("시작 중", "Starting"),ready:t("입력 가능", "Ready for input"),working:t("작업 중", "Working"),waiting:t("승인 대기", "Awaiting approval"),stopping:t("안전하게 종료 중", "Stopping safely"),stopped:t("종료됨", "Stopped"),restarting:t("다시 시작 중", "Restarting"),failed:t("실패", "Failed"),unknown:t("상태 확인 필요", "State needs checking")};
const stages: Record<AppOperation['stage'],string> = {preparing:t("업데이트 준비 중", "Preparing update"),ready:t("업데이트 승인 대기", "Awaiting update approval"),waiting:t("작업이 끝나기를 기다리는 중", "Waiting for work to finish"),stopping:t("관리 세션 종료 중", "Stopping managed sessions"),updating:t("설치 업데이트 중", "Updating installation"),verifying:t("설치 검증 중", "Verifying installation"),restarting:t("저장된 세션 다시 시작 중", "Restarting saved sessions"),completed:t("검증 완료", "Verified"),failed:t("실패", "Failed"),uncertain:t("결과 확인 필요", "Result needs checking"),cancelled:t("취소됨", "Cancelled")};
const kinds: Record<AppOperation['kind'],string> = {prepare:t("업데이트 준비", "Prepare update"),update:t("업데이트", "Update"),stop:t("세션 종료", "Stop session"),restart:t("세션 다시 시작", "Restart session"),'native-restart':t("Codex 세션 다시 시작","Restart Codex session")};
const modes: Record<UpdatePolicy['mode'],string> = {off:t("사용 안 함", "Off"),check:t("최신 버전 확인만", "Check latest version only"),update:t("확인 후 업데이트", "Check and update"), 'update-and-restart':t("업데이트 후 관리 세션 재시작", "Update and restart managed sessions")};
const stamp = (value: number | null) => value === null ? t("아직 없음", "Not yet") : new Date(value).toLocaleString(localeFor(language));
const installed = (i: Installation | undefined) => i?.installedVersion.kind === 'known' ? i.installedVersion.version : t("확인되지 않음", "Unknown");
const title = (snapshot: AppSnapshot, id: string) => { const i=snapshot.installations.find(x=>x.installationId===id); return i ? families[i.family] : t("확인되지 않은 설치", "Unknown installation"); };
const errorMessages: Record<string,string> = {
  restart_unverified:t('일부 세션의 재시작을 확인하지 못했습니다. 아래 복구 안내를 확인하세요.','Some session restarts could not be verified. Review the recovery guidance below.'),
  worker_unavailable:t('업데이트 엔진에 연결하지 못했습니다. 서비스 다시 연결로 재시도하세요.','The update engine could not be reached. Use Reconnect service to retry.'),
  manual_removal_required:t('이 설치는 앱에서 직접 삭제할 수 없습니다. 지원하지 않는 설치 방식이거나 npm/Bun 설치 출처를 확인하지 못했습니다. CLI 상세의 공식 안내를 확인하세요.','This installation cannot be removed here. Its installation method is unsupported or its npm/Bun ownership could not be verified. See the official guide in CLI details.'),
  disable_automation_before_removal:t('이 설치의 자동 업데이트를 먼저 꺼주세요.','Turn off automatic updates for this installation first.'),
  running_sessions:t('이 CLI를 사용하는 세션이 있습니다. 직접 종료한 뒤 다시 검토하세요.','Sessions are using this CLI. Close them before reviewing removal again.'),
  installation_referenced:t('이 설치를 참조하는 설정이 있습니다. 설정 경로를 수정한 뒤 다시 검토하세요.','Configuration references this installation. Correct the paths and review again.'),
  session_activity_unverified:t('백그라운드 작업까지 끝났는지 확인할 수 없어 재시작하지 않았습니다.','Restart was not attempted because background-work completion could not be verified.'),
  session_empty:t('아직 메시지가 없는 대화라 재개할 게 없어 재시작하지 않았습니다. 창에서 직접 다시 여세요.','The conversation has no messages yet, so there is nothing to resume. Reopen it in the pane yourself.'),
  screen_not_idle:t('실행 시점에 화면이 입력 대기가 아니거나 CPU가 바빠 재시작하지 않았습니다. 잠시 뒤 다시 검토하세요.','At run time the screen was not at a prompt or the process was busy, so it was not restarted. Review again shortly.'),
  resume_not_observed:t('종료 후 같은 대화가 다시 열리는 것을 확인하지 못했습니다. 창 화면을 확인하세요.','The conversation was not observed reopening after exit. Check the pane.'),
  pane_changed:t('창의 프로세스가 바뀌어 재시작하지 않았습니다. 최신 상태에서 다시 검토하세요.','The pane process changed, so it was not restarted. Review the latest state.'),
  agent_blocked:t('세션이 응답을 기다리고 있어 재시작하지 않았습니다.','The session is waiting for an answer, so it was not restarted.'),
  idle_wait_timeout:t('30분 안에 작업이 끝나지 않아 그대로 두었습니다.','Work did not finish within 30 minutes, so the session was left alone.'),
  pane_restart_in_progress:t('이 창의 재시작이 이미 진행 중입니다.','A restart for this pane is already in progress.'),
  session_binding_changed:t('창의 프로세스나 대화가 바뀌었습니다. 새 상태를 확인하세요.','The pane process or conversation changed. Refresh its state.'),
  resume_id_mismatch:t('다시 열린 대화가 원래 대화와 달라 완료로 처리하지 않았습니다.','The resumed conversation differs from the original; restart is not verified.'),
  removal_in_progress:t('삭제 작업이 진행 중입니다. 완료 후 다시 시도하세요.','Removal is in progress. Try again after it finishes.'),
  inspect_interrupted_removal:t('중단된 삭제 결과를 먼저 확인하세요. 자동으로 재실행하지 않습니다.','Inspect the interrupted removal first. It will not be retried automatically.'),
  stale_removal_plan:t('삭제 계획이 바뀌었습니다. 최신 상태에서 다시 검토하세요.','The removal plan changed. Review the latest state.'),
  removal_target_changed:t('삭제 대상 파일이 변경됐습니다. 다시 검토하세요.','The removal target changed. Review it again.'),
  invalid_request: t("입력 내용을 확인하세요.", "Check your input."),
  unauthorized: t("접근이 만료되었습니다. CLI에서 웹 화면을 다시 여세요.", "Access expired. Reopen the dashboard from the CLI."),
  not_found: t("선택한 항목이 없어졌습니다. 상태를 다시 확인하세요.", "The selected item no longer exists. Check the state again."),
  conflict: t("선택 이후 상태가 바뀌었습니다. 최신 상태에서 다시 검토하세요.", "State changed after selection. Review the latest state."),
  busy: t("진행 중인 작업이 있어 기다려야 합니다. 작업을 강제로 중단하지 않습니다.", "An operation is in progress. Wait for it; work will not be forcibly interrupted."),
  unsupported: t("이 설치에서는 해당 기능을 지원하지 않습니다.", "This installation does not support this feature."),
  unavailable: t("서비스 또는 최신 버전 정보를 확인할 수 없습니다.", "The service or latest version information is unavailable."),
  timeout: t("응답 시간을 초과했습니다. 실제 작업 상태를 먼저 확인하세요.", "The response timed out. Check the actual operation state first."),
  protocol: t("서비스와 화면의 데이터 형식이 맞지 않습니다.", "Service and dashboard data formats do not match."),
  uncertain: t("작업 결과가 불확실합니다. 다시 실행하지 말고 상태를 확인하세요.", "The operation result is uncertain. Do not rerun it; check the state."),
  source_changed: t("설치 정보가 바뀌었습니다. 준비 결과를 다시 확인하세요.", "Installation information changed. Review preparation again."),
  cleanup_failed: t("정리가 완료되지 않았습니다. 작업 상태를 확인하세요.", "Cleanup did not finish. Check the operation state."),
  cancel_unsafe: t("이미 변경이 시작되어 안전하게 취소할 수 없습니다.", "Changes have already started; safe cancellation is unavailable."),
  update_failed: t("업데이트에 실패했습니다.", "Update failed."),
  verification_failed: t("설치 검증에 실패했습니다.", "Installation verification failed."),
  waiting_for_quiet: t("관리 세션이 작업 중입니다. 안전한 종료 조건을 기다립니다.", "Managed sessions are working. Waiting for safe shutdown conditions."),
  external_consumers: t("외부 세션이 이 설치를 사용 중입니다. 자동으로 종료하지 않습니다.", "External sessions are using this installation. They will not be stopped automatically."),
  policy_off: t("자동화가 꺼져 있습니다.", "Automation is off."),
  admission_sealed: t("설치 작업 중이므로 새 세션을 받지 않습니다.", "New sessions are blocked during installation work."),
  host_unavailable: t("세션 연결이 없어 실행 결과를 확인할 수 없습니다.", "The session connection is missing; execution results are unavailable."),
  process_observation_unavailable: t("프로세스를 다시 관찰하지 못했습니다. 마지막 관찰 시각 이후의 실행 여부는 확인되지 않았습니다.", "Processes could not be observed again. Running state since the last observation is unknown."),
  observation_data: t("서비스의 관찰 데이터를 읽을 수 없습니다.", "Unable to read service observations."),
  response_lost: t("요청 응답을 잃었습니다. 자동으로 다시 보내지 않습니다. 관찰값과 작업 결과를 확인하세요.", "The response was lost. This request will not be resent automatically. Check observations and operation results."),
};
const explainLocalized = (code: string | null) => code ? errorMessages[code] ?? installationError(code,t) ?? t('서비스가 확인이 필요한 상태를 보고했습니다. 작업 상태를 확인하세요.', 'The service reported a state that needs attention. Check the operation state.') : null;
return {t,viewNames,sessionNames,stages,kinds,modes,stamp,installed,title,explain: explainLocalized};
}
export const lastVerifiedUpdate = (operations: readonly AppOperation[], installationId: string) => operations.reduce<number|null>((latest,o)=>o.installationId===installationId && o.kind==='update' && o.installedAt!=null ? Math.max(latest??0,o.installedAt) : latest,null);
  const tone = (state: string) => state==='completed' ? 'success' : state==='failed' ? 'error' : ['unknown','uncertain','waiting','ready'].includes(state) ? 'warning' : 'neutral';

export function App() { return <LanguageProvider><AppContent/></LanguageProvider>; }

function AppContent() {
  const {t,explain} = useCopy();
  const [snapshot,setSnapshot] = useState<AppSnapshot|null>(null);
  const current = useRef<AppSnapshot|null>(null);
  const [connection,setConnection] = useState<'loading'|'live'|'offline'|'access'>('loading');
  const [accessAttempt,setAccessAttempt]=useState(0);
  const [accessCopy,setAccessCopy]=useState<'idle'|'copied'|'unavailable'>('idle');
  const [pending,setPending] = useState(false);
  const busy = useRef(false);
  const [notice,setNotice] = useState<string|null>(null);
  const [uncertain,setUncertain] = useState(false);
  const [observed,setObserved] = useState(false);
  const [view,setView] = useState<View>(()=>{try{return parseView(localStorage.getItem('cli-view'));}catch{return 'updates';}});
  useEffect(()=>{try{localStorage.setItem('cli-view',view);}catch{/* Tab persistence is optional. */}},[view]);
  const accept = (next: AppSnapshot) => {const accepted=newerSnapshot(current.current,next);current.current=accepted;setSnapshot(accepted);setObserved(true);};
  useEffect(() => {
    let disposed=false; let events: EventSource | undefined;
    const boot = async () => {
      try {
        await exchangeFragment(); const next=await readSnapshot(); if(disposed) return; accept(next); setConnection('live');
        events = new EventSource('/api/events', {withCredentials:true});
        events.addEventListener('snapshot', event => { try { const next:AppSnapshot=JSON.parse((event as MessageEvent).data); if(!disposed){accept(next);setConnection('live');} } catch {setNotice('observation_data');setConnection('offline');} });
        events.onerror = () => { if(disposed)return; setConnection('offline'); void readSnapshot().then(next=>{if(!disposed)accept(next);}).catch(error=>{if(!disposed && error instanceof AccessError){events?.close();setConnection('access');}}); };
      } catch(error) {if(!disposed)setConnection(error instanceof AccessError?'access':'offline');}
    };
    void boot(); return ()=>{disposed=true;events?.close();};
  }, [accessAttempt]);
  const observe = async () => { try {accept(await readSnapshot());setConnection('live');}catch(error){setConnection(error instanceof AccessError?'access':'offline');} };
  const act:Act = async command => {
    if(busy.current || uncertain || connection!=='live' || (current.current?.service!=='ready'
      &&!(command.kind==='refresh'&&current.current?.service==='unavailable'))) return false;
    busy.current=true;setPending(true);setNotice(null);
    const requestId=crypto.randomUUID();
    try {const result=await sendCommand(command,requestId); accept(result.snapshot); if(!result.ok){setNotice(result.error);return false;}return true;}
    catch(error){if(error instanceof AccessError)setConnection('access');else {setUncertain(true);setObserved(false);setNotice('response_lost');}return false;}
    finally{busy.current=false;setPending(false);}
  };
  const disabled=pending || uncertain || connection!=='live' || snapshot?.service!=='ready';
  return <Surface snapshot={snapshot} view={view} onView={setView} act={act} disabled={disabled}>
    {connection==='loading'&&<Notice>{t("설치와 세션 상태를 읽는 중입니다.", "Reading installation and session state.")}</Notice>}
    {connection==='access'&&<Notice tone="warning"><div className="stack">
      <strong>{t('이 브라우저를 연결해 주세요.','Connect this browser.')}</strong>
      <p>{t('처음 접속하거나 인증 기간이 끝났습니다. 터미널에서 아래 명령을 실행하면 안전한 접속 창이 열립니다.','This is a new browser or its access has expired. Run this command in your terminal to open an authenticated window.')}</p>
      <code className="path">cli-updater open</code>
      <div className="cluster"><Button onClick={async()=>{try{await navigator.clipboard.writeText('cli-updater open');setAccessCopy('copied');}catch{setAccessCopy('unavailable');}}}>{accessCopy==='copied'?t('복사됨','Copied'):t('명령 복사','Copy command')}</Button><Button onClick={()=>{setConnection('loading');setAccessAttempt(value=>value+1);}}>{t('연결 상태 다시 확인','Check connection again')}</Button></div>
      {accessCopy==='unavailable'&&<p>{t('위 명령을 선택해 직접 복사해 주세요.','Select and copy the command above manually.')}</p>}
      <p>{t('한 번 연결하면 같은 로컬 주소에서 최대 30일간 유지됩니다. 서비스 재시작만으로 로그아웃되지 않습니다.','Once connected, access lasts up to 30 days at this local address. Restarting the service does not sign you out.')}</p>
    </div></Notice>}
    {connection==='offline'&&<Notice tone="warning">{t("서비스 연결이 끊겼습니다. 표시된 값은 마지막 관찰값입니다.", "Disconnected from the service. Values shown are the last observations.")} <Button onClick={()=>void observe()}>{t("상태 다시 확인", "Check state again")}</Button></Notice>}
    {snapshot?.service!=='ready'&&snapshot&&<Notice tone="warning">{t("서비스가 작업을 받을 준비가 되지 않았습니다.", "The service is not ready to accept operations.")}{snapshot.service==='unavailable'&&<Button disabled={pending||uncertain||connection!=='live'} onClick={()=>void act({kind:'refresh'})}>{t('서비스 다시 연결','Reconnect service')}</Button>}</Notice>}
    {snapshot?.failure&&<Notice tone="error">{explain(snapshot.failure)}</Notice>}
    {notice&&<Notice tone={uncertain?'warning':'error'}>{explain(notice)}{uncertain&&<><Button onClick={()=>void observe()}>{t("현재 상태 관찰", "Observe current state")}</Button><Button disabled={!observed} onClick={()=>{setUncertain(false);setNotice(null);}}>{t("관찰 결과를 확인했습니다", "I have reviewed the observations")}</Button></>}</Notice>}
    {pending&&<Notice>{t("요청 응답을 기다리는 중입니다. 중복 요청은 보내지 않습니다.", "Waiting for the response. Duplicate requests will not be sent.")}</Notice>}
  </Surface>;
}

export function Surface({snapshot:observed,view,onView,act,disabled,children}:{snapshot:AppSnapshot|null;view:View;onView:(view:View)=>void;act:Act;disabled:boolean;children?:React.ReactNode}) {
  const snapshot=observed?supportedSnapshot(observed):null;
  const {t,viewNames,stamp} = useCopy();
  const [catalogDetail,setCatalogDetail]=useState<CatalogId|null>(null);
  const openCatalog=(id:CatalogId)=>{setCatalogDetail(id);onView('add');};
  const navigation=useRef<HTMLDialogElement>(null);
  const menuButton=useRef<HTMLButtonElement>(null);
  const navigationId=React.useId();
  useEffect(()=>{const media=matchMedia('(max-width: 768px)'); const sync=()=>{const menu=navigation.current;if(!menu)return;menu.close();menu.open=!media.matches;}; sync();media.addEventListener('change',sync);return()=>media.removeEventListener('change',sync);},[]);
  const closeMenu=()=>{navigation.current?.close();menuButton.current?.focus();};
  const choose=(key:View)=>{setCatalogDetail(null);onView(key);if(matchMedia('(max-width: 768px)').matches)closeMenu();};
  return <div className="shell workspace-shell"><a className="skip" href="#main">{t("본문으로 이동", "Skip to content")}</a>
    <header className="mobile-header"><Brand/><button className="button" ref={menuButton} aria-haspopup="dialog" aria-controls={navigationId} onClick={()=>{const title=navigation.current?.querySelector<HTMLElement>('.navigation-brand');title?.setAttribute('autofocus','');navigation.current?.showModal();}}>{t('메뉴 및 설정','Menu and settings')}</button></header>
    <dialog ref={navigation} id={navigationId} className="rail workspace-navigation" aria-label={t('관리 메뉴 및 화면 설정','Management menu and display settings')} onCancel={closeMenu}>
      <div className="navigation-brand" tabIndex={-1}><Brand/><p className="eyebrow">{t("내 컴퓨터의 CLI 워크스페이스", "CLI workspace on this computer")}</p></div>
      <nav aria-label={t("관리 화면", "Management views")}>{primaryViews.map(key=><button key={key} data-view={key} aria-current={view===key||(key==='updates'&&view==='add')?'page':undefined} onClick={()=>choose(key)}><Icon name={viewIcons[key]}/>{viewNames[key]}</button>)}</nav>
      <div className="rail-footer"><Preferences/><ProjectLinks/></div><Button className="mobile-menu-close" onClick={closeMenu}>{t('메뉴 닫기','Close menu')}</Button>
    </dialog>
    <main id="main" tabIndex={-1}><div className="topbar"><span>{t("로컬 워크스페이스", "Local workspace")} <span className="muted">/ {viewNames[view]}</span></span><Badge tone={disabled||snapshot?.observationFailure?"neutral":"success"}>{snapshot?.observationFailure?t("프로세스 관찰 지연", "Process observation delayed"):disabled?t("관찰 / 연결 확인", "Check observations / connection"):t("서비스 연결됨", "Service connected")}</Badge></div><div className="content"><header className="page-head"><div><h1>{viewNames[view]}</h1><p className="muted">{view==='add'?t('공식 출처와 설치 계획을 검토해 CLI를 설치하세요.','Review official sources and installation plans to install a CLI.'):view==='sessions'?t('herdr 창에서 실행 중인 CLI와 실행 버전을 확인합니다.','Review CLIs running in herdr panes and their running versions.'):view==='history'?t('업데이트 작업의 진행과 결과를 확인합니다.','Review update progress and outcomes.'):t("CLI를 선택해 버전, 실행 세션과 자동화를 관리하세요.", "Choose a CLI to manage versions, running sessions and automation.")}</p></div><div className="cluster">{view==='add'&&<Button data-action="back-to-updates" onClick={()=>choose('updates')}>← {viewNames.updates}</Button>}{snapshot&&view!=='updates'&&<Button disabled={disabled} onClick={()=>void act({kind:'refresh'})}>{t("목록 새로고침", "Refresh list")}</Button>}</div></header>{snapshot?.observationFailure&&<Notice tone="warning">{t("세션은 마지막 관찰값입니다. 현재 실행 여부는 확인되지 않았습니다. 마지막 성공:", "Sessions show the last observations; running state is unknown. Last success:")} {snapshot.observedAt==null?t("확인 불가", "Unavailable"):stamp(snapshot.observedAt)}</Notice>}{children}{snapshot&&(view==='updates'?<Workspace snapshot={snapshot} guardSnapshot={observed??snapshot} act={act} disabled={disabled} onView={onView} onOpenCatalog={openCatalog}/>:view==='add'?<Catalog snapshot={snapshot} act={act} disabled={disabled} initialDetailId={catalogDetail}/>:view==='sessions'?<Sessions snapshot={snapshot} act={act} disabled={disabled}/>:<Operations snapshot={snapshot} guardSnapshot={observed??snapshot} act={act} disabled={disabled}/>)}</div></main></div>;
}
export function installationSnapshot(snapshot:AppSnapshot, installationId:string):AppSnapshot {
  return {...snapshot,installations:snapshot.installations.filter(i=>i.installationId===installationId),managed:snapshot.managed.filter(s=>s.installationId===installationId),external:snapshot.external.filter(s=>s.installationId===installationId),operations:snapshot.operations.filter(o=>o.installationId===installationId),policies:snapshot.policies.filter(p=>p.installationId===installationId)};
}
type DetailTab='overview'|'sessions'|'history'|'automation';
export function Workspace({snapshot,guardSnapshot=snapshot,act,disabled,onView,onOpenCatalog}:{snapshot:AppSnapshot;guardSnapshot?:AppSnapshot;act:Act;disabled:boolean;onView:(view:View)=>void;onOpenCatalog?:(id:CatalogId)=>void}) {
  const {t}=useCopy();
  const [search,setSearch]=useState('');
  const summary=dashboardSummary(snapshot);
  const outside=snapshot.external.filter(s=>s.processState!=='exited'&&!s.herdrPane);
  const catalog=installedCatalog(snapshot);
  const query=search.toLowerCase().trim();
  const engineOnly=snapshot.installations.filter(i=>!catalog.some(entry=>catalogContainsInstallation(entry,i)));
  const matches=(i:Installation)=>[families[i.family],i.executableRealpath,i.owner.kind==='unknown'?'':i.owner.prefix].join(' ').toLowerCase().includes(query);
  const catalogVisible=catalog.filter(entry=>[entry.name,entry.executable,entry.installed?.path,...(entry.installations??[]).map(row=>row.path)].join(' ').toLowerCase().includes(query)||engineOnly.some(i=>i.family===entry.id&&matches(i)));
  const visible=engineOnly.filter(i=>!catalog.some(entry=>entry.id===i.family)&&matches(i));
  const engineFamilies=[...new Set(visible.map(i=>i.family))];
  const route=(i:Installation)=><EngineRoute key={i.installationId} installation={i} snapshot={snapshot} act={act} disabled={disabled}/>;
  return <div className="workspace-list">
    <div className="workspace-toolbar"><CatalogBulkActions snapshot={snapshot} guardSnapshot={guardSnapshot} act={act} disabled={disabled}/><AutomationSettings snapshot={guardSnapshot} act={act} disabled={disabled}/></div>
    <section className="dashboard-summary" aria-label={t('현재 상태 요약','Current status summary')}>
      <div><span>{t('새 버전 있는 CLI','CLIs with new versions')}</span><strong>{summary.updates}</strong><small>{summary.unchecked?t('추가 확인 필요','More checks needed')+' · '+summary.unchecked:t('마지막 조회 기준','From the last checks')}</small></div>
      <button onClick={()=>onView('history')}><span>{t('진행 및 확인할 작업','Open operations')}</span><strong>{summary.operations}</strong><small>{t('업데이트 기록 보기','View update history')} →</small></button>
      <button onClick={()=>onView('sessions')}><span>{t('실행 중 세션','Active sessions')}</span><strong>{summary.sessions??'—'}</strong><small>{summary.sessions===null?t('관찰 결과 확인 필요','Observation unavailable'):summary.unknownSessions?t('상태 미확인','Unknown state')+' · '+summary.unknownSessions:t('터미널 세션 보기','View terminal sessions')} →</small></button>
      <button data-metric="outdated-sessions" onClick={()=>onView('sessions')}><span>{t('적용 필요 세션','Sessions to apply')}</span><strong>{summary.outdated??'—'}</strong><small>{summary.outdated===null?t('관찰 결과 확인 필요','Observation unavailable'):summary.outdated?t('예전 버전으로 실행 중 · 재시작 검토','Running an older version · review restart'):t('모두 현재 설치 버전','All on the installed version')} →</small></button>
    </section>
    <div className="workspace-toolbar"><div className="stack"><SectionHead title={t('설치된 CLI','Installed CLIs')} count={summary.installed}/><p className="muted">{t('실행 여부와 관계없이 발견된 설치를 표시합니다. 최신 확인·업데이트 지원은 설치 방식에 따라 다릅니다.','Discovered installations are shown whether running or not. Check and update support depends on the installation method.')}</p></div><Button data-action="add-cli" onClick={()=>onView('add')}>+ {t('CLI 추가','Add CLI')}</Button></div>
    {summary.installed>1&&<label className="field workspace-search">{t('CLI 또는 설치 경로 검색','Search CLI or installation path')}<input type="search" value={search} onChange={e=>setSearch(e.target.value)}/></label>}
    {!visible.length&&!catalogVisible.length&&<Notice>{summary.installed?t('검색 결과가 없습니다.','No matching installations.'):t('발견된 CLI 설치가 없습니다. CLI 설치 목록에서 검색 범위를 확인하세요.','No CLI installations discovered. Check the CLI installation catalog.')}</Notice>}
    {catalogVisible.map(entry=>{const scoped=catalogSnapshot(snapshot,entry);return <CatalogDashboardRow key={entry.id} entry={entry} snapshot={scoped} guardSnapshot={guardSnapshot} act={act} disabled={disabled} sessions={<Sessions snapshot={scoped} act={act} disabled={disabled}/>} history={<Operations snapshot={scoped} guardSnapshot={guardSnapshot} act={act} disabled={disabled}/>} automation={<Policies snapshot={scoped} act={act} disabled={disabled||workspaceBusy(guardSnapshot)} onOpenCatalog={onOpenCatalog}/>} routes={engineOnly.some(i=>i.family===entry.id)?engineOnly.filter(i=>i.family===entry.id).map(route):undefined}/>;})}
    {engineFamilies.map(family=>{const rows=visible.filter(i=>i.family===family);return rows.length===1?route(rows[0]!):<section className="cli-entry" key={family} data-engine-family={family}><div className="cli-row"><h2 className="cli-heading"><AgentMark agent={family} size={24}/>{families[family]}<Badge>{rows.length} {t('개 설치 위치','installation paths')}</Badge></h2></div><div className="cli-routes">{rows.map(route)}</div></section>;})}
    {outside.length>0&&<p className="muted">{t(`herdr 밖에서 실행 중인 CLI ${outside.length}개는 관리하지 않습니다(일반 터미널, ChatGPT, 브라우저 확장 등).`,`${outside.length} CLI processes outside herdr are not managed (plain terminals, ChatGPT, browser extensions).`)}</p>}
  </div>;
}
function EngineRoute({installation:i,snapshot,act,disabled}:{installation:Installation;snapshot:AppSnapshot;act:Act;disabled:boolean}) {
  const {t,installed,stamp,explain}=useCopy();
  const [expanded,setExpanded]=useState(false);
  const [tab,setTab]=useState<DetailTab>('overview');
  const detailId=React.useId();
  const tabs:Record<DetailTab,string>={overview:t('개요','Overview'),sessions:t('세션','Sessions'),history:t('기록','History'),automation:t('자동화','Automation')};
  const open=(next:DetailTab)=>{setExpanded(true);setTab(next);};
  const scoped=installationSnapshot(snapshot,i.installationId);
  const active=scoped.managed.filter(s=>['starting','ready','working','waiting','stopping','restarting'].includes(s.state));
  const policy=scoped.policies[0];const check=i.lastCheck?.result;
  const action=engineUpdateAction(i,snapshot.operations);
  const status=!check?t('최신 확인 전','Not checked'):check.kind==='update-available'?t('새 버전 있음','New version available'):check.kind==='up-to-date'?t('최신 버전','Up to date'):t('최신 조회 실패','Latest check failed');
  const latest=check?.kind==='update-available'?check.availableVersion:check?.kind==='up-to-date'?check.installedVersion:'—';
  const checkLatest=()=>void act({kind:'check',installationId:i.installationId});
  const update=()=>{if(action.kind==='update')void act({kind:'prepare',installationId:i.installationId}).then(ok=>{if(ok)open('history');});else open('history');};
  return <section className="cli-entry" data-engine-installation={i.installationId}>
    <div className="cli-row"><div className="cli-identity"><h2 className="cli-heading"><AgentMark agent={i.family} size={24}/>{families[i.family]}<Badge tone={check?.kind==='up-to-date'?'success':'neutral'}>{status}</Badge></h2>
      <p className="muted" data-route="engine">{t('업데이트 대상','Update target')}: {i.owner.kind==='package'?i.owner.manager+' · '+i.owner.packageName:t('출처 미확인','Unknown source')}</p>
      <VersionEvidence installed={installed(i)} latest={latest} checkedAt={stamp(i.lastCheck?.checkedAt??null)}/></div>
      <div className="cli-actions"><UpdateControl action={action} blocked={disabled} target={i.executableRealpath} onActivate={update}/><Button data-action="check" disabled={disabled} onClick={checkLatest}>{t('최신 확인','Check latest')}</Button><Button aria-expanded={expanded} aria-controls={detailId} onClick={()=>{if(expanded)setExpanded(false);else open('overview');}}>{expanded?t('상세 닫기','Close details'):t('상세 보기','Details')}</Button></div>
      <dl className="cli-status"><div><dt>{t('실행 세션','Active sessions')}</dt><dd><Button className="status-link" aria-controls={detailId} onClick={()=>open('sessions')}>{t('관리','Managed')} {active.length} · {t('herdr 창','herdr panes')} {snapshot.observationFailure||snapshot.observedAt==null?'—':scoped.external.filter(s=>s.herdrPane).length} →</Button></dd></div>
      <div><dt>{t('자동 업데이트','Automatic updates')}</dt><dd><AutomationToggle name={families[i.family]} installationId={i.installationId} enabled={!!policy&&policy.mode!=='off'} act={act} disabled={disabled||snapshot.service!=='ready'||workspaceBusy(snapshot)}/></dd>{policy&&policy.mode!=='off'&&<dd className="muted">{t('다음 확인','Next check')}: {stamp(policy.nextCheckAt)}</dd>}{policy?.waitingReason&&<dd className="muted">{explain(policy.waitingReason)}</dd>}</div>
      <div><dt>{t('마지막 업데이트','Last verified update')}</dt><dd>{stamp(lastVerifiedUpdate(snapshot.operations,i.installationId))}</dd></div></dl>
    </div>
    {expanded&&<div className="cli-detail" id={detailId}><div className="detail-tabs" role="tablist" aria-label={t('CLI 상세','CLI details')}>{(Object.keys(tabs) as DetailTab[]).map((key,index)=><button type="button" key={key} id={detailId+'-'+key} role="tab" aria-selected={tab===key} aria-controls={detailId+'-panel'} tabIndex={tab===key?0:-1} onClick={()=>setTab(key)} onKeyDown={e=>{const keys=Object.keys(tabs) as DetailTab[];let next:number|undefined;if(e.key==='ArrowRight')next=(index+1)%keys.length;if(e.key==='ArrowLeft')next=(index+keys.length-1)%keys.length;if(e.key==='Home')next=0;if(e.key==='End')next=keys.length-1;if(next!==undefined){e.preventDefault();setTab(keys[next]!);(e.currentTarget.parentElement?.children[next] as HTMLElement).focus();}}}>{tabs[key]}</button>)}</div><div className="detail-content" id={detailId+'-panel'} role="tabpanel" aria-labelledby={detailId+'-'+tab} tabIndex={0}>
      {tab==='overview'?<Installations snapshot={scoped} act={async command=>{const ok=await act(command);if(ok&&command.kind==='prepare')setTab('history');return ok;}} disabled={disabled}/>:tab==='sessions'?<Sessions snapshot={scoped} act={act} disabled={disabled}/>:tab==='history'?<Operations snapshot={scoped} act={act} disabled={disabled}/>:<Policies snapshot={scoped} act={act} disabled={disabled}/>}
    </div></div>}
  </section>;
}
function Installations({snapshot,act,disabled}:{snapshot:AppSnapshot;act:Act;disabled:boolean}) {
  const {t,stamp,explain} = useCopy();
  const [launch,setLaunch]=useState<Installation|null>(null); const [cwd,setCwd]=useState('');
  return <><Notice>{t("최신 버전 확인과 준비는 설치를 변경하지 않습니다. 준비가 끝나면 작업 화면에서 정확한 버전과 영향을 검토하세요.", "Checking and preparing do not change installations. Once prepared, review the exact version and impact in Update history.")}</Notice>{!snapshot.installations.length&&<Notice>{t("발견된 설치가 없습니다. CLI 설치 상태와 서비스 검색 범위를 확인하세요.", "No installations found. Check CLI installations and the service discovery scope.")}</Notice>}<div className="grid">{snapshot.installations.map(i=>{const check=i.lastCheck?.result; const supported=i.family==='omo'&&i.owner.kind!=='unknown';return <Panel key={i.installationId}><div className="page-head"><h2>{families[i.family]}</h2><Badge tone={supported?'neutral':'warning'}>{supported?t("관리 대상", "Managed installation"):t("직접 업데이트 불가", "Direct update unavailable")}</Badge></div><p className="path">{i.owner.kind==='unknown'?i.executableRealpath:i.owner.prefix}</p>{!supported&&<Notice tone="warning">{i.family!=='omo'?t('이 CLI의 직접 업데이트는 아직 지원하지 않습니다. 최신 버전 조회는 사용할 수 있습니다.','Direct updates are not supported for this CLI yet. Version checks remain available.'):t('설치 출처를 확인하지 못해 자동으로 파일을 변경할 수 없습니다. 표시된 설치 경로가 실제 사용하는 CLI인지 확인하세요.','The installation source could not be verified, so files cannot be changed automatically. Check that the path above is the CLI you use.')}</Notice>}<Facts items={[[t("설치된 버전", "Installed version"),i.installedVersion.kind==='known'?i.installedVersion.version:t("확인되지 않음", "Unknown")],[t("최신 버전", "Latest version"),!check?t("확인 전", "Not checked"):check.kind==='update-available'?check.availableVersion:check.kind==='up-to-date'?check.installedVersion:t("확인 불가", "Unavailable")],[t("관리 세션", "Managed sessions"),snapshot.managed.filter(s=>s.installationId===i.installationId&&!['stopped','failed'].includes(s.state)).length],[t("외부 세션", "External sessions"),snapshot.external.filter(s=>s.installationId===i.installationId).length]]}/>{check?.kind==='unavailable'&&<Notice tone={check.failure.code==='unsupported'?'warning':'error'}>{explain(check.failure.code)}</Notice>}<Facts items={[[t("최근 버전 확인", "Last version check"),stamp(i.lastCheck?.checkedAt??null)],[t("마지막 검증된 업데이트", "Last verified update"),lastVerifiedUpdate(snapshot.operations,i.installationId)===null?t("기록 없음 / 확인 불가", "No record / unavailable"):stamp(lastVerifiedUpdate(snapshot.operations,i.installationId))]]}/><div className="cluster"><Button disabled={disabled} onClick={()=>void act({kind:'check',installationId:i.installationId})}>{t("최신 버전 확인", "Check latest version")}</Button><Button disabled={disabled||!supported} onClick={()=>void act({kind:'prepare',installationId:i.installationId})}>{t("업데이트 준비", "Prepare update")}</Button><Button tone="primary" disabled={disabled||!supported} onClick={()=>{setLaunch(i);setCwd('');}}>{t("세션 시작", "Start session")}</Button></div></Panel>})}</div>{launch&&<Dialog title={t("관리 세션 시작", "Start managed session")} onClose={()=>setLaunch(null)}><p>{families[launch.family]} {t("를 선택한 폴더에서 시작합니다. 기존 OmO 설정과 시작 훅으로 실행합니다. 시작 후 작업 상태와 승인을 확인하세요.", "will start in the selected folder using existing OmO settings and startup hooks. Check its work state and approvals after launch.")}</p><form className="stack" onSubmit={e=>{e.preventDefault();void act({kind:'launch',installationId:launch.installationId,cwd}).then(ok=>{if(ok)setLaunch(null);});}}><label className="field">{t("작업 폴더의 절대 경로", "Absolute working directory path")}<input required pattern="/.*" value={cwd} onChange={e=>setCwd(e.target.value)} placeholder={t("/Users/이름/projects/프로젝트", "/Users/name/projects/project")}/></label><Button type="submit" tone="primary" disabled={disabled}>{t("세션 시작", "Start session")}</Button></form></Dialog>}</>;
}
/** The screen-based restart is offered while the pane ends at a prompt and the pid is quiet: for a
 * working OmO stuck past its last turn, or for an OmO whose engine exposes no activity signal
 * ("unknown") while herdr itself reports the pane idle. */
function screenRestartOffered(s:AppSnapshot['external'][number],activity:string):boolean {
  if(s.herdrPane?.screenIdle!==true||s.herdrPane.cpuQuiet!==true)return false;
  return activity==='working'||(activity==='unknown'&&(s.herdrPane.status==='idle'||s.herdrPane.status==='done'));
}
/** One reading of whether a herdr-pane session can be restarted now, shared by the card buttons
 * and the batch review so both offer exactly the same panes. */
function paneRestartReadiness(s:AppSnapshot['external'][number],snapshot:AppSnapshot){
  const state=snapshot.observationFailure?'unknown':s.processState??'observed';
  const paneJob=(snapshot.paneRestarts??[]).filter(job=>job.paneId===s.herdrPane?.paneId&&(job.sessionId===s.id||!['completed','failed'].includes(job.stage))).sort((a,b)=>b.createdAt-a.createdAt)[0];
  const paneBusy=!!paneJob&&!['completed','failed'].includes(paneJob.stage);
  const activity=state!=='observed'?'unknown':s.omoActivity??s.herdrPane?.status??'unknown';
  const screenIdleHint=state==='observed'&&screenRestartOffered(s,activity);
  const restartSupported=!!s.family&&['omo','omp','claude','codex'].includes(s.family);
  const gate=!restartSupported||s.control!=='herdr-pane'||state!=='observed'||paneBusy||activity==='blocked'||(s.family==='omo'&&!s.conversation);
  const blocked=gate||activity==='unknown';
  const screenBlocked=gate||!screenIdleHint;
  // Batch mode never queues a working session behind others; the card's own button may still wait for it.
  const mode:'idle'|'screen'|null=!blocked&&(activity==='idle'||activity==='done')?'idle':!screenBlocked?'screen':null;
  return {state,paneJob,paneBusy,activity,screenIdleHint,restartSupported,blocked,screenBlocked,mode};
}
const batchBinding=(sessions:readonly AppSnapshot['external'][number][])=>JSON.stringify(sessions.map(s=>[s.id,s.pid,s.startedAt,s.conversation?.id,s.herdrPane?.paneId,s.herdrPane?.stateChangeSeq]));
function Sessions({snapshot,act,disabled}:{snapshot:AppSnapshot;act:Act;disabled:boolean}) {
  const {t,stamp,installed,title,explain} = useCopy();
  const [review,setReview]=useState<{session:AppSnapshot['external'][number];trustScreen:boolean;server:string|undefined}|null>(null);
  const [batch,setBatch]=useState<{sessions:readonly AppSnapshot['external'][number][];server:string|undefined;binding:string;selected:readonly string[]}|null>(null);
  const [restartFailed,setRestartFailed]=useState(false);
  const shown=snapshot.external.filter(s=>s.herdrPane);
  const outdated=outdatedSessions(snapshot);
  const candidates=outdated.filter(s=>paneRestartReadiness(s,snapshot).mode!==null);
  const batchCurrent=batch?batch.sessions.map(s=>snapshot.external.find(row=>row.id===s.id)).filter((row):row is AppSnapshot['external'][number]=>!!row):[];
  const batchStale=!!batch&&(snapshot.serverInstance!==batch.server||batchCurrent.length!==batch.sessions.length||batchBinding(batchCurrent)!==batch.binding
    ||!!snapshot.observationFailure||batchCurrent.some(row=>paneRestartReadiness(row,snapshot).mode===null||!outdated.some(o=>o.id===row.id)));
  const outside=snapshot.external.filter(s=>s.processState!=='exited'&&!s.herdrPane);
  const current=review&&snapshot.external.find(s=>s.id===review.session.id);
  const stale=!!review&&(snapshot.serverInstance!==review.server||!current||current.pid!==review.session.pid||current.startedAt!==review.session.startedAt
    ||current.executable!==review.session.executable||current.installationId!==review.session.installationId
    ||current.conversation?.id!==review.session.conversation?.id||current.herdrPane?.paneId!==review.session.herdrPane?.paneId
    ||current.herdrPane?.stateChangeSeq!==review.session.herdrPane?.stateChangeSeq
    ||current.processState==='exited'||current.processState==='unknown'||!!snapshot.observationFailure);
  const reviewBlocked=!!current&&(current.control!=='herdr-pane'||current.herdrPane?.status==='blocked'||current.omoActivity==='blocked'
    ||(review?.trustScreen?!screenRestartOffered(current,current.omoActivity??current.herdrPane?.status??'unknown')
      :((current.omoActivity??current.herdrPane?.status)==='unknown'||current.omoActivity==='unknown'))
    ||(snapshot.paneRestarts??[]).some(job=>job.paneId===current.herdrPane?.paneId&&!['completed','failed'].includes(job.stage)));
  return <>
    {!!(snapshot.native?.selections.length || snapshot.native?.jobs.length) && <NativeRestarts snapshot={snapshot} act={act} disabled={disabled}/>}
    <p className="muted">{t('최근 실행 상태 확인:','Last process check:')} {snapshot.observedAt==null?t('아직 확인 전','Not checked'):stamp(snapshot.observedAt)}</p>
    {snapshot.observationFailure&&<Notice tone="warning">{t('실행 상태를 갱신하지 못했습니다. 아래는 마지막으로 확인한 정보입니다.','Process refresh failed. These are the last confirmed observations.')} {explain(snapshot.observationFailure)}</Notice>}
    {snapshot.managed.length>0&&<div><SectionHead title={t('업데이터에서 시작한 세션','Sessions started by the updater')} count={snapshot.managed.length}/>
      {snapshot.managed.map(s=><Session key={s.id} session={s} name={title(snapshot,s.installationId)} family={snapshot.installations.find(i=>i.installationId===s.installationId)?.family} installedVersion={installed(snapshot.installations.find(i=>i.installationId===s.installationId))} server={snapshot.serverInstance} act={act} disabled={disabled}/>)}
    </div>}
    <SectionHead title={t('herdr 창의 CLI','CLIs in herdr panes')} count={shown.length}/>
    {outside.length>0&&<p className="muted">{t('herdr 밖 실행 '+outside.length+'개는 관리하지 않아 표시하지 않습니다.',outside.length+' processes outside herdr are not managed and not listed.')}</p>}
    <p className="muted">{t('설치 업데이트는 실행 중인 세션을 바꾸지 않습니다. 재시작은 지원과 대화 식별을 확인한 뒤 별도로 검토하세요.','Installation updates leave running sessions alone. Review a session restart separately after checking support and conversation identity.')}</p>
    {candidates.length>0&&<div className="cluster"><Button data-action="review-pane-restart-batch" data-count={candidates.length} tone="primary" disabled={disabled} onClick={()=>{setRestartFailed(false);setBatch({sessions:candidates,server:snapshot.serverInstance,binding:batchBinding(candidates),selected:candidates.map(s=>s.id)});}}>{t('오래된 세션 '+candidates.length+'개 재시작 검토','Review restart of '+candidates.length+' outdated sessions')}</Button>
      {outdated.length>candidates.length&&<span className="muted">{t('예전 버전 '+(outdated.length-candidates.length)+'개는 지금 재시작할 수 없어 제외','· '+(outdated.length-candidates.length)+' outdated sessions cannot restart now and are left out')}</span>}</div>}
    {!candidates.length&&outdated.length>0&&<p className="muted">{t('예전 버전으로 실행 중인 세션 '+outdated.length+'개가 있지만 지금은 모두 재시작할 수 없는 상태입니다.',outdated.length+' sessions run an older version but none can restart right now.')}</p>}
    {!shown.length&&<Notice>{t('herdr 창에서 실행 중인 CLI가 없습니다.','No CLI processes in herdr panes.')}</Notice>}
    {shown.map(s=>{
      const linked=s.installationId?snapshot.installations.find(i=>i.installationId===s.installationId):null;
      const catalog=s.catalogId?snapshot.catalog?.find(c=>c.id===s.catalogId):null;
      const supported=isSupportedCli(s.family??s.catalogId??linked?.family);
      const disk=s.diskPackage?.version??(linked?.installedVersion.kind==='known'?linked.installedVersion.version:null);
      const state=snapshot.observationFailure?'unknown':s.processState??'observed';
      const label=s.conversation?.title??s.cwd?.split('/').filter(Boolean).at(-1)??s.herdrPane?.paneId;
      const cli=s.family==='senpi'?'Senpi':catalog?.name??Object.entries(families).find(([id])=>id===(s.family??s.catalogId))?.[1]??s.family??t('CLI 종류 미확인','Unknown CLI');
      const startedAtMs=s.startedAt?Date.parse(s.startedAt):null;
      const updatedSince=startedAtMs!=null&&((s.installationId&&(lastVerifiedUpdate(snapshot.operations,s.installationId)??0)>startedAtMs)
        ||(snapshot.catalogUpdates??[]).some(job=>job.catalogId===s.catalogId&&job.target.executable===s.executable&&job.stage==='completed'&&job.beforeVersion!==job.installedVersion&&job.updatedAt>startedAtMs));
      const {paneJob,activity,screenIdleHint,restartSupported,blocked,screenBlocked}=paneRestartReadiness(s,snapshot);
      const inferred=s.runningVersionEvidence==='started-after-install'||s.runningVersionEvidence==='started-before-install';
      return <section className="panel" key={s.id+':'+(s.startedAt??'unknown')} data-session-id={s.id} data-activity={activity} data-version-evidence={s.runningVersionEvidence??'unknown'} data-installation-changed={updatedSince?'true':'false'}>
        <div className="cluster"><h3 className="cli-heading">{supported&&<AgentMark agent={s.family??linked?.family??'unknown'} size={24}/>}<span>{cli} · {label}</span></h3><Badge>{state==='exited'?t('종료 확인','Exit observed'):state==='unknown'?t('현재 상태 미확인','Current state unknown'):t('프로세스 관측됨','Process observed')}</Badge>{!supported&&<Badge>{t('아직 지원하지 않음','Not yet supported')}</Badge>}</div>
        {s.cwd&&<p className="path">{s.cwd}</p>}
        <Facts items={[
          [t('활동','Activity'),activity==='working'?t('작업 중','Working'):activity==='blocked'?t('응답 대기 중','Waiting for your answer'):activity==='idle'||activity==='done'?t('대기 중','Idle'):t('상태 미확인','Unknown')],
          [t('실행 중인 버전','Running version'),<span data-evidence="running-version">{s.runningVersionEvidence==='started-before-install'?t('미확인','Unknown'):s.runningVersion??t('미확인','Unknown')}</span>],
          [t('버전 근거','Version evidence'),s.runningVersionEvidence==='launch-environment'?t('이 프로세스 시작 시 기록된 앱 버전','App version recorded when this process started'):inferred?t('파일 변경 시각과 시작 시각 비교 · 추정','File and process start times · inferred'):s.runningVersion?t('수집된 CLI 버전','Captured CLI version'):t('실행 버전 근거 없음','No running-version evidence')],
          [t('마지막 상태 확인','Last process check'),stamp(s.observedAt??snapshot.observedAt??null)],
        ]}/>
        {updatedSince&&state!=='exited'&&<Notice tone="warning">{t('이 실행 파일과 일치하는 설치의 업데이트 기록이 있습니다. 실행 중인 버전이 바뀌었다는 뜻은 아닙니다.','An update was recorded for this exact installation. This does not prove the running version changed.')}</Notice>}
        {s.runningVersionEvidence==='started-before-install'&&<Notice>{t('시작 이후 패키지 파일이 변경된 것으로 추정합니다. 이전 실행 버전과 대화 재개 가능 여부는 이 근거만으로 확인할 수 없습니다.','Package files appear to have changed since launch. The previous running version and safe conversation resume cannot be confirmed from file times.')}</Notice>}
        {s.runningVersionEvidence==='started-after-install'&&<p className="muted">{t('디스크 버전을 실행 버전으로 추정한 값이며 프로세스의 직접 응답은 아닙니다.','The running version is inferred from disk, not directly reported by this process.')}</p>}
        {supported&&restartSupported?<div className="stack"><Button data-action="review-pane-restart" disabled={disabled||blocked} onClick={()=>{setRestartFailed(false);setReview({session:s,trustScreen:false,server:snapshot.serverInstance});}}>{t('세션 재시작 검토','Review session restart')}</Button>
          {screenIdleHint&&<Button data-action="review-screen-restart" disabled={disabled||screenBlocked} onClick={()=>{setRestartFailed(false);setReview({session:s,trustScreen:true,server:snapshot.serverInstance});}}>{t('화면 기준 재시작 검토','Review screen-based restart')}</Button>}
          {blocked&&!screenIdleHint&&<Notice>{t('현재 관찰, 활동, 대화 연결 또는 진행 중 재시작을 확인해야 합니다. 응답 대기·미확인 상태에서는 실행하지 않습니다.','Check observations, activity, conversation identity and pending restart. Waiting or unverified sessions cannot restart here.')}</Notice>}
          {blocked&&screenIdleHint&&<Notice>{t('이 엔진은 세션 활동 상태를 알려주지 않습니다. herdr·화면·CPU가 모두 조용할 때만 화면 기준으로 재시작을 검토할 수 있으며, 백그라운드 모니터와 하위 작업은 확인하지 못합니다.','This engine reports no session activity. Only while herdr, the screen and CPU are all quiet can a screen-based restart be reviewed; background monitors and child tasks stay unverified.')}</Notice>}
        </div>:<Notice>{supported?t('이 CLI의 같은 대화 재시작은 아직 지원하지 않습니다. herdr 창에서 직접 사용하세요.','Same-conversation restart is not supported for this CLI. Continue in its herdr pane.'):t('터미널 관찰만 지원합니다. 설치 관리·업데이트·자동화·재시작은 지원하지 않습니다.','Terminal observation only. Installation management, updates, automation and restarts are not supported.')}</Notice>}
        {paneJob&&<Notice tone={paneJob.stage==='failed'?'error':'neutral'}>{paneJob.stage}{paneJob.failure&&<> · {explain(paneJob.failure)}</>}{paneJob.resumeId&&<span className="path"> · {paneJob.resumeId}</span>}</Notice>}
        <details><summary>{t('기술 정보','Technical details')}</summary><Facts items={[
          [t('현재 디스크 설치 버전','Current version on disk'),disk??t('미확인','Unknown')],
          [t('내부 엔진 버전','Internal engine version'),s.runningEngineVersion??t('미확인','Unknown')],
          ['PID',s.pid],[t('터미널','Terminal'),s.tty??t('미확인','Unknown')],
          [t('대화 ID','Conversation ID'),<span className="path">{s.conversation?.id??t('미확인','Unknown')}</span>],
          [t('실행 파일','Executable'),<span className="path">{s.executable}</span>],
          [t('설치 ID','Installation ID'),s.installationId??t('일치 미확인','Match unverified')],
          [t('패키지','Package'),s.diskPackage?.name??t('미확인','Unknown')],
        ]}/></details>
      </section>;
    })}
    {batch&&<Dialog title={t('오래된 세션 재시작 검토','Review restart of outdated sessions')} onClose={()=>setBatch(null)}>
      <p>{t('아래 세션을 한 번에 하나씩 같은 대화로 다시 시작합니다. 각 창에 종료 명령을 보내고 재개 명령을 입력하므로 설치는 바꾸지 않습니다. 서비스가 창마다 프로세스·화면·CPU·대화 ID를 다시 검증하며 확인되지 않은 창은 건너뛰고 다음 창으로 넘어갑니다.','The sessions below restart one at a time into the same conversation. Each pane receives the exit command and then the resume command; no installation changes. The service rechecks process, screen, CPU and conversation ID per pane, skips any pane that fails the check and moves on to the next.')}</p>
      <ul className="stack" data-batch-count={batch.sessions.length}>{batch.sessions.map(s=>{const current=snapshot.external.find(row=>row.id===s.id);const mode=current?paneRestartReadiness(current,snapshot).mode:null;const disk=s.diskPackage?.version??snapshot.installations.find(i=>i.installationId===s.installationId)?.installedVersion;const diskVersion=typeof disk==='string'?disk:disk?.kind==='known'?disk.version:null;
        const checked=batch.selected.includes(s.id);
        return <li key={s.id} data-batch-session={s.id} data-batch-mode={mode??'blocked'}><label className="cluster"><input type="checkbox" checked={checked} onChange={e=>setBatch(previous=>previous&&{...previous,selected:e.target.checked?[...previous.selected,s.id]:previous.selected.filter(id=>id!==s.id)})}/><span><strong>{s.conversation?.title??s.cwd?.split('/').filter(Boolean).at(-1)??s.herdrPane?.paneId}</strong> · <span className="path">{s.herdrPane?.paneId}</span> · {s.runningVersion??'?'} → {diskVersion??'?'} · {mode==='idle'?t('대기 중','Idle'):mode==='screen'?t('화면 기준','Screen-based'):t('지금은 불가','Not now')}</span></label></li>;})}</ul>
      {batch.sessions.some(s=>paneRestartReadiness(s,snapshot).mode==='screen')&&<Notice tone="warning">{t('화면 기준 항목은 엔진이 활동 상태를 알려주지 않아 herdr·화면·CPU만으로 대기 중이라고 판단합니다. 백그라운드 모니터와 하위 작업은 확인하지 못합니다.','Screen-based items are judged idle from herdr, the screen and CPU only, because the engine reports no activity. Background monitors and child tasks stay unverified.')}</Notice>}
      {batchStale&&<Notice tone="warning">{t('세션 또는 활동이 바뀌었습니다. 닫고 최신 상태에서 다시 검토하세요.','The sessions or their activity changed. Close and review the latest state.')}</Notice>}
      {restartFailed&&<Notice tone="error">{t('재시작 요청을 확인하지 못했습니다. 현재 상태를 확인하세요. 자동 재전송하지 않습니다.','Restart request was not confirmed. Check current state; it will not be resent automatically.')}</Notice>}
      <Button data-action="confirm-pane-restart-batch" tone="primary" disabled={disabled||batchStale||!batch.selected.length} onClick={()=>{if(disabled||batchStale||!batch.selected.length)return;const items=batch.sessions.filter(s=>batch.selected.includes(s.id)).map(s=>({sessionId:s.id,paneId:s.herdrPane?.paneId??''}));void act({kind:'pane-restart-batch',trustScreen:true,items}).then(ok=>{if(ok)setBatch(null);else setRestartFailed(true);});}}>{t('선택한 세션 '+batch.selected.length+'개 다시 시작','Restart '+batch.selected.length+' selected sessions')}</Button>
    </Dialog>}
    {review&&<Dialog title={t('선택한 세션 재시작 검토','Review selected session restart')} onClose={()=>setReview(null)}>
      <p>{t('현재 작업이 끝난 뒤 같은 대화를 재개합니다. 설치 업데이트는 하지 않습니다. 서비스가 프로세스·활동·대화 ID를 다시 검증하며 확인되지 않으면 중단합니다.','Resume the same conversation after current work finishes. No installation update runs. The service rechecks process, activity and conversation IDs and stops if unverified.')}</p>
      <Facts items={[[t('세션 ID','Session ID'),review.session.id],[t('창','Pane'),review.session.herdrPane?.paneId],[t('대화 ID','Conversation ID'),<span className="path">{review.session.conversation?.id??t('종료 출력에서 확인 필요 · 불일치 시 중단','Must be verified from exit output; mismatch stops restart')}</span>]]}/>
      {review.trustScreen&&<Notice tone="warning">{t('화면 입력 대기와 CPU 관찰을 신뢰하는 선택입니다. 서버의 화면·CPU·대화 검증은 유지됩니다.','This choice trusts the screen and CPU observations. Server screen, CPU and conversation guards remain enforced.')}</Notice>}
      {(stale||reviewBlocked)&&<Notice tone="warning">{t('세션 또는 활동이 바뀌었습니다. 닫고 최신 상태에서 다시 검토하세요.','The session or activity changed. Close and review the latest state.')}</Notice>}
      {restartFailed&&<Notice tone="error">{t('재시작 요청을 확인하지 못했습니다. 현재 상태를 확인하세요. 자동 재전송하지 않습니다.','Restart request was not confirmed. Check current state; it will not be resent automatically.')}</Notice>}
      <Button data-action="confirm-pane-restart" tone="primary" disabled={disabled||stale||reviewBlocked} onClick={()=>{const pane=review.session.herdrPane;if(!pane||disabled||stale||reviewBlocked)return;void act({kind:'pane-restart',sessionId:review.session.id,paneId:pane.paneId,...(review.trustScreen?{trustScreen:true}:{})}).then(ok=>{if(ok)setReview(null);else setRestartFailed(true);});}}>{t('검토한 세션 다시 시작','Restart reviewed session')}</Button>
    </Dialog>}
  </>;
}
function Session({session:s,name,family,installedVersion,server,act,disabled}:{session:ManagedSession;name:string;family:Installation['family']|undefined;installedVersion:string;server:string|undefined;act:Act;disabled:boolean}) {
  const {t,sessionNames,stamp,explain} = useCopy();
  const [message,setMessage]=useState(''); const [confirm,setConfirm]=useState<({kind:'stop'|'restart';sessionId:string;generation:number;reviewed:ManagedSession;server:string|undefined})|null>(null); const [approval,setApproval]=useState<ManagedSession|null>(null); const [answer,setAnswer]=useState('');
  const active=['ready','working','waiting'].includes(s.state);
  const restartEligible=!!s.durableSessionId&&!!family&&['omo','omp','claude','codex'].includes(family)&&['ready','working','stopped'].includes(s.state);
  const stale=!!confirm&&(confirm.server!==server||confirm.generation!==s.generation||confirm.reviewed.id!==s.id
    ||confirm.reviewed.installationId!==s.installationId||confirm.reviewed.pid!==s.pid||confirm.reviewed.cwd!==s.cwd
    ||confirm.reviewed.durableSessionId!==s.durableSessionId||confirm.reviewed.state!==s.state
    ||(confirm.kind==='restart'&&!restartEligible));
  const approvalStale=approval&&(approval.generation!==s.generation||approval.approval?.id!==s.approval?.id);
  return <Panel><div className="page-head"><h3 className="cli-heading">{family&&<AgentMark agent={family} size={24}/>}<span>{name} {t("관리 세션", "Managed sessions")}</span></h3><Badge tone={tone(s.state)}>{sessionNames[s.state]}</Badge></div><p className="path">{s.cwd}</p><Facts items={[[t("CLI 종류", "CLI type"),name],[t("터미널 TTY", "Terminal TTY"),t("관리 연결 / TTY 확인 불가", "Managed connection / TTY unavailable")],["PID",s.pid??t("확인되지 않음", "Unknown")],[t("시작 시각", "Started at"),t("기록되지 않음", "Not recorded")],[active?t("실행 중인 버전", "Running version"):t("마지막 실행 버전", "Last launched version"),s.launchedVersion??t("확인되지 않음", "Unknown")],[t("설치된 버전", "Installed version"),installedVersion],[t("최근 세션 확인", "Last session check"),stamp(s.updatedAt)]]}/><details><summary>{t('기술 정보','Technical details')}</summary><Facts items={[[t('내부 엔진 버전','Internal engine version'),s.engineVersion??t('확인되지 않음','Unknown')]]}/><p className="muted">{t('내부 엔진 버전은 CLI가 알려주는 기술 정보이며 설치된 패키지 버전과 다를 수 있습니다. 실행 버전은 세션을 시작할 때 확인한 CLI 버전입니다.','The internal engine version is reported by the CLI and may differ from the installed package. The running version was recorded when the session started.')}</p></details>{s.failure&&<Notice tone="error">{explain(s.failure)}</Notice>}<div className="cluster"><Button tone="danger" disabled={disabled||!active} onClick={()=>setConfirm({kind:'stop',sessionId:s.id,generation:s.generation,reviewed:s,server})}>{t("안전하게 종료", "Stop safely")}</Button><Button disabled={disabled||!restartEligible} onClick={()=>setConfirm({kind:'restart',sessionId:s.id,generation:s.generation,reviewed:s,server})}>{t("세션 재시작 검토", "Review session restart")}</Button></div><h4>{t("세션 출력", "Session output")}</h4><pre className="console" tabIndex={0} aria-label={t(`${name} 세션 출력`, `${name} session output`)}>{s.output.length?s.output.join('\n'):t("아직 출력이 없습니다.", "No output yet.")}</pre>{s.approval&&<Notice tone="warning">{t("세션이 사용자의 답변을 기다립니다.", "The session is waiting for your response.")}<Button disabled={disabled} onClick={()=>{setApproval(s);setAnswer('');}}>{t("요청 내용 검토", "Review request")}</Button></Notice>}<form className="stack" onSubmit={e=>{e.preventDefault();void act({kind:'send',sessionId:s.id,generation:s.generation,message}).then(ok=>{if(ok)setMessage('');});}}><label className="field">{t("세션에 보낼 메시지", "Message to send to session")}<textarea required value={message} onChange={e=>setMessage(e.target.value)} disabled={disabled||!active||!!s.approval}/></label><Button tone="primary" type="submit" disabled={disabled||!active||!!s.approval||!message.trim()}>{t("메시지 보내기", "Send message")}</Button></form>{confirm&&<Dialog title={confirm.kind==='stop'?t("세션을 안전하게 종료할까요?", "Stop this session safely?"):t("같은 세션을 다시 시작할까요?", "Restart the same session?")} onClose={()=>setConfirm(null)}><p className="path">{confirm.reviewed.cwd}</p>{confirm.kind==='restart'&&<><p>{t('현재 설치로 같은 대화를 다시 엽니다. 설치 업데이트는 실행하지 않습니다.','Reopen the same conversation with the current installation. No installation update runs.')}</p><p className="path">{confirm.reviewed.durableSessionId}</p></>}<p>{t("현재 작업을 중단하지 않습니다. 안전한 종료 조건을 확인한 뒤 처리하며, 진행 중이면 서비스가 대기 사유를 알립니다.", "Current work will not be interrupted. The service checks safe shutdown conditions and reports why it is waiting if work is in progress.")}</p>{stale&&<Notice tone="warning">{t("세션이 변경되었습니다. 닫고 최신 상태에서 다시 검토하세요.", "The session changed. Close this dialog and review its latest state.")}</Notice>}<Button tone={confirm.kind==='stop'?'danger':'primary'} disabled={disabled||!!stale} onClick={()=>{if(disabled||stale)return;void act({kind:confirm.kind,sessionId:confirm.sessionId,generation:confirm.generation}).then(ok=>{if(ok)setConfirm(null);});}}>{t("검토한 작업 실행", "Run reviewed operation")}</Button></Dialog>}{approval?.approval&&<Dialog title={t("세션 요청에 답변", "Respond to session request")} onClose={()=>setApproval(null)}><p className="path">{approval.approval.title}</p>{approvalStale&&<Notice tone="warning">{t("요청이 바뀌거나 종료되었습니다. 최신 요청을 다시 여세요.", "The request changed or ended. Reopen the latest request.")}</Notice>}{approval.approval.method==='confirm'?<div className="cluster">{[false,true].map(value=><Button key={String(value)} tone={value?'primary':'secondary'} disabled={disabled||!!approvalStale} onClick={()=>void act({kind:'respond',sessionId:s.id,generation:approval.generation,approvalId:approval.approval!.id,value}).then(ok=>{if(ok)setApproval(null);})}>{value?t("승인", "Approve"):t("거절", "Reject")}</Button>)}</div>:<form className="stack" onSubmit={e=>{e.preventDefault();void act({kind:'respond',sessionId:s.id,generation:approval.generation,approvalId:approval.approval!.id,value:answer}).then(ok=>{if(ok)setApproval(null);});}}>{approval.approval.method==='select'?<Select label={t('답변','Response')} value={answer} options={[{value:'',label:t('선택하세요','Select an option'),disabled:true},...approval.approval.options.map(value=>({value,label:value}))]} onChange={setAnswer} disabled={disabled||!!approvalStale}/>:<label className="field">{t('답변','Response')}<textarea required value={answer} onChange={e=>setAnswer(e.target.value)}/></label>}<Button type="submit" tone="primary" disabled={disabled||!!approvalStale||!answer}>{t("답변 보내기", "Send response")}</Button></form>}</Dialog>}</Panel>;
}

function Operations({snapshot,guardSnapshot=snapshot,act,disabled}:{snapshot:AppSnapshot;guardSnapshot?:AppSnapshot;act:Act;disabled:boolean}) {
  const {t,sessionNames,stages,kinds,stamp,title,explain} = useCopy();
  const [reviewed,setReview]=useState<{operation:AppOperation;server:string|undefined;installation:Installation|undefined;binding:string}|null>(null);
  const review=reviewed?.operation??null; const [selected,setSelected]=useState<{id:string;generation:number}[]>([]); const [restart,setRestart]=useState(false); const [cancel,setCancel]=useState<AppOperation|null>(null);
  const [paneChoice,setPaneChoice]=useState<PaneSessionPolicy>('keep');
  const current=review&&snapshot.operations.find(o=>o.id===review.id);
  const installation=review&&snapshot.installations.find(i=>i.installationId===review.installationId);
  const stale=!!reviewed&&(!current||current.stage!=='ready'||JSON.stringify(current)!==JSON.stringify(reviewed.operation)
    ||snapshot.serverInstance!==reviewed.server||!installation||engineReviewBinding(installation)!==reviewed.binding);
  const candidates=review?snapshot.managed.filter(s=>s.installationId===review.installationId&&!['stopped','failed'].includes(s.state)):[];
  const cancelCurrent=cancel&&snapshot.operations.find(o=>o.id===cancel.id);
  return <>{!snapshot.operations.length&&!catalogHistory(snapshot).length&&<Notice>{t("아직 작업이 없습니다. 설치 화면에서 업데이트를 준비하세요.", "No operations yet. Prepare an update in CLI installations.")}</Notice>}{[...snapshot.operations].reverse().map(o=><Panel key={o.id}><div className="page-head"><h2>{title(snapshot,o.installationId)} · {kinds[o.kind]}</h2><Badge tone={tone(o.stage)}>{stages[o.stage]}</Badge></div><Facts items={[...((o.kind==='prepare'||o.kind==='update')?([[t("변경 전", "Before update"),o.beforeVersion??t("확인되지 않음", "Unknown")],[t("준비한 목표 버전", "Prepared target version"),o.targetVersion??t("준비 중 / 확인 필요", "Preparing / needs checking")],[t("검증된 설치 버전", "Verified installed version"),o.installedVersion??t("검증 전", "Not verified")]] as const):[]),[t("선택한 관리 세션", "Selected managed sessions"),t(`${o.sessionIds.length}개`, `${o.sessionIds.length} ${o.sessionIds.length === 1 ? 'session' : 'sessions'}`)],[t("세션 다시 시작", "Restart session"),o.restart?t("승인됨", "Approved"):t("하지 않음", "No")],...(o.externalSessionIds?.length?[[t("업데이트 당시 실행 중이던 세션", "Sessions running at update time"),t(`${o.externalSessionIds.length}개 · ${paneSessionLabels(t)[o.paneSessions??'keep'][0]}`, `${o.externalSessionIds.length} · ${paneSessionLabels(t)[o.paneSessions??'keep'][0]}`)]] as const:[]),[t("마지막 변경", "Last changed"),stamp(o.updatedAt)]]}/><ol className="steps" aria-label={t("작업 진행 단계", "Operation progress")}>{(o.kind==='stop'?(['waiting','stopping','completed'] as const):o.kind==='restart'?(['waiting','stopping','restarting','completed'] as const):(['preparing','ready','waiting','stopping','updating','verifying','restarting','completed'] as const)).map(stage=><li key={stage} aria-current={o.stage===stage?'step':undefined}>{stages[stage]}</li>)}</ol>{!!o.paneResults?.length&&<details open={o.paneResults.some(r=>r.outcome==='pending')}><summary>{t('herdr 창 세션 다시 시작','herdr-pane session restarts')} · {o.paneResults.filter(r=>r.outcome==='completed').length}/{o.paneResults.length}</summary><ul className="stack">{o.paneResults.map(r=>{const session=snapshot.external.find(s=>s.id===r.sessionId);const label=session?.cwd?.split('/').filter(Boolean).at(-1)??r.paneId;const outcome={pending:t('진행 중','In progress'),completed:t(`완료 · PID ${r.previousPid} → ${r.resumedPid}`,`Done · PID ${r.previousPid} → ${r.resumedPid}`),failed:t(`실패 · ${r.failure??''}`,`Failed · ${r.failure??''}`),'skipped-working':t('작업 중이라 건드리지 않음 · 직접 다시 시작 필요','Left alone (working) · restart manually'),'skipped-blocked':t('응답 대기 중이라 건드리지 않음','Left alone (waiting for an answer)')}[r.outcome];return <li key={r.sessionId}><Badge tone={r.outcome==='completed'?'success':r.outcome==='failed'?'error':r.outcome==='pending'?'neutral':'warning'}>{outcome}</Badge> {label} <span className="muted">({r.paneId})</span></li>;})}</ul></details>}{o.failure&&<Notice tone="error">{explain(o.failure)}</Notice>}{o.detail&&<details><summary>{t("진단 정보", "Diagnostics")}</summary><p className="path">{o.detail}</p></details>}{o.stage==='uncertain'&&o.failure==='restart_unverified'&&o.installedAt!=null&&<Notice tone="warning">{t('설치 업데이트는 검증됐지만 일부 세션의 재시작이 남았습니다. 완료한 세션은 유지하고, 소유권과 대화가 확인된 나머지만 복구합니다.','The update is verified, but some session restarts remain. Keep completed sessions and recover only remaining sessions with verified ownership and conversation identity.')}<Button disabled={disabled} onClick={()=>void act({kind:'refresh'})}>{t('남은 세션 복구','Recover remaining sessions')}</Button></Notice>}{o.stage==='uncertain'&&!(o.failure==='restart_unverified'&&o.installedAt!=null)&&<Notice tone="warning">{t("실제 변경 결과가 확인되지 않았습니다. 재실행하지 말고 현재 설치와 세션 상태를 확인하세요.", "The actual change is unconfirmed. Do not rerun it; check current installation and session state.")}</Notice>}{o.stage==='ready'&&<Button tone="primary" disabled={disabled||!o.targetVersion} onClick={()=>{const installation=snapshot.installations.find(i=>i.installationId===o.installationId);const policy=snapshot.policies.find(p=>p.installationId===o.installationId);setReview({operation:o,server:snapshot.serverInstance,installation,binding:engineReviewBinding(installation)});setSelected([]);setRestart(false);setPaneChoice(policy?(policy.paneSessions??'restart-idle'):'keep');}}>{t("업데이트 영향 검토", "Review update impact")}</Button>}{['preparing','ready','waiting'].includes(o.stage)&&<Button disabled={disabled} onClick={()=>setCancel(o)}>{t("안전한 취소 검토", "Review safe cancellation")}</Button>}{['stopping','updating','verifying','restarting'].includes(o.stage)&&<p className="muted">{t("변경이 시작된 작업은 이 화면에서 취소하지 않습니다. 브라우저를 닫아도 작업은 계속됩니다.", "Operations that have started making changes cannot be cancelled here. They continue after the browser closes.")}</p>}</Panel>)}{review&&<Dialog title={t("업데이트를 승인할까요?", "Approve this update?")} onClose={()=>setReview(null)}><Facts items={[[t("설치", "Installation"),reviewed?.installation?families[reviewed.installation.family]:t("확인되지 않은 설치", "Unknown installation")],[t("대상 실행 파일", "Target executable"),<span className="path">{reviewed?.installation?.executableRealpath??t("확인되지 않음", "Unknown")}</span>],[t("현재 버전", "Current version"),review.beforeVersion??t("확인되지 않음", "Unknown")],[t("목표 버전", "Target version"),review.targetVersion??t("확인되지 않음", "Unknown")]]}/><p>{t("서비스가 새 관리 세션 진입을 막고 안전한 종료를 기다린 후 설치를 변경하고 검증합니다. 외부 세션은 종료하지 않으며 시작할 때의 버전으로 계속 실행됩니다. 새 버전은 해당 세션을 직접 다시 시작할 때 적용됩니다.", "The service blocks new managed sessions, waits for safe shutdown, then updates and verifies the installation. External sessions are not stopped and keep running their launched version; the new version applies when you restart them yourself.")}</p>{(()=>{const outside=snapshot.external.filter(s=>s.installationId===review.installationId&&s.processState!=='exited');const inPane=outside.filter(s=>s.herdrPane);const idle=inPane.filter(s=>s.herdrPane!.status==='idle'||s.herdrPane!.status==='done').length;const working=inPane.filter(s=>s.herdrPane!.status==='working').length;const blocked=inPane.filter(s=>s.herdrPane!.status==='blocked').length;const outsideHerdr=outside.length-inPane.length;return outside.length?<div className="stack"><Notice tone="warning">{t(`이 설치를 사용하는 세션 ${outside.length}개: herdr 창 ${inPane.length}개(대기 ${idle} · 작업 중 ${working}${blocked?` · 응답 대기 ${blocked}`:''})${outsideHerdr?` · herdr 밖 ${outsideHerdr}개는 관리하지 않습니다`:''}.`,`${outside.length} sessions use this installation: ${inPane.length} in herdr panes (${idle} idle · ${working} working${blocked?` · ${blocked} waiting for an answer`:''})${outsideHerdr?` · ${outsideHerdr} outside herdr are not managed`:''}.`)}</Notice></div>:null;})()}<PaneSessionChoice value={paneChoice} disabled={disabled||stale} compact onChange={setPaneChoice}/><fieldset className="stack"><legend>{t("작업에 포함할 관리 세션", "Managed sessions to include")}</legend>{!candidates.length&&<p className="muted">{t("선택할 실행 중 관리 세션이 없습니다.", "No running managed sessions to select.")}</p>}{candidates.map(s=><label className="check" key={s.id}><input type="checkbox" checked={selected.some(row=>row.id===s.id)} onChange={e=>setSelected(e.target.checked?[...selected,{id:s.id,generation:s.generation}]:selected.filter(row=>row.id!==s.id))}/><span className="path">{s.cwd} · {sessionNames[s.state]}</span></label>)}</fieldset><label className="check"><input type="checkbox" checked={restart} onChange={e=>setRestart(e.target.checked)}/>{t("선택한 세션을 업데이트 후 다시 시작", "Restart selected sessions after updating")}</label>{stale&&<Notice tone="warning">{t("준비 결과가 변경되었습니다. 닫고 최신 결과를 다시 검토하세요.", "The preparation result changed. Close this dialog and review the latest result.")}</Notice>}<Button tone="primary" disabled={disabled||!!stale||!review.targetVersion||selected.some(row=>!candidates.some(s=>s.id===row.id&&s.generation===row.generation))||(restart&&!selected.length)} onClick={()=>{if(disabled||stale)return;void act({kind:'confirm',operationId:review.id,revision:review.revision,sessions:selected,restart,paneSessions:paneChoice}).then(ok=>{if(ok)setReview(null);});}}>{t("이 버전으로 업데이트 승인", "Approve update to this version")}</Button></Dialog>}{cancel&&<Dialog title={t("안전하게 취소할까요?", "Cancel safely?")} onClose={()=>setCancel(null)}><p>{t("되돌릴 수 없는 변경이 시작되기 전일 때만 취소됩니다. 서비스가 최신 상태를 다시 확인하며 취소 거절은 실패로 숨기지 않습니다.", "Cancellation is allowed only before irreversible changes start. The service checks current state; a rejected cancellation is reported explicitly.")}</p><Button disabled={disabled||!cancelCurrent||cancelCurrent.revision!==cancel.revision} onClick={()=>void act({kind:'cancel',operationId:cancel.id,revision:cancel.revision}).then(ok=>{if(ok)setCancel(null);})}>{t("취소 요청", "Request cancellation")}</Button></Dialog>}<CatalogUpdateHistory snapshot={snapshot} guardSnapshot={guardSnapshot} act={act} disabled={disabled}/></>;
}
function Policies({snapshot,act,disabled,onOpenCatalog}:{snapshot:AppSnapshot;act:Act;disabled:boolean;onOpenCatalog?:((id:CatalogId)=>void)|undefined}) {
  const {t} = useCopy();
  return <><Notice>{t("선택된 업데이트 대상의 자동 실행을 설정합니다. 켜면 바로 확인하고 이후 1시간마다 확인합니다. 설치·삭제·터미널 기본 설정은 CLI 상세에서 관리하세요.", "Schedule the selected update target. Enabling checks now and then hourly. Manage installations, removal and terminal defaults in CLI details.")}</Notice>{!snapshot.installations.length&&!snapshot.catalog?.some(entry=>entry.installed)&&<Notice>{t("정책을 설정할 설치가 없습니다.", "No installations available for a policy.")}</Notice>}{snapshot.installations.filter(i=>!usesCatalogUpdatePolicy(snapshot,i)).map(i=><Policy key={i.installationId} installation={i} policy={snapshot.policies.find(p=>p.installationId===i.installationId)} act={act} disabled={disabled}/>)}<CatalogUpdates snapshot={snapshot} act={act} disabled={disabled} onOpenCatalog={onOpenCatalog}/></>;
}
function Policy({installation:i,policy,act,disabled}:{installation:Installation;policy:UpdatePolicy|undefined;act:Act;disabled:boolean}) {
  const {t,explain}=useCopy();
  const enabled=!!policy&&policy.mode!=='off';
  const [pending,setPending]=useState(false);
  const busy=useRef(false);
  const toggle=async()=>{
    if(disabled||busy.current)return;
    busy.current=true;setPending(true);
    try{await act({kind:'automation',installationId:i.installationId,enabled:!enabled});}
    finally{busy.current=false;setPending(false);}
  };
  return <Panel>
    <div className="page-head"><h2 className="cli-heading"><AgentMark agent={i.family} size={24}/>{families[i.family]}</h2><button type="button" role="switch" aria-checked={enabled} aria-label={families[i.family]+' '+t('자동 업데이트','Automatic updates')} className="automation-switch" disabled={disabled||pending} onClick={()=>void toggle()}><span aria-hidden="true" className="switch-track"/>{pending?t('저장 중','Saving'):enabled?t('켜짐','On'):t('꺼짐','Off')}</button></div>
    <Facts items={[[t('설치된 버전','Installed version'),i.installedVersion.kind==='known'?i.installedVersion.version:t('조회 미지원','Lookup unavailable')]]}/>
    <p className="muted">{t('세션 처리 방식은 업데이트 화면의 자동 업데이트 설정에서 관리합니다.','Manage session behavior in Automatic update settings on the Updates page.')}</p>
    {policy?.waitingReason&&<Notice tone="warning">{explain(policy.waitingReason)}</Notice>}
  </Panel>;
}

