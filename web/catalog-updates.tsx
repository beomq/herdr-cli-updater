import { useRef, useState } from 'react';
import type { AppCommand, AppSnapshot, UpdatePolicy } from '../src/app/types';
import type { Installation } from '../src/protocol';
import type { CatalogEntry, CatalogId } from '../src/app/catalog-types';
import type { CatalogUpdateJob } from '../src/app/catalog-updates';
import { AgentMark } from './agent-mark';
import { Badge, Button, Dialog, Facts, Notice, Panel, SectionHead } from './primitives';
import { localeFor, useLanguage } from './i18n';
import { installationError, versionStatusLabel } from './install-status';
import './catalog.css';
type Act=(command:AppCommand)=>Promise<boolean>;
type Props={readonly snapshot:AppSnapshot;readonly act:Act;readonly disabled:boolean;readonly onOpenCatalog?:((id:CatalogId)=>void)|undefined};
export function catalogReviewBinding(entry:CatalogEntry|undefined):string {
  // Probe times are observation metadata, not changes to the reviewed target.
  return JSON.stringify([entry?.selectedInstallationId??null,entry?.installed,entry?.inventoryStatus,entry?.sourceUrl,
    entry?.installations?.find(row=>row.id===entry.selectedInstallationId)],(key,value:unknown)=>key==='checkedAt'?undefined:value);
}
export function catalogUpdateTargetMatches(entry:CatalogEntry|undefined,job:CatalogUpdateJob):boolean {
  return !!entry?.installed&&(entry.selectedInstallationId??null)===(job.installationId??null)
    &&[entry.installed.path,entry.installed.identityPath].includes(job.target.executable)
    &&entry.inventoryStatus!=='checking'&&entry.inventoryStatus!=='failed';
}
export function catalogRecoveryBlock(snapshot:AppSnapshot,job:CatalogUpdateJob,action:'reconcile'|'archive-unverified'):string|null {
  if(snapshot.service!=='ready')return 'service_unavailable';
  if(job.stage!=='uncertain')return 'stale_update_plan';
  const entry=snapshot.catalog?.find(entry=>entry.id===job.catalogId);
  // Legacy jobs predate installation IDs; the server revalidates the recorded
  // executable, prefix, package and manager before observing or archiving.
  if(!catalogUpdateTargetMatches(job.installationId==null&&entry?{...entry,selectedInstallationId:null}:entry,job))return 'recovery_target_changed';
  if(snapshot.catalogUpdates?.some(row=>row.stage==='updating')
    ||snapshot.installJobs?.some(row=>['installing','verifying','uncertain'].includes(row.stage))
    ||snapshot.removalJobs?.some(row=>row.stage==='removing'||row.catalogId===job.catalogId&&row.stage==='uncertain'))return 'update_in_progress';
  if(action==='archive-unverified'&&(!job.reconciliation?.identity||!job.reconciliation.fingerprint))return 'reconcile_before_archive';
  return null;
}

export function CatalogUpdateReviewFacts(props:{readonly job:CatalogUpdateJob}&({readonly checkedAt:number|null;readonly action?:'install'}|{readonly currentVersion:string|null;readonly action:'reconcile'|'archive-unverified'})) {
  const {language,t}=useLanguage();
  const {job,action='install'}=props;
  const recovery='currentVersion' in props;
  const source='packageName' in job.target?job.target.packageName:job.target.kind==='official'?job.target.sourceUrl:job.target.target;
  return <div className="removal-facts" data-update-review-job={job.id} data-review-action={action}>
    <Facts items={[[t('대상 실행 파일','Target executable'),<span className="path" data-review="target">{job.target.executable}</span>],
      [t('설치 방식','Installation method'),job.target.kind],[t('출처','Source'),<span className="path" data-review="source">{source}</span>],
      [recovery?t('업데이트 전 버전','Before update'):t('설치된 버전','Installed version'),<span data-review={recovery?'before':'installed'}>{job.beforeVersion??t('미확인','Unknown')}</span>],
      ...(recovery?[[t('현재 선택한 설치 버전','Current selected installation version'),<span data-review="current">{props.currentVersion??t('미확인','Unknown')}</span>] as const]:[]),
      [t('조회한 최신 버전','Checked latest'),<span data-review="checked-latest">{job.checkedVersion??t('미확인','Unknown')}</span>],
      ...(!recovery?[[t('조회 시각','Checked at'),<span data-review="checked-at">{props.checkedAt===null?t('기록 없음','Not recorded'):new Date(props.checkedAt).toLocaleString(localeFor(language))}</span>] as const]:[])]}/>
    {action==='install'&&<p className="muted" data-release-policy="then-latest">{t('조회한 버전으로 고정하지 않습니다. 실행 시 공식 배포처가 제공하는 최신 버전을 설치하고 실제 설치 결과를 검증합니다.','The checked version is not pinned. Execution installs the latest release provided by the official source at that time and verifies the actual installed result.')}</p>}
  </div>;
}
export function usesCatalogUpdatePolicy(snapshot:AppSnapshot,installation:Installation):boolean {
  const grouped=snapshot.catalog?.find(entry=>entry.id===installation.family);
  if(grouped?.installations&&(grouped.installations.length>0||snapshot.policies.some(policy=>policy.installationId==='catalog:'+grouped.id&&policy.mode!=='off')))return true;
  return installation.family==='omo'&&installation.owner.kind==='unknown'
    &&!snapshot.policies.some(policy=>policy.installationId===installation.installationId&&policy.mode!=='off')
    &&(snapshot.catalog??[]).some(entry=>entry.id==='omo'&&entry.installed?.source==='bun-global'
      &&entry.installed.identityPath===installation.executableRealpath);
}

export function UpdateExplanation({ code }: { readonly code: string }) {
  const { t } = useLanguage();
  const messages: Record<string, string> = {
    reconcile_before_archive:t('먼저 현재 설치 상태 확인을 실행하세요. 대상의 출처와 실행 중인 설치 작업이 없는지 확인해야 성공 미확인으로 보관할 수 있습니다.','First check the current installation state. Archiving requires fresh target evidence and verification that no installer is active.'),
    recovery_target_changed:t('기록된 설치와 현재 선택한 대상이 다르거나 설치를 확인할 수 없습니다. 원래 대상의 설치 위치와 출처를 확인하세요.','The recorded installation differs from the selected target or cannot be verified. Inspect the original installation location and source.'),
    recovery_executor_active:t('설치 프로세스가 실행 중일 수 있어 현재 설치 상태 확인과 보관을 차단했습니다. 실행이 끝난 뒤 다시 검토하세요.','An installer may still be active, so checking the current installation state and archiving are blocked. Review again after it has finished.'),
    update_in_progress:t('다른 설치 작업이 진행 중이거나 미확정입니다. 그 작업의 상태를 확인한 뒤 다시 검토하세요.','Another installation operation is active or uncertain. Inspect that operation before reviewing again.'),
    expected_version_unverified:t('실행한 버전이 고정·기록되지 않아 과거 업데이트 성공을 증명할 수 없습니다. 현재 디스크 버전과 별개로 미확정 상태를 유지합니다.','The executed release was not pinned or recorded, so historical success cannot be proven. The outcome stays uncertain independently of the current disk version.'),
    execution_source_unverified:t('실행 당시 출처 증거가 부족합니다. 현재 버전을 확인해도 과거 실행 성공으로 바꾸지 않습니다.','Execution-source evidence is missing. Checking the current version does not turn the earlier execution into success.'),
    update_archived_unverified:t('성공을 확인하지 못한 작업으로 보관했습니다. 설치나 세션을 다시 실행하지 않았습니다.','Archived with success unverified. No installer or session was replayed.'),
    check_in_progress:t('이 CLI의 최신 조회가 이미 진행 중입니다. 완료 후 다시 확인하세요.','A latest-version check is already running for this CLI. Wait for its result.'),
    bulk_check_failed:t('최신 조회 중 오류가 발생했습니다. 다른 CLI의 결과와 구분해 다시 확인하세요.','The latest check failed. Review this CLI separately from the other results.'),
    bulk_result_missing:t('업데이트 완료 상태를 확인하지 못했습니다. 실제 버전을 확인하기 전에는 다시 실행하지 마세요.','Update completion could not be verified. Inspect the installed version before retrying.'),
    stale_bulk_plan:t('검토 이후 설치 또는 전체 계획이 바뀌었습니다. 전체 업데이트를 다시 준비하세요.','The installation or batch changed after review. Prepare the batch again.'),
    installation_selection_changed:t('조회 이후 선택 설치 또는 버전이 바뀌었습니다. 새 대상으로 다시 확인하세요.','The selected installation or version changed after checking. Check the new target again.'),
    self_update_only: t('CLI가 자체적으로 자동 업데이트하므로 이 토글로 제어하지 않습니다.', 'This CLI updates itself; this toggle does not control its updater.'),
    update_source_unverified: t('이 CLI의 자동 업데이트 연동은 아직 구현되지 않았습니다.', 'Automatic update integration for this CLI is not implemented yet.'),
    platform_installer_required: t('이 운영체제의 앱 내 업데이트는 지원하지 않습니다. 공식 안내를 이용하세요.', 'In-app updates are unsupported on this operating system. Use the official guide.'),
    platform_unsupported: t('이 운영체제의 앱 내 업데이트는 지원하지 않습니다. 공식 안내를 이용하세요.', 'In-app updates are unsupported on this operating system. Use the official guide.'),
    windows_wsl_required: t('Windows 네이티브 업데이트는 미지원입니다. WSL2에서 지원 여부를 확인하세요.', 'Native Windows updates are unsupported. Check support in WSL2.'),
    architecture_unsupported: t('이 CPU 아키텍처의 앱 내 업데이트는 지원하지 않습니다.', 'In-app updates are unsupported on this CPU architecture.'),
    service_restarted: t('업데이트 도중 서비스가 재시작됐습니다. 대상 경로의 실제 버전을 확인하세요.', 'The service restarted during the update. Inspect the actual version at the target path.'),
    target_in_use: t('설치를 사용하는 프로세스가 있어 업데이트를 건너뜁니다.', 'The installation is in use, so this update is skipped.'),
    catalog_source_changed: t('자동 업데이트에 승인된 설치 출처가 바뀌었습니다. 경로를 확인하고 다시 승인하세요.', 'The approved automatic update source changed. Inspect the path and approve it again.'),
  };
  return <>{messages[code] ?? installationError(code, t) ?? t('업데이트를 진행하거나 결과를 검증하지 못했습니다. 실제 설치 경로와 공식 실행 환경을 확인하세요.', 'The update could not proceed or its result could not be verified. Inspect the actual installation path and official runtime requirements.')}<details><summary>{t('기술 상세', 'Technical details')}</summary><code className="path">{code}</code></details></>;
}


export function CatalogPolicy({entry,policies,act,disabled,blocked,compact=false}:{readonly entry:CatalogEntry;readonly policies:readonly UpdatePolicy[];readonly act:Act;readonly disabled:boolean;readonly blocked:boolean;readonly compact?:boolean}) {
  const {t}=useLanguage();
  const [pending,setPending]=useState(false);
  const busy=useRef(false);
  const active=policies.filter(policy=>policy.mode!=='off');
  const enabled=active.length>0;
  const toggle=async()=>{
    if(disabled||busy.current||(!enabled&&(blocked||entry.updateSupport?.kind==='unsupported')))return;
    busy.current=true;setPending(true);
    try{
      if(enabled){for(const policy of active)if(!await act({kind:'automation',installationId:policy.installationId,enabled:false}))break;}
      else await act({kind:'automation',installationId:'catalog:'+entry.id,enabled:true});
    }
    finally{busy.current=false;setPending(false);}
  };
  return <section className="stack">
    <div className="page-head">{!compact&&<h3>{t('자동 업데이트','Automatic updates')}</h3>}<button type="button" role="switch" aria-checked={enabled} aria-label={entry.name+' '+t('자동 업데이트','Automatic updates')} className="automation-switch" disabled={disabled||pending||(!enabled&&(blocked||entry.updateSupport?.kind==='unsupported'))} onClick={()=>void toggle()}><span aria-hidden="true" className="switch-track"/>{pending?t('저장 중','Saving'):enabled?t('켜짐','On'):t('꺼짐','Off')}</button></div>
    {!compact&&<p className="muted">{t('세션 처리 방식은 업데이트 화면의 자동 업데이트 설정에서 관리합니다.','Manage session behavior in Automatic update settings on the Updates page.')}</p>}
    {!compact&&active.filter(policy=>policy.waitingReason).map(policy=><Notice key={policy.installationId} tone="warning"><UpdateExplanation code={policy.waitingReason??'unavailable'}/></Notice>)}
  </section>;
}
export function CatalogUpdates({snapshot,act,disabled,onOpenCatalog}:Props) {
  const {language,t}=useLanguage();
  const jobs=snapshot.catalogUpdates??[];
  const entries=(snapshot.catalog??[]).filter(entry=>(entry.installed||entry.installations?.length||snapshot.policies.some(policy=>policy.installationId==='catalog:'+entry.id&&policy.mode!=='off'))&&!(entry.id==='omo'&&snapshot.installations.some(installation=>installation.family==='omo'&&installation.executableRealpath===(entry.installed?.identityPath??entry.installed?.path)&&!usesCatalogUpdatePolicy(snapshot,installation))));
  return <div className="catalog stack">
    <SectionHead title={t('설치된 CLI','Installed CLIs')} count={entries.length}/>
    <p className="muted">{t('설치 업데이트와 세션별 새 버전 적용은 별도 단계입니다. 실행 중인 세션이 있어도 설치를 업데이트할 수 있습니다.','Installation updates and applying a new version to each session are separate steps. Installations can update while sessions are running.')}</p>
    {entries.map(entry=>{
      const blocked=!entry.installed||entry.inventoryStatus==='checking'||entry.inventoryStatus==='failed'||jobs.some(job=>job.catalogId===entry.id&&(job.stage==='updating'||job.stage==='uncertain'));
      const coreIds=snapshot.installations.filter(installation=>installation.family===entry.id).map(installation=>installation.installationId);
      const policies=snapshot.policies.filter(policy=>policy.installationId==='catalog:'+entry.id||coreIds.includes(policy.installationId));
      const activeJob=jobs.find(job=>job.catalogId===entry.id&&(job.stage==='updating'||job.stage==='uncertain'));
      const checking=entry.inventoryStatus==='checking';
      const unavailable=entry.inventoryStatus==='failed'||!entry.installed;
      const unsupported=entry.updateSupport?.kind==='unsupported';
      const waiting=policies.find(policy=>policy.mode!=='off'&&policy.waitingReason);
      const status=activeJob?.stage==='uncertain'?t('결과 확인 필요','Check result'):activeJob?t('설치 업데이트 중','Updating installation'):checking?t('설치 확인 중','Checking installation'):unavailable?t('설치 확인 필요','Check installation'):unsupported?t('직접 관리 필요','Manual management'):waiting?t('조건 충족 대기','Waiting for requirements'):entry.updateSupport?.kind==='check-source'?t('업데이트 확인 가능','Update checks supported'):t('지원 확인 필요','Support not verified');
      return <Panel key={entry.id}>
        <div className="page-head"><h3 className="cli-heading"><AgentMark agent={entry.id} size={24}/>{entry.name}{entry.installed?.source==='bun-global'&&(' · '+t('Bun 전역 설치','Bun global installation'))}</h3><Badge tone={unavailable||unsupported||activeJob?.stage==='uncertain'?'warning':'neutral'}>{status}</Badge></div>
        <Facts items={[[t('설치된 버전','Installed version'),entry.installed?.version??versionStatusLabel(entry.installed?.versionStatus,t)]]}/>
        <div className="update-next" role="status"><strong>{t('다음 단계','Next step')}</strong><div>{activeJob?.stage==='uncertain'?t('아래 업데이트 내역에서 결과를 확인하세요. 확인 전에는 업데이트를 반복하지 않습니다.','Inspect the update history below. Do not repeat the update until its result is known.'):activeJob?t('설치 결과를 확인하고 있습니다. 진행 내역은 아래에서 볼 수 있습니다.','Verifying the installation. See progress in the history below.'):checking?t('설치 경로와 버전 확인이 끝나면 가능한 작업을 표시합니다.','Available actions will appear after the installation path and version are checked.'):unavailable?t('설치 위치를 확인한 뒤 화면의 새로고침으로 다시 조회하세요.','Check the installation location, then refresh this page.'):unsupported?<UpdateExplanation code={entry.updateSupport?.reason??'manual_update_required'}/>:waiting?<UpdateExplanation code={waiting.waitingReason!}/>:t('아래에서 관리할 설치를 확인하고 자동 업데이트를 설정하세요.','Review the managed installation below, then configure automatic updates.')}</div></div>
        <section className="stack" data-update-target={entry.id}><h3>{t('업데이트 대상','Update target')}</h3><p className="path">{entry.installed?.identityPath??entry.installed?.path??t('선택되지 않음','Not selected')}</p>
          {onOpenCatalog&&<Button data-action="open-catalog-detail" data-catalog-id={entry.id} onClick={()=>onOpenCatalog(entry.id)}>{t('CLI 상세에서 대상 변경','Change target in CLI details')}</Button>}
          <p className="muted">{t('자동화는 이 설치의 실행 시점만 설정합니다. 대시보드의 전체 업데이트는 자동화 켜짐 여부와 관계없이 별도 승인으로 실행합니다.','Automation schedules this installation. Dashboard bulk updates run with separate approval, even when automation is off.')}</p>
          {policies.map(policy=><Facts key={policy.installationId} items={[[t('확인 주기','Check interval'),`${policy.intervalMinutes} ${t('분','minutes')}`],[t('마지막 확인','Last check'),policy.lastCheckedAt===null?t('아직 없음','Not yet'):new Date(policy.lastCheckedAt).toLocaleString(localeFor(language))],[t('다음 확인','Next check'),policy.mode==='off'||policy.nextCheckAt===null?t('예약 없음','Not scheduled'):new Date(policy.nextCheckAt).toLocaleString(localeFor(language))]]}/>)}
        </section>
        <CatalogPolicy entry={entry} policies={policies} act={act} disabled={disabled} blocked={blocked}/>
      </Panel>;
    })}
    <CatalogUpdateHistory snapshot={snapshot} act={act} disabled={disabled}/>
  </div>;
}

export function catalogHistory(snapshot:AppSnapshot){
  return (snapshot.catalogUpdates??[]).filter(job=>job.stage!=='completed'||job.beforeVersion!==job.installedVersion);
}
export function CatalogUpdateHistory({snapshot,guardSnapshot=snapshot,act,disabled=false,jobIds,actionsOnly=false}:{readonly snapshot:AppSnapshot;readonly guardSnapshot?:AppSnapshot;readonly act?:Act|undefined;readonly disabled?:boolean;readonly jobIds?:readonly string[];readonly actionsOnly?:boolean}){
  const {language,t}=useLanguage();
  const [review,setReview]=useState<{readonly job:CatalogUpdateJob;readonly action:'reconcile'|'archive-unverified';readonly server:string|undefined;readonly binding:string}|null>(null);
  const [pending,setPending]=useState(false);
  const busy=useRef(false);
  const history=catalogHistory(snapshot).filter(job=>!jobIds||jobIds.includes(job.id));
  const current=review&&guardSnapshot.catalogUpdates?.find(job=>job.id===review.job.id);
  const stale=!!review&&(!current||JSON.stringify(current)!==JSON.stringify(review.job)||guardSnapshot.serverInstance!==review.server
    ||catalogReviewBinding(guardSnapshot.catalog?.find(entry=>entry.id===review.job.catalogId))!==review.binding);
  const reason=review?catalogRecoveryBlock(guardSnapshot,review.job,review.action):null;
  const recover=async()=>{
    if(!act||!review||stale||reason||disabled||busy.current)return;
    busy.current=true;setPending(true);
    try{if(await act({kind:'catalog-update-recover',jobId:review.job.id,revision:review.job.revision,action:review.action}))setReview(null);}
    finally{busy.current=false;setPending(false);}
  };
  const open=(job:CatalogUpdateJob,action:'reconcile'|'archive-unverified')=>{
    if(disabled||busy.current||catalogRecoveryBlock(guardSnapshot,job,action))return;
    setReview({job,action,server:guardSnapshot.serverInstance,binding:catalogReviewBinding(guardSnapshot.catalog?.find(entry=>entry.id===job.catalogId))});
  };
  return <>{actionsOnly?history.filter(job=>job.stage==='uncertain').flatMap(job=>(['reconcile','archive-unverified'] as const).map(action=>{const block=catalogRecoveryBlock(guardSnapshot,job,action);return <Button key={job.id+action} data-action={'catalog-update-'+action} data-job-id={job.id} data-reason={block??undefined} aria-haspopup="dialog" disabled={disabled||pending||!!block} onClick={()=>open(job,action)}>{action==='reconcile'?t('현재 설치 상태 확인','Check current installation state'):t('성공 미확인으로 보관 검토','Review archiving as unverified')}</Button>;})):!!history.length&&<section className="stack"><SectionHead title={t('업데이트 내역','Update history')} count={history.length}/>{history.map(job=><Panel key={job.id}>
      <div className="stack" data-update-job={job.id} data-update-stage={job.stage} aria-live="polite"><div className="page-head"><h3 className="cli-heading"><AgentMark agent={job.catalogId} size={24}/>{snapshot.catalog?.find(entry=>entry.id===job.catalogId)?.name??job.catalogId}</h3><Badge tone={job.stage==='completed'?'success':job.stage==='updating'||job.stage==='ready'?'neutral':'warning'}>{job.stage==='ready'?t('업데이트 승인 대기','Awaiting update confirmation'):job.stage==='completed'?t('설치 업데이트 완료','Installation updated'):job.stage==='updating'?t('설치 업데이트 중','Updating installation'):job.stage==='failed'?t('설치 업데이트 실패','Installation update failed'):job.stage==='archived-unverified'?t('성공 미확인으로 보관','Archived · outcome unverified'):t('결과 확인 필요','Check result')}</Badge></div>
      {job.stage==='ready'&&<p className="muted">{t('아직 설치를 변경하지 않았습니다. 대시보드에서 이 CLI의 업데이트 검토를 열어 승인하세요.','The installation has not changed. Open Review update for this CLI in the dashboard to confirm.')}</p>}
      {job.stage==='completed'&&<p className="muted">{t('설치 버전을 확인했습니다. 대화 재개 완료를 의미하지는 않습니다.','The installed version was verified. Conversation resumption is not verified by this result.')}</p>}
      {job.stage==='updating'&&<Notice>{t('설치를 변경하거나 결과를 검증 중입니다. 세션은 유지되며, 이 작업을 다시 실행하지 않습니다.','The installation is being changed or verified. Sessions are kept; this work is not replayed.')}</Notice>}
      {(job.stage==='uncertain'||job.stage==='archived-unverified')&&<Notice tone="warning">{t('업데이트 성공 여부는 확인되지 않았습니다. 현재 설치 상태 확인은 재설치 없이 출처와 디스크 버전을 확인하는 작업이며, 과거 업데이트의 성공을 증명하지 않습니다. 성공 미확인으로 보관해도 성공으로 바꾸지 않습니다.','Update success is unverified. Checking the current installation state inspects the source and disk version without reinstalling; it does not prove the earlier update succeeded. Archiving as unverified does not mark success.')}</Notice>}
      <p>{job.beforeVersion??'—'} → {job.installedVersion??'—'}{job.requestId.startsWith('external:')&&<> · {t('이 앱 밖에서 설치됨 · 세션 정책만 적용','Installed outside this app · session policy applied')}</>}</p><p className="muted">{new Date(job.updatedAt).toLocaleString(localeFor(language))}</p>
      <details><summary>{t('업데이트한 설치','Updated installation')}</summary><p>{job.target.kind}</p><p className="path">{job.target.executable}</p></details>
      {job.failure&&<Notice tone="warning"><UpdateExplanation code={job.failure}/></Notice>}
      {job.reconciliation&&<Facts items={[[t('설치 상태 확인 당시 디스크 버전','Disk version at state check'),<span data-reconciled-version="">{job.reconciliation.version??t('미확인','Unknown')}</span>],[t('설치 상태 확인 시각','Installation state checked at'),new Date(job.reconciliation.checkedAt).toLocaleString(localeFor(language))]]}/>}
      {job.stage==='uncertain'&&act&&<div className="stack">{(['reconcile','archive-unverified'] as const).map(action=>{const block=catalogRecoveryBlock(guardSnapshot,job,action);return <div key={action}><Button data-action={'catalog-update-'+action} data-job-id={job.id} data-reason={block??undefined} aria-haspopup="dialog" disabled={disabled||pending||!!block} onClick={()=>open(job,action)}>{action==='reconcile'?t('현재 설치 상태 확인','Check current installation state'):t('성공 미확인으로 보관 검토','Review archiving as unverified')}</Button>{block&&<p className="muted"><UpdateExplanation code={block}/></p>}</div>;})}</div>}
      </div></Panel>)}</section>}
      {review&&<Dialog title={review.action==='reconcile'?t('현재 설치 상태 확인','Check current installation state'):t('성공 미확인으로 보관','Archive as unverified')} onClose={()=>setReview(null)}>
        <CatalogUpdateReviewFacts job={review.job} currentVersion={guardSnapshot.catalog?.find(entry=>entry.id===review.job.catalogId)?.installed?.version??null} action={review.action}/>
        <Notice>{review.action==='reconcile'?t('설치 명령 없이 대상의 출처와 실제 버전만 확인합니다. 실행 근거가 부족하면 미확정 상태를 유지합니다.','Checks only the target source and disk version, without an installation command. Insufficient execution evidence keeps the outcome uncertain.'):t('성공 여부를 확인하지 못했음을 인정하고 작업 잠금을 해제합니다. 설치·세션·과거 결과를 바꾸지 않습니다. 서버가 실행 중인 설치 작업이 없는지 다시 검증합니다.','Acknowledges the unverified outcome and releases this job lock. It does not change installations, sessions or the historical outcome. The server rechecks that no installer is active.')}</Notice>
        {(stale||reason)&&<Notice tone="warning" data-recovery-stale={stale}>{stale?t('대상, 서비스 또는 기록이 바뀌었습니다. 닫고 다시 검토하세요.','The target, service or record changed. Close and review again.'):<UpdateExplanation code={reason??'stale_update_plan'}/>}</Notice>}
        <Button data-action="catalog-update-recover-confirm" disabled={disabled||pending||stale||!!reason} onClick={()=>void recover()}>{pending?t('확인 중','Checking'):review.action==='reconcile'?t('현재 설치 상태 확인 실행','Check current installation state'):t('성공 미확인으로 보관','Archive unverified outcome')}</Button>
      </Dialog>}</>;
}
