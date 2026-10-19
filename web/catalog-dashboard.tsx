import { useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { AppCommand, AppSnapshot, PaneSessionPolicy } from '../src/app/types';
import type { CatalogEntry, CatalogInstallation } from '../src/app/catalog-types';
import { PaneSessionChoice } from './pane-session-choice';
import type { CatalogUpdateJob } from '../src/app/catalog-updates';
import { AgentMark } from './agent-mark';
import { CatalogInstallations, installationControlsBlocked } from './catalog-installations';
import { CatalogCleanup } from './catalog-cleanup';
import { CatalogPolicy, CatalogUpdateHistory, CatalogUpdateReviewFacts, catalogReviewBinding, catalogUpdateTargetMatches, UpdateExplanation } from './catalog-updates';
import { workspaceBusy } from './automation-settings';
import { Badge, Button, Dialog, Notice } from './primitives';
import { localeFor, useLanguage } from './i18n';
import { versionStatusLabel } from './install-status';

type Translate=(ko:string,en:string)=>string;
type Tab='overview'|'sessions'|'history'|'automation'|'installations';
type Props={readonly entry:CatalogEntry;readonly snapshot:AppSnapshot;readonly guardSnapshot?:AppSnapshot;readonly act:(command:AppCommand)=>Promise<boolean>;
  readonly disabled:boolean;readonly sessions:ReactNode;readonly history:ReactNode;readonly automation:ReactNode;
  readonly routes?:ReactNode};

/** Machine-consumed through data-reason; never derived from translated prose. */
export type UpdateBlockReason='not_checked'|'checking'|'current'|'ahead'|'not_comparable'|'check_failed'|'unsupported'
  |'inventory_checking'|'inventory_failed'|'no_selected_installation'|'owner_unverified'|'service_unavailable';
export type UpdateAction={readonly kind:'update'|'review'|'progress'|'inspect';readonly reason:UpdateBlockReason|null};

export function catalogUpdateAction(entry:CatalogEntry,jobs:readonly CatalogUpdateJob[]):UpdateAction {
  if(jobs.some(job=>job.stage==='uncertain'))return {kind:'inspect',reason:null};
  if(jobs.some(job=>job.stage==='updating'))return {kind:'progress',reason:null};
  if(entry.updateSupport?.kind==='unsupported'||entry.lastCheck?.status==='unsupported')return {kind:'update',reason:'unsupported'};
  if(!entry.installed)return {kind:'update',reason:'no_selected_installation'};
  if(entry.inventoryStatus==='checking')return {kind:'update',reason:'inventory_checking'};
  if(entry.inventoryStatus==='failed')return {kind:'update',reason:'inventory_failed'};
  if(jobs.some(job=>job.stage==='ready'))return {kind:'review',reason:null};
  switch(entry.lastCheck?.status){
    case 'available':return {kind:'update',reason:null};
    case 'checking':return {kind:'update',reason:'checking'};
    case 'current':return {kind:'update',reason:'current'};
    case 'ahead':return {kind:'update',reason:'ahead'};
    case 'unknown':return {kind:'update',reason:'not_comparable'};
    case 'failed':return {kind:'update',reason:'check_failed'};
    default:return {kind:'update',reason:'not_checked'};
  }
}

export function updateActionLabel(kind:UpdateAction['kind'],t:Translate):string {
  return kind==='review'?t('업데이트 검토','Review update'):kind==='progress'?t('진행 상태 보기','View progress')
    :kind==='inspect'?t('과거 작업 보기','View past operation'):t('업데이트','Update');
}
export function updateReasonText(reason:UpdateBlockReason,t:Translate):string {
  switch(reason){
    case 'not_checked':return t('최신 버전을 아직 확인하지 않았습니다. 먼저 최신 확인을 실행하세요.','The latest version has not been checked. Run Check latest first.');
    case 'checking':return t('최신 버전을 조회하는 중입니다.','Checking the latest version.');
    case 'current':return t('설치 버전이 조회한 최신 버전과 같습니다.','The installed version matches the checked latest version.');
    case 'ahead':return t('설치 버전이 조회한 최신 버전보다 높아 업데이트하지 않습니다.','The installed version is newer than the checked latest version, so it will not be changed.');
    case 'not_comparable':return t('두 버전을 비교할 수 없어 업데이트하지 않습니다. 최신 확인을 다시 실행하세요.','The versions cannot be compared, so nothing will be updated. Check latest again.');
    case 'check_failed':return t('최신 조회에 실패했습니다. 최신 버전이라는 뜻이 아닙니다. 최신 확인을 다시 실행하세요.','The latest check failed; this does not mean it is up to date. Check latest again.');
    case 'unsupported':return t('이 설치 방식은 앱 내 업데이트를 지원하지 않습니다. 상세에서 이유와 공식 안내를 확인하세요.','In-app updates are not supported for this installation method. See Details for the reason and official guide.');
    case 'inventory_checking':return t('설치 위치를 확인하는 중입니다.','Checking installation locations.');
    case 'inventory_failed':return t('설치 위치 확인에 실패했습니다. 목록을 새로고침하세요.','Installation discovery failed. Refresh the list.');
    case 'no_selected_installation':return t('업데이트할 설치가 정해지지 않았습니다. 상세에서 설치 위치를 확인하세요.','No installation is selected for updates. Check installation locations in Details.');
    case 'owner_unverified':return t('설치 출처를 확인하지 못해 업데이트할 수 없습니다.','The installation source could not be verified, so it cannot be updated.');
    case 'service_unavailable':return t('서비스 연결이나 진행 중인 요청이 끝난 뒤 사용할 수 있습니다.','Available once the service is connected and pending requests finish.');
  }
}

export function UpdateControl({action,blocked,target,onActivate}:{readonly action:UpdateAction;readonly blocked:boolean;readonly target:string|null;readonly onActivate:()=>void}) {
  const {t}=useLanguage();
  const id=useId();
  const targetId=id+'-target';
  const navigational=action.kind==='progress'||action.kind==='inspect';
  const reason=action.reason??(blocked&&!navigational?'service_unavailable':null);
  return <div className="update-control">
    <Button data-action="update" data-update-kind={action.kind} data-reason={reason??undefined} tone="primary"
      aria-disabled={reason?true:undefined} aria-describedby={[target?targetId:'',reason?id:''].filter(Boolean).join(' ')||undefined}
      onClick={()=>{if(!reason)onActivate();}}>{updateActionLabel(action.kind,t)}</Button>
    <p className="update-target" id={targetId} data-update-target={target??''}><span className="muted">{t('대상','Target')}: </span><span className="path">{target??t('선택된 설치 없음','No selected installation')}</span></p>
    {reason&&<p className="update-reason" id={id}>{updateReasonText(reason,t)}</p>}
  </div>;
}

export function VersionEvidence({installed,latest,checkedAt}:{readonly installed:ReactNode;readonly latest:ReactNode;readonly checkedAt:string}) {
  const {t}=useLanguage();
  return <dl className="version-evidence">
    <div><dt>{t('설치 버전','Installed')}</dt><dd className="version-value" data-evidence="installed">{installed}</dd></div>
    <div><dt>{t('조회한 최신 버전','Checked latest')}</dt><dd className="version-value" data-evidence="latest">{latest}</dd><dd className="muted">{t('조회','Checked')}: {checkedAt}</dd></div>
  </dl>;
}

export function sourceLabel(manager:CatalogInstallation['manager'],t:Translate):string {
  return manager==='bun'?t('Bun 전역 설치','Bun global'):manager==='npm'?t('npm 전역 설치','npm global'):manager==='brew'?'Homebrew'
    :manager==='owned'?t('앱 전용 설치','App-owned'):t('출처 미확인','Unknown source');
}

export function CatalogDashboardRow({entry,snapshot,guardSnapshot=snapshot,act,disabled,sessions,history,automation,routes}:Props) {
  const {language,t}=useLanguage();
  const id=useId();
  const [tab,setTab]=useState<Tab|null>(null);
  const [pending,setPending]=useState(false);
  const [waiting,setWaiting]=useState<{readonly ids:readonly string[];readonly server:string|undefined;readonly binding:string}|null>(null);
  const [review,setReview]=useState<{readonly job:CatalogUpdateJob;readonly server:string|undefined;readonly binding:string;readonly checkedAt:number|null}|null>(null);
  // Updates apply to open sessions by default; the review keeps the choice visible.
  const [paneSessions,setPaneSessions]=useState<PaneSessionPolicy>('restart-all');
  const busy=useRef(false);
  const jobs=(snapshot.catalogUpdates??[]).filter(job=>job.catalogId===entry.id);
  const activeJob=jobs.find(job=>job.stage==='updating'||job.stage==='uncertain');
  const ready=[...jobs].reverse().find(job=>job.stage==='ready');
  const current=review&&jobs.find(job=>job.id===review.job.id);
  const binding=catalogReviewBinding(entry);
  const stale=!!review&&(!current||current.stage!=='ready'||JSON.stringify(current)!==JSON.stringify(review.job)
    ||review.server!==snapshot.serverInstance||review.binding!==binding
    ||!catalogUpdateTargetMatches(entry,review.job)||entry.installed?.version!==review.job.beforeVersion||!!activeJob);
  const globalBusy=workspaceBusy(guardSnapshot);
  const blocked=disabled||globalBusy||snapshot.service!=='ready'||pending||!!waiting||!!activeJob||!entry.installed||entry.inventoryStatus==='checking'||entry.inventoryStatus==='failed';
  const check=entry.lastCheck;
  const unsupported=entry.updateSupport?.kind==='unsupported'||check?.status==='unsupported';
  const status=check?.status??'unchecked';
  const action=catalogUpdateAction(entry,jobs);
  const labels={unchecked:t('최신 확인 전','Not checked'),checking:t('최신 조회 중','Checking latest'),available:t('새 버전 있음','New version available'),current:t('최신 버전','Up to date'),ahead:t('설치 버전이 더 높음','Installed version is newer'),unknown:t('버전 비교 불가','Versions not comparable'),unsupported:t('앱 내 조회 미지원','In-app check unavailable'),failed:t('최신 조회 실패','Latest check failed')};
  const policy=snapshot.policies.find(row=>row.mode!=='off');
  const running=snapshot.observedAt==null||snapshot.observationFailure?null:snapshot.external.filter(row=>row.herdrPane&&row.processState!=='exited').length;
  const managed=snapshot.managed.filter(row=>['starting','ready','working','waiting','stopping','restarting'].includes(row.state)).length;
  const tabs:readonly Tab[]=['overview','sessions','history','automation','installations'];
  const titles={overview:t('개요','Overview'),sessions:t('세션','Sessions'),history:t('기록','History'),automation:t('자동화','Automation'),installations:t('설치 정리','Organize installations')};
  const stamp=(at:number|null|undefined)=>at==null?t('아직 없음','Not yet'):new Date(at).toLocaleString(localeFor(language));
  const selected=entry.installations?.find(row=>row.id===entry.selectedInstallationId)??null;
  const latest=check&&['available','current','ahead','unknown'].includes(check.status)&&check.latestVersion?check.latestVersion:'—';
  const outcome=activeJob??[...jobs].sort((a,b)=>b.updatedAt-a.updatedAt)[0];
  const bulk=snapshot.catalogBulk?.items.find(item=>item.catalogId===entry.id);
  const bulkActive=!!snapshot.catalogBulk&&['checking','planning','updating'].includes(snapshot.catalogBulk.stage);
  const inlineStage=activeJob?.stage??(bulkActive?bulk?.status:undefined)??(check?.status==='checking'?'checking':undefined)??outcome?.stage??bulk?.status;
  useEffect(()=>{
    if(!waiting)return;
    if(waiting.server!==snapshot.serverInstance||waiting.binding!==binding){setWaiting(null);return;}
    const planned=jobs.find(job=>!waiting.ids.includes(job.id));
    if(planned?.stage==='ready'){setReview({job:planned,server:waiting.server,binding:waiting.binding,checkedAt:entry.lastCheck?.checkedAt??null});setWaiting(null);}
    else if(planned)setWaiting(null);
  },[jobs,waiting,snapshot.serverInstance,binding,entry.lastCheck?.checkedAt]);
  const plan=async()=>{
    if(blocked||busy.current)return;
    if(ready){setReview({job:ready,server:snapshot.serverInstance,binding,checkedAt:entry.lastCheck&&entry.lastCheck.latestVersion===ready.checkedVersion?entry.lastCheck.checkedAt:null});return;}
    busy.current=true;setPending(true);setWaiting({ids:jobs.map(job=>job.id),server:snapshot.serverInstance,binding});
    try{if(!await act({kind:'catalog-update-plan',catalogId:entry.id}))setWaiting(null);}
    finally{busy.current=false;setPending(false);}
  };
  const confirm=async()=>{
    if(!review||stale||blocked||busy.current)return;
    busy.current=true;setPending(true);
    try{if(await act({kind:'catalog-update-confirm',jobId:review.job.id,revision:review.job.revision,paneSessions}))setReview(null);}
    finally{busy.current=false;setPending(false);}
  };
  return <section className="cli-entry" data-catalog-id={entry.id}>
    <div className="cli-row">
      <div className="cli-identity"><h2 className="cli-heading"><AgentMark agent={entry.id} size={24}/>{entry.name}<Badge tone={status==='current'?'success':'neutral'}>{unsupported&&status==='unchecked'?labels.unsupported:labels[status]}</Badge></h2>
        <p className="muted" data-route="catalog">{t('업데이트 대상','Update target')}: {selected?sourceLabel(selected.manager,t):entry.installed?t('발견된 기본 설치','Discovered installation'):t('선택 안 됨','Not selected')}</p>
        {(entry.installations?.length??0)>1&&<div className="cluster"><strong data-installation-count={entry.installations?.length}>{entry.installations?.length} {t('개 설치 위치','installation paths')}</strong><Button data-action="organize-installations" onClick={()=>setTab('installations')}>{t('설치 정리','Organize installations')}</Button></div>}
        <VersionEvidence installed={entry.installed?.version??versionStatusLabel(entry.installed?.versionStatus,t)} latest={latest} checkedAt={stamp(check?.checkedAt)}/>
      </div>
      <div className="cli-actions">
        <UpdateControl action={action} blocked={blocked} target={selected?.path??entry.installed?.path??null} onActivate={()=>{if(action.kind==='progress'||action.kind==='inspect')setTab('history');else void plan();}}/>
        <Button data-action="catalog-check" disabled={blocked||entry.updateSupport?.kind==='unsupported'||status==='checking'} onClick={()=>void act({kind:'catalog-check',catalogId:entry.id})}>{t('최신 확인','Check latest')}</Button>
        <Button aria-expanded={tab!==null} aria-controls={id} onClick={()=>setTab(tab?null:'overview')}>{tab?t('상세 닫기','Close details'):t('상세 보기','Details')}</Button>
      </div>
      <dl className="cli-status">
        <div><dt>{t('실행 세션','Active sessions')}</dt><dd><Button className="status-link" onClick={()=>setTab('sessions')}>{t('herdr 창','herdr panes')} {running??'—'}{managed>0&&` · ${t('관리','Managed')} ${managed}`} →</Button></dd></div>
        <div><dt>{t('자동 업데이트','Automatic updates')}</dt><dd><CatalogPolicy compact entry={entry} policies={snapshot.policies} act={act} disabled={disabled||globalBusy||snapshot.service!=='ready'} blocked={blocked}/></dd>{policy&&<dd>{t('다음 확인','Next check')}: {stamp(policy.nextCheckAt)}</dd>}</div>
      </dl>
      <div className="cli-inline-status" aria-live="polite" data-card-stage={inlineStage??status} data-card-job={outcome?.id}>
        {inlineStage&&<p><strong>{inlineStage==='checking'?t('최신 버전 확인 중','Checking latest version'):inlineStage==='updating'?t('설치 업데이트 및 검증 중','Updating and verifying installation'):inlineStage==='ready'?t('업데이트 승인 대기','Awaiting update confirmation'):inlineStage==='completed'?t('검증된 설치 업데이트','Verified installation update'):inlineStage==='uncertain'?t('과거 업데이트 성공 미확인','Past update success unverified'):inlineStage==='failed'?t('이전 업데이트 실패','Previous update failed'):inlineStage==='archived-unverified'?t('성공 미확인으로 보관됨','Archived with success unverified'):labels[status]}</strong></p>}
        {outcome&&!bulkActive&&<p className="muted">{stamp(outcome.updatedAt)} · {t('당시 버전','Previous version')} {outcome.beforeVersion??'—'} · {t('현재 설치','Current installation')} <span data-current-installation-version="">{entry.installed?.version??'—'}</span>{outcome.stage==='completed'&&<> · {t('검증된 결과','Verified result')} <span data-verified-version="">{outcome.installedVersion??'—'}</span></>}</p>}
        {(outcome?.failure||check?.failure||bulk?.reason)&&<UpdateExplanation code={outcome?.failure??check?.failure??bulk?.reason??'bulk_check_failed'}/>}
        {outcome?.stage==='uncertain'&&tab!=='history'&&<><p className="muted">{t('현재 설치를 확인한 뒤 성공 미확인으로 보관하면 잠금을 해제하고 새 업데이트를 검토할 수 있습니다. 과거 성공을 증명하거나 설치를 다시 실행하지 않습니다.','Check the current installation, then archive the unverified outcome to release the lock and review a fresh update. This does not prove past success or replay an installer.')}</p><CatalogUpdateHistory snapshot={snapshot} guardSnapshot={guardSnapshot} jobIds={[outcome.id]} act={act} disabled={disabled} actionsOnly/></>}
      </div>
    </div>
    {waiting&&<Notice>{t('설치 출처와 업데이트 대상을 확인 중입니다.','Checking installation source and update target.')}<Button onClick={()=>setWaiting(null)}>{t('닫기','Close')}</Button></Notice>}
    {routes&&<div className="cli-routes"><p className="eyebrow">{t('같은 CLI의 다른 업데이트 경로','Other update routes for this CLI')}</p>{routes}</div>}
    {tab&&<div className="cli-detail" id={id}>
      <div className="detail-tabs" role="tablist" aria-label={entry.name+' '+t('상세','details')}>{tabs.map((key,index)=><button key={key} type="button" role="tab" id={id+'-'+key} aria-selected={tab===key} aria-controls={id+'-panel'} tabIndex={tab===key?0:-1} onClick={()=>setTab(key)} onKeyDown={event=>{
        const next=event.key==='ArrowRight'?(index+1)%tabs.length:event.key==='ArrowLeft'?(index+tabs.length-1)%tabs.length:event.key==='Home'?0:event.key==='End'?tabs.length-1:null;
        if(next===null)return;const selected=tabs[next];if(!selected)return;
        event.preventDefault();setTab(selected);const element=event.currentTarget.parentElement?.children[next];if(element instanceof HTMLElement)element.focus();
      }}>{titles[key]}</button>)}</div>
      <div className="detail-content" role="tabpanel" id={id+'-panel'} aria-labelledby={id+'-'+tab}>
        {tab==='overview'?<>
          <p className="muted">{t('세션 수는 같은 CLI의 herdr 창 관찰값이며, 선택한 설치의 사용 여부나 삭제 가능 여부를 보장하지 않습니다.','Session counts describe this CLI in herdr, not ownership or removal eligibility for the selected installation.')}</p>
          {(check?.failure||unsupported)&&<Notice><UpdateExplanation code={check?.failure??entry.updateSupport?.reason??'manual_update_required'}/></Notice>}
          <p className="muted">{t('최신 확인은 설치와 자동 업데이트 설정을 변경하지 않습니다.','Checking latest does not change installations or automation.')}</p>
          {!!entry.installations?.length?<CatalogInstallations entry={entry} snapshot={guardSnapshot} act={act} disabled={disabled||globalBusy}/>:<p className="path">{entry.installed?.path}</p>}
          <a className="catalog-link" href={entry.sourceUrl} target="_blank" rel="noopener noreferrer">{t('공식 안내','Official guide')}</a>
        </>:tab==='installations'?<CatalogCleanup entry={entry} snapshot={guardSnapshot} act={act} disabled={disabled||globalBusy||installationControlsBlocked(entry,guardSnapshot,{automation:false})}/>:tab==='sessions'?sessions:tab==='history'?history:automation}
      </div>
    </div>}
    {review&&<Dialog title={entry.name+' · '+t('업데이트 검토','Review update')} onClose={()=>setReview(null)}>
      <Notice>{t('선택한 설치만 업데이트합니다. 실행 시 배포처의 최신 버전을 받아 설치한 뒤 버전을 검증하고, 아래 선택에 따라 herdr 창 세션을 같은 대화로 다시 시작합니다.','Updates only this installation. The latest release is fetched at execution and its installed version is verified; herdr-pane sessions then restart into the same conversation per the choice below.')}</Notice>
      <CatalogUpdateReviewFacts job={review.job} checkedAt={review.checkedAt}/>
      <PaneSessionChoice name="catalog-update-pane-sessions" value={paneSessions} disabled={blocked||stale} onChange={setPaneSessions} compact/>
      {stale&&<Notice tone="warning">{t('설치 또는 계획이 바뀌었습니다. 닫고 다시 검토하세요.','The installation or plan changed. Close and review again.')}</Notice>}
      <div className="cluster"><Button onClick={()=>setReview(null)}>{t('취소','Cancel')}</Button><Button data-action="catalog-update-confirm" tone="primary" disabled={blocked||stale} onClick={()=>void confirm()}>{t('설치 업데이트 실행','Update installation')}</Button></div>
    </Dialog>}
  </section>;
}
