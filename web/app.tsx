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
import { catalogContainsInstallation, catalogSnapshot, dashboardAction, dashboardSummary, installedCatalog, supportedSnapshot } from './dashboard';
import { CatalogDashboardRow } from './catalog-dashboard';
import { CatalogBulkActions } from './catalog-bulk';
import type { CatalogId } from '../src/app/catalog-types';
import { isSupportedCli } from '../src/app/catalog-types';
import './workspace.css';

import { LanguageProvider, localeFor, useLanguage } from './i18n';

type Act = (command: AppCommand) => Promise<boolean>;
type View = 'dashboard' | 'installations' | 'sessions' | 'operations' | 'policies';
export function parseView(value: string | null): View {
  return value==='installations'||value==='sessions'||value==='operations'||value==='policies'?value:'dashboard';
}
const families: Record<Installation['family']|'gjc'|'opencode',string> = {omo:'OmO',omp:'OMP',pi:'Pi',claude:'Claude',codex:'Codex',gjc:'Gajae Code',opencode:'OpenCode',agy:'Antigravity',cursor:'Cursor',grok:'Grok'};
function useCopy() {
const {language,t} = useLanguage();
const viewNames: Record<View,string> = {dashboard:t("대시보드", "Dashboard"),installations:t("CLI 설치", "CLI installations"),sessions:t("터미널 세션", "Terminal sessions"),operations:t("업데이트 기록", "Update history"),policies:t("자동 업데이트", "Automatic updates")};
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
  const [view,setView] = useState<View>(()=>{try{return parseView(localStorage.getItem('cli-view'));}catch{return 'dashboard';}});
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
  const openCatalog=(id:CatalogId)=>{setCatalogDetail(id);onView('installations');};
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
      <nav aria-label={t("관리 화면", "Management views")}>{(Object.keys(viewNames) as View[]).map(key=><button key={key} aria-current={view===key?'page':undefined} onClick={()=>choose(key)}><Icon name={key}/>{viewNames[key]}</button>)}</nav>
      <div className="rail-footer"><Preferences/><ProjectLinks/></div><Button className="mobile-menu-close" onClick={closeMenu}>{t('메뉴 닫기','Close menu')}</Button>
    </dialog>
    <main id="main" tabIndex={-1}><div className="topbar"><span>{t("로컬 워크스페이스", "Local workspace")} <span className="muted">/ {viewNames[view]}</span></span><Badge tone={disabled||snapshot?.observationFailure?"neutral":"success"}>{snapshot?.observationFailure?t("프로세스 관찰 지연", "Process observation delayed"):disabled?t("관찰 / 연결 확인", "Check observations / connection"):t("서비스 연결됨", "Service connected")}</Badge></div><div className="content"><header className="page-head"><div><h1>{viewNames[view]}</h1><p className="muted">{view==='installations'?t('공식 출처와 설치 계획을 검토해 CLI를 설치하세요.','Review official sources and installation plans to install a CLI.'):t("CLI를 선택해 버전, 실행 세션과 자동화를 관리하세요.", "Choose a CLI to manage versions, running sessions and automation.")}</p></div>{snapshot&&<Button disabled={disabled} onClick={()=>void act({kind:'refresh'})}>{t("목록 새로고침", "Refresh list")}</Button>}</header>{snapshot?.observationFailure&&<Notice tone="warning">{t("세션은 마지막 관찰값입니다. 현재 실행 여부는 확인되지 않았습니다. 마지막 성공:", "Sessions show the last observations; running state is unknown. Last success:")} {snapshot.observedAt==null?t("확인 불가", "Unavailable"):stamp(snapshot.observedAt)}</Notice>}{children}{snapshot&&(view==='dashboard'?<Workspace snapshot={snapshot} act={act} disabled={disabled} onView={onView} onOpenCatalog={openCatalog}/>:view==='installations'?<Catalog snapshot={snapshot} act={act} disabled={disabled} initialDetailId={catalogDetail}/>:view==='sessions'?<Sessions snapshot={snapshot} act={act} disabled={disabled}/>:view==='operations'?<Operations snapshot={snapshot} act={act} disabled={disabled}/>:<Policies snapshot={snapshot} act={act} disabled={disabled} onOpenCatalog={openCatalog}/>)}</div></main></div>;
}
export function installationSnapshot(snapshot:AppSnapshot, installationId:string):AppSnapshot {
  return {...snapshot,installations:snapshot.installations.filter(i=>i.installationId===installationId),managed:snapshot.managed.filter(s=>s.installationId===installationId),external:snapshot.external.filter(s=>s.installationId===installationId),operations:snapshot.operations.filter(o=>o.installationId===installationId),policies:snapshot.policies.filter(p=>p.installationId===installationId)};
}
type DetailTab='overview'|'sessions'|'history'|'automation';
export function Workspace({snapshot,act,disabled,onView,onOpenCatalog}:{snapshot:AppSnapshot;act:Act;disabled:boolean;onView:(view:View)=>void;onOpenCatalog?:(id:CatalogId)=>void}) {
  const {t,installed,stamp,modes,explain}=useCopy();
  const [search,setSearch]=useState('');
  const [selected,setSelected]=useState<string|null>(null);
  const [tab,setTab]=useState<DetailTab>('overview');
  const id=React.useId();
  const tabs:Record<DetailTab,string>={overview:t('개요','Overview'),sessions:t('세션','Sessions'),history:t('기록','History'),automation:t('자동화','Automation')};
  const summary=dashboardSummary(snapshot);
  const outside=snapshot.external.filter(s=>s.processState!=='exited'&&!s.herdrPane);
  const open=(installationId:string,next:DetailTab)=>{setSelected(installationId);setTab(next);};
  const catalog=installedCatalog(snapshot);
  const query=search.toLowerCase().trim();
  const catalogVisible=catalog.filter(entry=>[entry.name,entry.executable,entry.installed?.path,...(entry.installations??[]).map(row=>row.path)].join(' ').toLowerCase().includes(query));
  const visible=snapshot.installations.filter(i=>!catalog.some(entry=>catalogContainsInstallation(entry,i))&&[families[i.family],i.executableRealpath,i.owner.kind==='unknown'?'':i.owner.prefix].join(' ').toLowerCase().includes(query));
  const actions={check:t('최신 확인','Check latest'),prepare:t('업데이트 준비','Prepare update'),review:t('준비 결과 확인','Review preparation'),progress:t('진행 상태 보기','View progress'),inspect:t('결과 확인 필요','Inspect result'),support:t('이유 보기','View reason')};
  return <div className="workspace-list">
    <CatalogBulkActions snapshot={snapshot} act={act} disabled={disabled}/>
    <section className="dashboard-summary" aria-label={t('현재 상태 요약','Current status summary')}>
      <div><span>{t('새 버전 있는 CLI','CLIs with new versions')}</span><strong>{summary.updates}</strong><small>{summary.unchecked?t('추가 확인 필요','More checks needed')+' · '+summary.unchecked:t('마지막 조회 기준','From the last checks')}</small></div>
      <button onClick={()=>onView('operations')}><span>{t('진행 및 확인할 작업','Open operations')}</span><strong>{summary.operations}</strong><small>{t('업데이트 기록 보기','View update history')} →</small></button>
      <button onClick={()=>onView('sessions')}><span>{t('실행 중 세션','Active sessions')}</span><strong>{summary.sessions??'—'}</strong><small>{summary.sessions===null?t('관찰 결과 확인 필요','Observation unavailable'):summary.unknownSessions?t('상태 미확인','Unknown state')+' · '+summary.unknownSessions:t('터미널 세션 보기','View terminal sessions')} →</small></button>
    </section>
    <div className="workspace-toolbar"><div className="stack"><SectionHead title={t('설치된 CLI','Installed CLIs')} count={summary.installed}/><p className="muted">{t('실행 여부와 관계없이 발견된 설치를 표시합니다. 최신 확인·업데이트 지원은 설치 방식에 따라 다릅니다.','Discovered installations are shown whether running or not. Check and update support depends on the installation method.')}</p></div><Button onClick={()=>onView('installations')}>{t('CLI 설치 목록','CLI installation catalog')} →</Button></div>
    {summary.installed>1&&<label className="field workspace-search">{t('CLI 또는 설치 경로 검색','Search CLI or installation path')}<input type="search" value={search} onChange={e=>setSearch(e.target.value)}/></label>}
    {!visible.length&&!catalogVisible.length&&<Notice>{summary.installed?t('검색 결과가 없습니다.','No matching installations.'):t('발견된 CLI 설치가 없습니다. CLI 설치 목록에서 검색 범위를 확인하세요.','No CLI installations discovered. Check the CLI installation catalog.')}</Notice>}
    {catalogVisible.map(entry=>{const scoped=catalogSnapshot(snapshot,entry);return <CatalogDashboardRow key={entry.id} entry={entry} snapshot={scoped} act={act} disabled={disabled} sessions={<Sessions snapshot={scoped} act={act} disabled={disabled}/>} history={<Operations snapshot={scoped} act={act} disabled={disabled}/>} automation={<Policies snapshot={scoped} act={act} disabled={disabled} onOpenCatalog={onOpenCatalog}/>}/>;})}
    {visible.map(i=>{
      const scoped=installationSnapshot(snapshot,i.installationId);
      const active=scoped.managed.filter(s=>['starting','ready','working','waiting','stopping','restarting'].includes(s.state));
      const policy=scoped.policies[0];const check=i.lastCheck?.result;
      const expanded=selected===i.installationId;const detailId=id+i.installationId;
      const action=dashboardAction(i,snapshot.operations);
      const latest=!check?t('최신 확인 전','Not checked'):check.kind==='update-available'?t('새 버전 있음','New version available'):check.kind==='up-to-date'?t('최신 버전','Up to date'):t('조회 불가','Check unavailable');
      return <section className="cli-entry" key={i.installationId}>
        <div className="cli-row"><div className="cli-identity"><h2 className="cli-heading"><AgentMark agent={i.family} size={24}/>{families[i.family]}<Badge tone={check?.kind==='up-to-date'?'success':'neutral'}>{latest}</Badge></h2>{action==='support'&&<><div className="cluster"><Badge tone="warning">{t('직접 업데이트 불가','Direct update unavailable')}</Badge></div><p className="muted">{i.family!=='omo'?t('이 CLI의 직접 업데이트는 아직 지원하지 않습니다.','Direct updates are not supported for this CLI yet.'):t('설치 출처를 확인하지 못했습니다.','The installation source could not be verified.')}</p></>}<p className="cli-version">{installed(i)}{check?.kind==='update-available'&&<> <span aria-label={t('업데이트 후','Available version')}>→ {check.availableVersion}</span></>}</p></div>
          <div className="cli-actions">{action!=='support'&&<Button tone="primary" disabled={disabled&&(action==='check'||action==='prepare')} onClick={()=>{if(action==='check'||action==='prepare'){void act({kind:action,installationId:i.installationId}).then(ok=>{if(ok&&action==='prepare')open(i.installationId,'history');});}else open(i.installationId,'history');}}>{actions[action]}</Button>}<Button aria-expanded={expanded} aria-controls={detailId} onClick={()=>{if(expanded)setSelected(null);else open(i.installationId,'overview');}}>{expanded?t('상세 닫기','Close details'):t('상세 보기','Details')}</Button></div>
          <dl className="cli-status"><div><dt>{t('실행 세션','Active sessions')}</dt><dd><Button className="status-link" aria-controls={detailId} onClick={()=>open(i.installationId,'sessions')}>{t('관리','Managed')} {active.length} · {t('herdr 창','herdr panes')} {snapshot.observationFailure||snapshot.observedAt==null?'—':scoped.external.filter(s=>s.herdrPane).length} →</Button></dd></div>
          <div><dt>{t('자동 업데이트','Automatic updates')}</dt><dd><Button className="status-link" aria-controls={detailId} onClick={()=>open(i.installationId,'automation')}>{modes[policy?.mode??'off']} →</Button></dd>{policy&&policy.mode!=='off'&&<dd className="muted">{t('다음 확인','Next check')}: {stamp(policy.nextCheckAt)}</dd>}{policy?.waitingReason&&<dd className="muted">{explain(policy.waitingReason)}</dd>}</div>
          <div><dt>{t('마지막 업데이트','Last verified update')}</dt><dd>{stamp(lastVerifiedUpdate(snapshot.operations,i.installationId))}</dd><dd className="muted">{t('버전 조회','Version checked')}: {stamp(i.lastCheck?.checkedAt??null)}</dd></div></dl>
        </div>
      {expanded&&<div className="cli-detail" id={detailId}><div className="detail-tabs" role="tablist" aria-label={t('CLI 상세','CLI details')}>{(Object.keys(tabs) as DetailTab[]).map((key,index)=><button type="button" key={key} id={detailId+'-'+key} role="tab" aria-selected={tab===key} aria-controls={detailId+'-panel'} tabIndex={tab===key?0:-1} onClick={()=>setTab(key)} onKeyDown={e=>{const keys=Object.keys(tabs) as DetailTab[];let next:number|undefined;if(e.key==='ArrowRight')next=(index+1)%keys.length;if(e.key==='ArrowLeft')next=(index+keys.length-1)%keys.length;if(e.key==='Home')next=0;if(e.key==='End')next=keys.length-1;if(next!==undefined){e.preventDefault();setTab(keys[next]!);(e.currentTarget.parentElement?.children[next] as HTMLElement).focus();}}}>{tabs[key]}</button>)}</div><div className="detail-content" id={detailId+'-panel'} role="tabpanel" aria-labelledby={detailId+'-'+tab} tabIndex={0}>
        {tab==='overview'?<Installations snapshot={scoped} act={async command=>{const ok=await act(command);if(ok&&command.kind==='prepare')setTab('history');return ok;}} disabled={disabled}/>:tab==='sessions'?<Sessions snapshot={scoped} act={act} disabled={disabled}/>:tab==='history'?<Operations snapshot={scoped} act={act} disabled={disabled}/>:<Policies snapshot={scoped} act={act} disabled={disabled}/>}
      </div></div>}
      </section>;
    })}
    {outside.length>0&&<p className="muted">{t(`herdr 밖에서 실행 중인 CLI ${outside.length}개는 관리하지 않습니다(일반 터미널, ChatGPT, 브라우저 확장 등).`,`${outside.length} CLI processes outside herdr are not managed (plain terminals, ChatGPT, browser extensions).`)}</p>}
  </div>;
}
function Installations({snapshot,act,disabled}:{snapshot:AppSnapshot;act:Act;disabled:boolean}) {
  const {t,stamp,explain} = useCopy();
  const [launch,setLaunch]=useState<Installation|null>(null); const [cwd,setCwd]=useState('');
  return <><Notice>{t("최신 버전 확인과 준비는 설치를 변경하지 않습니다. 준비가 끝나면 작업 화면에서 정확한 버전과 영향을 검토하세요.", "Checking and preparing do not change installations. Once prepared, review the exact version and impact in Update history.")}</Notice>{!snapshot.installations.length&&<Notice>{t("발견된 설치가 없습니다. CLI 설치 상태와 서비스 검색 범위를 확인하세요.", "No installations found. Check CLI installations and the service discovery scope.")}</Notice>}<div className="grid">{snapshot.installations.map(i=>{const check=i.lastCheck?.result; const supported=i.family==='omo'&&i.owner.kind!=='unknown';return <Panel key={i.installationId}><div className="page-head"><h2>{families[i.family]}</h2><Badge tone={supported?'neutral':'warning'}>{supported?t("관리 대상", "Managed installation"):t("직접 업데이트 불가", "Direct update unavailable")}</Badge></div><p className="path">{i.owner.kind==='unknown'?i.executableRealpath:i.owner.prefix}</p>{!supported&&<Notice tone="warning">{i.family!=='omo'?t('이 CLI의 직접 업데이트는 아직 지원하지 않습니다. 최신 버전 조회는 사용할 수 있습니다.','Direct updates are not supported for this CLI yet. Version checks remain available.'):t('설치 출처를 확인하지 못해 자동으로 파일을 변경할 수 없습니다. 표시된 설치 경로가 실제 사용하는 CLI인지 확인하세요.','The installation source could not be verified, so files cannot be changed automatically. Check that the path above is the CLI you use.')}</Notice>}<Facts items={[[t("설치된 버전", "Installed version"),i.installedVersion.kind==='known'?i.installedVersion.version:t("확인되지 않음", "Unknown")],[t("최신 버전", "Latest version"),!check?t("확인 전", "Not checked"):check.kind==='update-available'?check.availableVersion:check.kind==='up-to-date'?check.installedVersion:t("확인 불가", "Unavailable")],[t("관리 세션", "Managed sessions"),snapshot.managed.filter(s=>s.installationId===i.installationId&&!['stopped','failed'].includes(s.state)).length],[t("외부 세션", "External sessions"),snapshot.external.filter(s=>s.installationId===i.installationId).length]]}/>{check?.kind==='unavailable'&&<Notice tone={check.failure.code==='unsupported'?'warning':'error'}>{explain(check.failure.code)}</Notice>}<Facts items={[[t("최근 버전 확인", "Last version check"),stamp(i.lastCheck?.checkedAt??null)],[t("마지막 검증된 업데이트", "Last verified update"),lastVerifiedUpdate(snapshot.operations,i.installationId)===null?t("기록 없음 / 확인 불가", "No record / unavailable"):stamp(lastVerifiedUpdate(snapshot.operations,i.installationId))]]}/><div className="cluster"><Button disabled={disabled} onClick={()=>void act({kind:'check',installationId:i.installationId})}>{t("최신 버전 확인", "Check latest version")}</Button><Button disabled={disabled||!supported} onClick={()=>void act({kind:'prepare',installationId:i.installationId})}>{t("업데이트 준비", "Prepare update")}</Button><Button tone="primary" disabled={disabled||!supported} onClick={()=>{setLaunch(i);setCwd('');}}>{t("세션 시작", "Start session")}</Button></div></Panel>})}</div>{launch&&<Dialog title={t("관리 세션 시작", "Start managed session")} onClose={()=>setLaunch(null)}><p>{families[launch.family]} {t("를 선택한 폴더에서 시작합니다. 기존 OmO 설정과 시작 훅으로 실행합니다. 시작 후 작업 상태와 승인을 확인하세요.", "will start in the selected folder using existing OmO settings and startup hooks. Check its work state and approvals after launch.")}</p><form className="stack" onSubmit={e=>{e.preventDefault();void act({kind:'launch',installationId:launch.installationId,cwd}).then(ok=>{if(ok)setLaunch(null);});}}><label className="field">{t("작업 폴더의 절대 경로", "Absolute working directory path")}<input required pattern="/.*" value={cwd} onChange={e=>setCwd(e.target.value)} placeholder={t("/Users/이름/projects/프로젝트", "/Users/name/projects/project")}/></label><Button type="submit" tone="primary" disabled={disabled}>{t("세션 시작", "Start session")}</Button></form></Dialog>}</>;
}
function Sessions({snapshot,act,disabled}:{snapshot:AppSnapshot;act:Act;disabled:boolean}) {
  const {t,stamp,installed,title,explain} = useCopy();
  const shown=snapshot.external.filter(s=>s.herdrPane);
  const outside=snapshot.external.filter(s=>s.processState!=='exited'&&!s.herdrPane);
  return <>
    {!!(snapshot.native?.selections.length || snapshot.native?.jobs.length) && <NativeRestarts snapshot={snapshot} act={act} disabled={disabled}/>}
    <p className="muted">{t('최근 실행 상태 확인:','Last process check:')} {snapshot.observedAt==null?t('아직 확인 전','Not checked'):stamp(snapshot.observedAt)}</p>
    {snapshot.observationFailure&&<Notice tone="warning">{t('실행 상태를 갱신하지 못했습니다. 아래는 마지막으로 확인한 정보입니다.','Process refresh failed. These are the last confirmed observations.')} {explain(snapshot.observationFailure)}</Notice>}
    <SectionHead title={t('업데이터에서 시작한 세션','Sessions started by the updater')} count={snapshot.managed.length}/>
    {!snapshot.managed.length&&<Notice>{t('업데이터에서 직접 시작한 세션이 없습니다.','No sessions were started by the updater.')}</Notice>}
    {snapshot.managed.map(s=><Session key={s.id} session={s} name={title(snapshot,s.installationId)} family={snapshot.installations.find(i=>i.installationId===s.installationId)?.family} installedVersion={installed(snapshot.installations.find(i=>i.installationId===s.installationId))} act={act} disabled={disabled}/>)}
    <SectionHead title={t('herdr 창의 CLI','CLIs in herdr panes')} count={shown.length}/>
    {outside.length>0&&<p className="muted">{t(`herdr 밖 실행 ${outside.length}개는 관리하지 않아 표시하지 않습니다.`,`${outside.length} processes outside herdr are not managed and not listed.`)}</p>}
    <p className="muted">{t('지원 CLI 7종 외의 세션은 여기에서 상태만 확인할 수 있습니다. 업데이트와 재시작은 지원하지 않으며, herdr 창에서 직접 사용하세요.','Sessions outside the seven supported CLIs are observation-only here. Updates and restarts are not supported; use their herdr terminal panes directly.')}</p>
    {!shown.length&&<Notice>{t('herdr 창에서 실행 중인 CLI가 없습니다.','No CLI processes in herdr panes.')}</Notice>}
    {shown.map(s=>{
      const linked=s.installationId?snapshot.installations.find(i=>i.installationId===s.installationId):null;
      const catalog=s.catalogId?snapshot.catalog?.find(c=>c.id===s.catalogId):null;
      const supported=isSupportedCli(s.family??s.catalogId??linked?.family);
      const disk=s.diskPackage?.version??(linked?.installedVersion.kind==='known'?linked.installedVersion.version:catalog?.installed?.version??null);
      const state=snapshot.observationFailure?'unknown':s.processState??'observed';
      const project=s.cwd?.split('/').filter(Boolean).at(-1);
      const checkedAt=s.observedAt??snapshot.observedAt;
      const label=s.conversation?.title??project??(s.tty?`${t('터미널','Terminal')} ${s.tty}`:t('백그라운드 프로세스','Background process'));
      const source=s.parentCliPid?t(`다른 CLI(PID ${s.parentCliPid})가 실행한 하위 프로세스`,`Child of another CLI (PID ${s.parentCliPid})`):s.herdrPane?t(`herdr 창 ${s.herdrPane.paneId}`,`herdr pane ${s.herdrPane.paneId}`):s.origin==='herdr'?t('herdr에서 실행 · 창 미확인','Started in herdr · pane unknown'):s.origin==='chatgpt'?t('ChatGPT에서 실행','Started by ChatGPT'):s.origin==='vscode'?t('VS Code에서 실행','Started by VS Code'):s.tty?t('터미널에서 실행','Started in a terminal'):t('백그라운드 실행','Background process');
      const startedAtMs=s.startedAt?Date.parse(s.startedAt):null;
      const updatedSince=startedAtMs!=null&&(s.installationId&&(lastVerifiedUpdate(snapshot.operations,s.installationId)??0)>startedAtMs
        ||(snapshot.catalogUpdates??[]).some(job=>job.catalogId===s.catalogId&&job.stage==='completed'&&job.beforeVersion!==job.installedVersion&&job.updatedAt>startedAtMs));
      const paneJob=(snapshot.paneRestarts??[]).filter(job=>job.paneId===s.herdrPane?.paneId&&(job.sessionId===s.id||!['completed','failed'].includes(job.stage))).sort((a,b)=>b.createdAt-a.createdAt)[0];
      const paneBusy=!!paneJob&&!['completed','failed'].includes(paneJob.stage);
      const paneStatus=s.omoActivity??s.herdrPane?.status;
      const screenIdleHint=paneStatus==='working'&&s.herdrPane?.screenIdle===true&&s.herdrPane.cpuQuiet===true;
      const paneStatusLabel=screenIdleHint?t(`작업 중(herdr) · 화면은 입력 대기 · CPU ${s.herdrPane!.cpuPercent}% · 상태 미갱신 의심`,`Working (herdr) · screen idle · CPU ${s.herdrPane!.cpuPercent}% · status may be stale`):paneStatus==='working'?t('작업 중','Working'):paneStatus==='blocked'?t('응답 대기 중','Waiting for your answer'):paneStatus==='idle'||paneStatus==='done'?t('대기 중','Idle'):t('상태 미확인','Status unknown');
      const paneStageLabel=paneJob?{'waiting-idle':t('작업이 끝나기를 기다리는 중','Waiting for work to finish'),exiting:t('종료 중','Exiting'),resuming:t('같은 대화로 다시 시작 중','Resuming the same conversation'),completed:t('재시작 완료','Restart completed'),failed:t('재시작 실패','Restart failed')}[paneJob.stage]:null;
      const installSource=linked?t('관리 대상 설치','Managed installation'):/\/herdr-cli-updater\/(?:isolated|operating|single-session)/.test(s.executable)?t('업데이터 검증용 설치','Updater test installation'):s.catalogId?t('다른 설치','Other installation'):null;
      if(!supported)return <Panel key={`${s.id}:${s.startedAt??'unknown'}`}>
        <div className="cluster"><h3>{label}</h3><Badge>{t('아직 지원하지 않음','Not yet supported')}</Badge></div>
        <p className="muted">{s.family??s.catalogId??t('CLI 종류 미확인','Unknown CLI')} · {source} · {state==='exited'?t('종료 확인','Exit observed'):state==='unknown'?t('현재 상태 미확인','Current state unknown'):paneStatusLabel}</p>
        {s.cwd&&<p className="path">{s.cwd}</p>}
        <Notice>{t('터미널 세션에서만 확인할 수 있습니다. 이 CLI의 설치 관리, 업데이트, 자동 업데이트와 재시작은 아직 지원하지 않습니다. herdr 창에서 계속 사용하세요.','Visible only in Terminal sessions. Installation management, updates, automatic updates and restarts are not yet supported for this CLI. Continue using its herdr pane.')}</Notice>
        <details><summary>{t('실행 상세','Process details')}</summary><Facts items={[[t('터미널','Terminal'),s.tty??t('미확인','Unknown')],['PID',s.pid],[t('실행 파일','Executable'),<span className="path">{s.executable}</span>],[t('마지막 상태 확인','Last process check'),checkedAt==null?t('아직 확인 전','Not checked'):stamp(checkedAt)]]}/></details>
      </Panel>;
      return <Panel key={`${s.id}:${s.startedAt??'unknown'}`}>
        <div className="cluster"><h3 className="cli-heading"><AgentMark agent={s.family??linked?.family??'unknown'} size={24}/>{label}</h3><Badge>{state==='exited'?t('종료 확인','Exit observed'):state==='unknown'?t('현재 상태 미확인','Current state unknown'):t('프로세스 관측됨','Process observed')}</Badge>{s.isCurrentConversation&&state==='observed'&&<Badge>{t('지금 대화 중인 세션','Current conversation')}</Badge>}{s.herdrPane&&state==='observed'&&<Badge tone={paneStatus==='working'?'warning':'neutral'}>{paneStatusLabel}</Badge>}{!s.herdrPane&&state==='observed'&&<Badge>{s.parentCliPid?t('하위 프로세스 · 관리 안 함','Child process · not managed'):t('herdr 밖 · 관리 안 함','Outside herdr · not managed')}</Badge>}</div>
        <p className="muted">{catalog?.name??Object.entries(families).find(([id])=>id===(s.family??s.catalogId))?.[1]??s.family??s.catalogId??t('CLI 종류 미확인','Unknown CLI')} · {source} · {s.tty??t('터미널 없음','No terminal')}{installSource&&<> · {installSource}</>}</p>
        {s.cwd&&<p className="path">{s.cwd}</p>}
        <Facts items={[[t('실행 중인 버전','Running version'),s.runningVersion??t('CLI 버전 미확인','CLI version unknown')],...(s.runningEngineVersion?[[t('실행 엔진 버전','Running engine version'),s.runningEngineVersion] as const]:[]),[t('마지막 상태 확인','Last process check'),checkedAt==null?t('아직 확인 전','Not checked'):stamp(checkedAt)]]}/>
        {s.omoActivity==='unknown'&&<Notice>{t('대화는 연결됐지만 이 CLI 버전은 백그라운드 작업 전체의 종료 여부를 제공하지 않습니다. 안전한 자동 재시작은 아직 확인할 수 없습니다.','The conversation is linked, but this CLI version does not expose whether all background work has finished. Safe automatic restart cannot yet be confirmed.')}</Notice>}
        {(updatedSince||s.runningVersionEvidence==='started-before-install')&&state!=='exited'?<Notice tone="warning">{t('이 세션이 시작된 뒤 설치가 바뀌었습니다. 이 프로세스는 시작 때 버전으로 계속 실행 중이며, 작업을 마친 뒤 같은 대화로 다시 시작하면 새 버전이 적용됩니다.','The installation changed after this session started. This process still runs its launch-time build; restart it in the same conversation after finishing your work to pick up the new version.')}</Notice>:s.runningVersionEvidence==='started-after-install'?<p className="muted">{t('세션 시작 이후 설치 파일이 바뀌지 않아 디스크의 버전이 실행 중인 버전입니다.','The installation has not changed since this session started, so the disk version is the running one.')}</p>:!s.runningVersion&&<p className="muted">{t('시작 시각이나 패키지 정보가 없어 실행 버전을 판정할 수 없습니다.','No start time or package information, so the running version cannot be determined.')}</p>}
        {!s.conversation&&<p className="muted">{t('대화 연결 미확인 · 작업 폴더와 터미널로 구분하세요.','Conversation not identified · use the working directory and terminal to distinguish it.')}</p>}
        {s.herdrPane&&state==='observed'&&s.family&&['omo','omp','pi','claude','codex'].includes(s.family)&&<div className="stack"><div className="cluster"><Button tone="primary" disabled={disabled||paneBusy||paneStatus==='blocked'||s.omoActivity==='unknown'} onClick={()=>void act({kind:'pane-restart',sessionId:s.id,paneId:s.herdrPane!.paneId})}>{paneStatus==='working'?t('작업 끝나면 같은 대화로 다시 시작','Restart in the same conversation when work finishes'):t('같은 대화로 다시 시작','Restart in the same conversation')}</Button>{screenIdleHint&&<Button disabled={disabled||paneBusy} onClick={()=>void act({kind:'pane-restart',sessionId:s.id,paneId:s.herdrPane!.paneId,trustScreen:true})}>{t('화면 기준으로 지금 다시 시작','Restart now, trusting the screen')}</Button>}{paneStageLabel&&<Badge tone={paneJob!.stage==='failed'?'error':paneJob!.stage==='completed'?'success':'neutral'}>{paneStageLabel}</Badge>}</div><p className="muted">{t('herdr 창에 종료 명령과 재개 명령을 입력합니다. 강제 종료하지 않으며 작업 중이면 끝날 때까지 기다립니다.','Types the exit and resume commands into the herdr pane. Nothing is force-killed; a working agent is waited for.')}</p>{paneJob?.failure&&<Notice tone="error">{({pane_changed:t('창의 프로세스가 바뀌어 중단했습니다.','The pane process changed; stopped.'),agent_blocked:t('에이전트가 응답을 기다리고 있어 중단했습니다. 먼저 답하세요.','The agent is waiting for your answer; answer it first.'),idle_wait_timeout:t('작업이 시간 안에 끝나지 않았습니다.','Work did not finish in time.'),exit_not_observed:t('종료 명령 후 프로세스가 남아 있습니다. 강제 종료하지 않았습니다.','The process stayed after the exit command; it was not force-killed.'),resume_id_not_found:t('재개용 대화 ID를 화면에서 찾지 못했습니다. 창에서 직접 다시 시작하세요.','Could not find the resume ID on screen; restart manually in the pane.'),resume_not_observed:t('재개 명령 후 새 프로세스가 확인되지 않았습니다.','No new process was observed after the resume command.')} as Record<string,string>)[paneJob.failure]??paneJob.failure}</Notice>}{paneJob?.stage==='completed'&&<p className="muted">PID {paneJob.previousPid} → {paneJob.resumedPid} · {paneJob.resumeId}</p>}</div>}
        <details><summary>{t('실행 상세','Process details')}</summary>
          <Facts items={[[t('현재 디스크 설치 버전','Current version on disk'),disk??t('조회 미지원','Lookup unavailable')],[t('터미널','Terminal'),s.tty??t('터미널 없음 · 백그라운드','No terminal · background')],['PID',s.pid],[t('시작 시각','Started at'),s.startedAt?stamp(Date.parse(s.startedAt)):t('기록 없음','Not recorded')],[t('대화 ID','Conversation ID'),s.conversation?.id??t('미확인','Unknown')],[t('실행 파일','Executable'),<span className="path">{s.executable}</span>],[t('패키지','Package'),s.diskPackage?.name??t('연결되지 않음','Not linked')]]}/>
          <p className="muted">{s.herdrPane?t(`herdr 창 ${s.herdrPane.paneId} · 키 입력 방식 재시작`,`herdr pane ${s.herdrPane.paneId} · keyboard-style restart`):(s.parentCliPid?t('다른 CLI의 하위 프로세스 · 관리 대상 아님','Child of another CLI · not managed'):t('herdr 밖 실행 · 관리 대상 아님','Outside herdr · not managed'))}</p>
        </details>
      </Panel>;
    })}
  </>;
}
function Session({session:s,name,family,installedVersion,act,disabled}:{session:ManagedSession;name:string;family:Installation['family']|undefined;installedVersion:string;act:Act;disabled:boolean}) {
  const {t,sessionNames,stamp,explain} = useCopy();
  const [message,setMessage]=useState(''); const [confirm,setConfirm]=useState<AppCommand|null>(null); const [approval,setApproval]=useState<ManagedSession|null>(null); const [answer,setAnswer]=useState('');
  const active=['ready','working','waiting'].includes(s.state);
  const stale=confirm&&'generation' in confirm&&confirm.generation!==s.generation;
  const approvalStale=approval&&(approval.generation!==s.generation||approval.approval?.id!==s.approval?.id);
  return <Panel><div className="page-head"><h3 className="cli-heading">{family&&<AgentMark agent={family} size={24}/>}<span>{name} {t("관리 세션", "Managed sessions")}</span></h3><Badge tone={tone(s.state)}>{sessionNames[s.state]}</Badge></div><p className="path">{s.cwd}</p><Facts items={[[t("CLI 종류", "CLI type"),name],[t("터미널 TTY", "Terminal TTY"),t("관리 연결 / TTY 확인 불가", "Managed connection / TTY unavailable")],["PID",s.pid??t("확인되지 않음", "Unknown")],[t("시작 시각", "Started at"),t("기록되지 않음", "Not recorded")],[active?t("실행 중인 버전", "Running version"):t("마지막 실행 버전", "Last launched version"),s.launchedVersion??t("확인되지 않음", "Unknown")],[t("설치된 버전", "Installed version"),installedVersion],[t("최근 세션 확인", "Last session check"),stamp(s.updatedAt)]]}/><details><summary>{t('기술 정보','Technical details')}</summary><Facts items={[[t('내부 엔진 버전','Internal engine version'),s.engineVersion??t('확인되지 않음','Unknown')]]}/><p className="muted">{t('내부 엔진 버전은 CLI가 알려주는 기술 정보이며 설치된 패키지 버전과 다를 수 있습니다. 실행 버전은 세션을 시작할 때 확인한 CLI 버전입니다.','The internal engine version is reported by the CLI and may differ from the installed package. The running version was recorded when the session started.')}</p></details>{s.failure&&<Notice tone="error">{explain(s.failure)}</Notice>}<div className="cluster"><Button tone="danger" disabled={disabled||!active} onClick={()=>setConfirm({kind:'stop',sessionId:s.id,generation:s.generation})}>{t("안전하게 종료", "Stop safely")}</Button><Button disabled={disabled||!['ready','working','waiting','stopped'].includes(s.state)} onClick={()=>setConfirm({kind:'restart',sessionId:s.id,generation:s.generation})}>{t("같은 세션 다시 시작", "Restart same session")}</Button></div><h4>{t("세션 출력", "Session output")}</h4><pre className="console" tabIndex={0} aria-label={t(`${name} 세션 출력`, `${name} session output`)}>{s.output.length?s.output.join('\n'):t("아직 출력이 없습니다.", "No output yet.")}</pre>{s.approval&&<Notice tone="warning">{t("세션이 사용자의 답변을 기다립니다.", "The session is waiting for your response.")}<Button disabled={disabled} onClick={()=>{setApproval(s);setAnswer('');}}>{t("요청 내용 검토", "Review request")}</Button></Notice>}<form className="stack" onSubmit={e=>{e.preventDefault();void act({kind:'send',sessionId:s.id,generation:s.generation,message}).then(ok=>{if(ok)setMessage('');});}}><label className="field">{t("세션에 보낼 메시지", "Message to send to session")}<textarea required value={message} onChange={e=>setMessage(e.target.value)} disabled={disabled||!active||!!s.approval}/></label><Button tone="primary" type="submit" disabled={disabled||!active||!!s.approval||!message.trim()}>{t("메시지 보내기", "Send message")}</Button></form>{confirm&&<Dialog title={confirm.kind==='stop'?t("세션을 안전하게 종료할까요?", "Stop this session safely?"):t("같은 세션을 다시 시작할까요?", "Restart the same session?")} onClose={()=>setConfirm(null)}><p className="path">{s.cwd}</p><p>{t("현재 작업을 중단하지 않습니다. 안전한 종료 조건을 확인한 뒤 처리하며, 진행 중이면 서비스가 대기 사유를 알립니다.", "Current work will not be interrupted. The service checks safe shutdown conditions and reports why it is waiting if work is in progress.")}</p>{stale&&<Notice tone="warning">{t("세션이 변경되었습니다. 닫고 최신 상태에서 다시 검토하세요.", "The session changed. Close this dialog and review its latest state.")}</Notice>}<Button tone={confirm.kind==='stop'?'danger':'primary'} disabled={disabled||!!stale} onClick={()=>void act(confirm).then(ok=>{if(ok)setConfirm(null);})}>{t("검토한 작업 실행", "Run reviewed operation")}</Button></Dialog>}{approval?.approval&&<Dialog title={t("세션 요청에 답변", "Respond to session request")} onClose={()=>setApproval(null)}><p className="path">{approval.approval.title}</p>{approvalStale&&<Notice tone="warning">{t("요청이 바뀌거나 종료되었습니다. 최신 요청을 다시 여세요.", "The request changed or ended. Reopen the latest request.")}</Notice>}{approval.approval.method==='confirm'?<div className="cluster">{[false,true].map(value=><Button key={String(value)} tone={value?'primary':'secondary'} disabled={disabled||!!approvalStale} onClick={()=>void act({kind:'respond',sessionId:s.id,generation:approval.generation,approvalId:approval.approval!.id,value}).then(ok=>{if(ok)setApproval(null);})}>{value?t("승인", "Approve"):t("거절", "Reject")}</Button>)}</div>:<form className="stack" onSubmit={e=>{e.preventDefault();void act({kind:'respond',sessionId:s.id,generation:approval.generation,approvalId:approval.approval!.id,value:answer}).then(ok=>{if(ok)setApproval(null);});}}>{approval.approval.method==='select'?<Select label={t('답변','Response')} value={answer} options={[{value:'',label:t('선택하세요','Select an option'),disabled:true},...approval.approval.options.map(value=>({value,label:value}))]} onChange={setAnswer} disabled={disabled||!!approvalStale}/>:<label className="field">{t('답변','Response')}<textarea required value={answer} onChange={e=>setAnswer(e.target.value)}/></label>}<Button type="submit" tone="primary" disabled={disabled||!!approvalStale||!answer}>{t("답변 보내기", "Send response")}</Button></form>}</Dialog>}</Panel>;
}

function Operations({snapshot,act,disabled}:{snapshot:AppSnapshot;act:Act;disabled:boolean}) {
  const {t,sessionNames,stages,kinds,stamp,title,explain} = useCopy();
  const [review,setReview]=useState<AppOperation|null>(null); const [selected,setSelected]=useState<{id:string;generation:number}[]>([]); const [restart,setRestart]=useState(false); const [cancel,setCancel]=useState<AppOperation|null>(null);
  const [paneChoice,setPaneChoice]=useState<PaneSessionPolicy>('restart-idle');
  const current=review&&snapshot.operations.find(o=>o.id===review.id); const stale=review&&(!current||current.revision!==review.revision||current.stage!=='ready');
  const candidates=review?snapshot.managed.filter(s=>s.installationId===review.installationId&&!['stopped','failed'].includes(s.state)):[];
  const cancelCurrent=cancel&&snapshot.operations.find(o=>o.id===cancel.id);
  return <>{!snapshot.operations.length&&!catalogHistory(snapshot).length&&<Notice>{t("아직 작업이 없습니다. 설치 화면에서 업데이트를 준비하세요.", "No operations yet. Prepare an update in CLI installations.")}</Notice>}{[...snapshot.operations].reverse().map(o=><Panel key={o.id}><div className="page-head"><h2>{title(snapshot,o.installationId)} · {kinds[o.kind]}</h2><Badge tone={tone(o.stage)}>{stages[o.stage]}</Badge></div><Facts items={[...((o.kind==='prepare'||o.kind==='update')?([[t("변경 전", "Before update"),o.beforeVersion??t("확인되지 않음", "Unknown")],[t("준비한 목표 버전", "Prepared target version"),o.targetVersion??t("준비 중 / 확인 필요", "Preparing / needs checking")],[t("검증된 설치 버전", "Verified installed version"),o.installedVersion??t("검증 전", "Not verified")]] as const):[]),[t("선택한 관리 세션", "Selected managed sessions"),t(`${o.sessionIds.length}개`, `${o.sessionIds.length} ${o.sessionIds.length === 1 ? 'session' : 'sessions'}`)],[t("세션 다시 시작", "Restart session"),o.restart?t("승인됨", "Approved"):t("하지 않음", "No")],...(o.externalSessionIds?.length?[[t("업데이트 당시 실행 중이던 세션", "Sessions running at update time"),t(`${o.externalSessionIds.length}개 · ${paneSessionLabels(t)[o.paneSessions??'keep'][0]}`, `${o.externalSessionIds.length} · ${paneSessionLabels(t)[o.paneSessions??'keep'][0]}`)]] as const:[]),[t("마지막 변경", "Last changed"),stamp(o.updatedAt)]]}/><ol className="steps" aria-label={t("작업 진행 단계", "Operation progress")}>{(o.kind==='stop'?(['waiting','stopping','completed'] as const):o.kind==='restart'?(['waiting','stopping','restarting','completed'] as const):(['preparing','ready','waiting','stopping','updating','verifying','restarting','completed'] as const)).map(stage=><li key={stage} aria-current={o.stage===stage?'step':undefined}>{stages[stage]}</li>)}</ol>{!!o.paneResults?.length&&<details open={o.paneResults.some(r=>r.outcome==='pending')}><summary>{t('herdr 창 세션 다시 시작','herdr-pane session restarts')} · {o.paneResults.filter(r=>r.outcome==='completed').length}/{o.paneResults.length}</summary><ul className="stack">{o.paneResults.map(r=>{const session=snapshot.external.find(s=>s.id===r.sessionId);const label=session?.cwd?.split('/').filter(Boolean).at(-1)??r.paneId;const outcome={pending:t('진행 중','In progress'),completed:t(`완료 · PID ${r.previousPid} → ${r.resumedPid}`,`Done · PID ${r.previousPid} → ${r.resumedPid}`),failed:t(`실패 · ${r.failure??''}`,`Failed · ${r.failure??''}`),'skipped-working':t('작업 중이라 건드리지 않음 · 직접 다시 시작 필요','Left alone (working) · restart manually'),'skipped-blocked':t('응답 대기 중이라 건드리지 않음','Left alone (waiting for an answer)')}[r.outcome];return <li key={r.sessionId}><Badge tone={r.outcome==='completed'?'success':r.outcome==='failed'?'error':r.outcome==='pending'?'neutral':'warning'}>{outcome}</Badge> {label} <span className="muted">({r.paneId})</span></li>;})}</ul></details>}{o.failure&&<Notice tone="error">{explain(o.failure)}</Notice>}{o.detail&&<details><summary>{t("진단 정보", "Diagnostics")}</summary><p className="path">{o.detail}</p></details>}{o.stage==='uncertain'&&o.failure==='restart_unverified'&&o.installedAt!=null&&<Notice tone="warning">{t('설치 업데이트는 검증됐지만 일부 세션의 재시작이 남았습니다. 완료한 세션은 유지하고, 소유권과 대화가 확인된 나머지만 복구합니다.','The update is verified, but some session restarts remain. Keep completed sessions and recover only remaining sessions with verified ownership and conversation identity.')}<Button disabled={disabled} onClick={()=>void act({kind:'refresh'})}>{t('남은 세션 복구','Recover remaining sessions')}</Button></Notice>}{o.stage==='uncertain'&&!(o.failure==='restart_unverified'&&o.installedAt!=null)&&<Notice tone="warning">{t("실제 변경 결과가 확인되지 않았습니다. 재실행하지 말고 현재 설치와 세션 상태를 확인하세요.", "The actual change is unconfirmed. Do not rerun it; check current installation and session state.")}</Notice>}{o.stage==='ready'&&<Button tone="primary" disabled={disabled||!o.targetVersion} onClick={()=>{setReview(o);setSelected([]);setRestart(false);setPaneChoice(snapshot.policies.find(p=>p.installationId===o.installationId)?.paneSessions??'restart-idle');}}>{t("업데이트 영향 검토", "Review update impact")}</Button>}{['preparing','ready','waiting'].includes(o.stage)&&<Button disabled={disabled} onClick={()=>setCancel(o)}>{t("안전한 취소 검토", "Review safe cancellation")}</Button>}{['stopping','updating','verifying','restarting'].includes(o.stage)&&<p className="muted">{t("변경이 시작된 작업은 이 화면에서 취소하지 않습니다. 브라우저를 닫아도 작업은 계속됩니다.", "Operations that have started making changes cannot be cancelled here. They continue after the browser closes.")}</p>}</Panel>)}{review&&<Dialog title={t("업데이트를 승인할까요?", "Approve this update?")} onClose={()=>setReview(null)}><Facts items={[[t("설치", "Installation"),title(snapshot,review.installationId)],[t("현재 버전", "Current version"),review.beforeVersion??t("확인되지 않음", "Unknown")],[t("목표 버전", "Target version"),review.targetVersion??t("확인되지 않음", "Unknown")]]}/><p>{t("서비스가 새 관리 세션 진입을 막고 안전한 종료를 기다린 후 설치를 변경하고 검증합니다. 외부 세션은 종료하지 않으며 시작할 때의 버전으로 계속 실행됩니다. 새 버전은 해당 세션을 직접 다시 시작할 때 적용됩니다.", "The service blocks new managed sessions, waits for safe shutdown, then updates and verifies the installation. External sessions are not stopped and keep running their launched version; the new version applies when you restart them yourself.")}</p>{(()=>{const outside=snapshot.external.filter(s=>s.installationId===review.installationId&&s.processState!=='exited');const inPane=outside.filter(s=>s.herdrPane);const idle=inPane.filter(s=>s.herdrPane!.status==='idle'||s.herdrPane!.status==='done').length;const working=inPane.filter(s=>s.herdrPane!.status==='working').length;const blocked=inPane.filter(s=>s.herdrPane!.status==='blocked').length;const outsideHerdr=outside.length-inPane.length;return outside.length?<div className="stack"><Notice tone="warning">{t(`이 설치를 사용하는 세션 ${outside.length}개: herdr 창 ${inPane.length}개(대기 ${idle} · 작업 중 ${working}${blocked?` · 응답 대기 ${blocked}`:''})${outsideHerdr?` · herdr 밖 ${outsideHerdr}개는 관리하지 않습니다`:''}.`,`${outside.length} sessions use this installation: ${inPane.length} in herdr panes (${idle} idle · ${working} working${blocked?` · ${blocked} waiting for an answer`:''})${outsideHerdr?` · ${outsideHerdr} outside herdr are not managed`:''}.`)}</Notice>{inPane.length>0&&<PaneSessionChoice value={paneChoice} disabled={disabled} compact onChange={setPaneChoice}/>}</div>:null;})()}<fieldset className="stack"><legend>{t("작업에 포함할 관리 세션", "Managed sessions to include")}</legend>{!candidates.length&&<p className="muted">{t("선택할 실행 중 관리 세션이 없습니다.", "No running managed sessions to select.")}</p>}{candidates.map(s=><label className="check" key={s.id}><input type="checkbox" checked={selected.some(row=>row.id===s.id)} onChange={e=>setSelected(e.target.checked?[...selected,{id:s.id,generation:s.generation}]:selected.filter(row=>row.id!==s.id))}/><span className="path">{s.cwd} · {sessionNames[s.state]}</span></label>)}</fieldset><label className="check"><input type="checkbox" checked={restart} onChange={e=>setRestart(e.target.checked)}/>{t("선택한 세션을 업데이트 후 다시 시작", "Restart selected sessions after updating")}</label>{stale&&<Notice tone="warning">{t("준비 결과가 변경되었습니다. 닫고 최신 결과를 다시 검토하세요.", "The preparation result changed. Close this dialog and review the latest result.")}</Notice>}<Button tone="primary" disabled={disabled||!!stale||!review.targetVersion||selected.some(row=>!candidates.some(s=>s.id===row.id&&s.generation===row.generation))||(restart&&!selected.length)} onClick={()=>void act({kind:'confirm',operationId:review.id,revision:review.revision,sessions:selected,restart,paneSessions:paneChoice}).then(ok=>{if(ok)setReview(null);})}>{t("이 버전으로 업데이트 승인", "Approve update to this version")}</Button></Dialog>}{cancel&&<Dialog title={t("안전하게 취소할까요?", "Cancel safely?")} onClose={()=>setCancel(null)}><p>{t("되돌릴 수 없는 변경이 시작되기 전일 때만 취소됩니다. 서비스가 최신 상태를 다시 확인하며 취소 거절은 실패로 숨기지 않습니다.", "Cancellation is allowed only before irreversible changes start. The service checks current state; a rejected cancellation is reported explicitly.")}</p><Button disabled={disabled||!cancelCurrent||cancelCurrent.revision!==cancel.revision} onClick={()=>void act({kind:'cancel',operationId:cancel.id,revision:cancel.revision}).then(ok=>{if(ok)setCancel(null);})}>{t("취소 요청", "Request cancellation")}</Button></Dialog>}<CatalogUpdateHistory snapshot={snapshot}/></>;
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
    <PaneSessionChoice value={policy?.paneSessions??'restart-idle'} disabled={disabled||pending} onChange={value=>void act({kind:'policy',installationId:i.installationId,mode:policy?.mode??'off',intervalMinutes:policy?.intervalMinutes??60,firstCheck:policy?.firstCheck??'now',paneSessions:value})}/>
    {policy?.waitingReason&&<Notice tone="warning">{explain(policy.waitingReason)}</Notice>}
  </Panel>;
}

