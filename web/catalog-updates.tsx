import { useRef, useState } from 'react';
import type { AppCommand, AppSnapshot, UpdatePolicy } from '../src/app/types';
import type { Installation } from '../src/protocol';
import type { CatalogEntry, CatalogId } from '../src/app/catalog-types';
import { AgentMark } from './agent-mark';
import { Badge, Button, Facts, Notice, Panel, SectionHead } from './primitives';
import { localeFor, useLanguage } from './i18n';
import { installationError, versionStatusLabel } from './install-status';
import { PaneSessionChoice } from './pane-session-choice';
import './catalog.css';
type Act=(command:AppCommand)=>Promise<boolean>;
type Props={readonly snapshot:AppSnapshot;readonly act:Act;readonly disabled:boolean;readonly onOpenCatalog?:((id:CatalogId)=>void)|undefined};
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


function CatalogPolicy({entry,policies,act,disabled,blocked}:{readonly entry:CatalogEntry;readonly policies:readonly UpdatePolicy[];readonly act:Act;readonly disabled:boolean;readonly blocked:boolean}) {
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
    <div className="page-head"><h3>{t('자동 업데이트','Automatic updates')}</h3><button type="button" role="switch" aria-checked={enabled} aria-label={entry.name+' '+t('자동 업데이트','Automatic updates')} className="automation-switch" disabled={disabled||pending||(!enabled&&(blocked||entry.updateSupport?.kind==='unsupported'))} onClick={()=>void toggle()}><span aria-hidden="true" className="switch-track"/>{pending?t('저장 중','Saving'):enabled?t('켜짐','On'):t('꺼짐','Off')}</button></div>
    <p className="muted">{!enabled&&entry.updateSupport?.kind==='unsupported'?t('이 설치에서는 자동 업데이트를 켤 수 없습니다. 위의 다음 단계를 확인하세요.','Automatic updates cannot be enabled for this installation. See the next step above.'):t('설치를 먼저 업데이트합니다. 기존 세션은 종료하지 않으며, 새 버전으로 시작하려면 해당 세션을 재시작하세요.','Updates the installation first without stopping existing sessions. Restart a session to launch the new version.')}</p>
    {entry.updateSupport?.kind!=='unsupported'&&(()=>{const current=policies.find(policy=>policy.installationId==='catalog:'+entry.id);const value=current?.paneSessions??'restart-idle';
      return <PaneSessionChoice name={'pane-sessions-'+entry.id} value={value} disabled={disabled||pending} onChange={next=>void act({kind:'policy',installationId:'catalog:'+entry.id,mode:current?.mode??'off',intervalMinutes:current?.intervalMinutes??60,firstCheck:current?.firstCheck??'now',paneSessions:next})}/>;})()}
    {active.filter(policy=>policy.waitingReason).map(policy=><Notice key={policy.installationId} tone="warning"><UpdateExplanation code={policy.waitingReason??'unavailable'}/></Notice>)}
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
    <CatalogUpdateHistory snapshot={snapshot}/>
  </div>;
}

export function catalogHistory(snapshot:AppSnapshot){
  return (snapshot.catalogUpdates??[]).filter(job=>job.stage!=='completed'||job.beforeVersion!==job.installedVersion);
}
export function CatalogUpdateHistory({snapshot}:{readonly snapshot:AppSnapshot}){
  const {language,t}=useLanguage();
  const history=catalogHistory(snapshot);
  return <>{!!history.length&&<section className="stack"><SectionHead title={t('업데이트 내역','Update history')} count={history.length}/>{history.map(job=><Panel key={job.id}>
      <div className="page-head"><h3 className="cli-heading"><AgentMark agent={job.catalogId} size={24}/>{snapshot.catalog?.find(entry=>entry.id===job.catalogId)?.name??job.catalogId}</h3><Badge tone={job.stage==='completed'?'success':job.stage==='updating'||job.stage==='ready'?'neutral':'warning'}>{job.stage==='ready'?t('업데이트 승인 대기','Awaiting update confirmation'):job.stage==='completed'?t('설치 업데이트 완료','Installation updated'):job.stage==='updating'?t('설치 업데이트 중','Updating installation'):job.stage==='failed'?t('설치 업데이트 실패','Installation update failed'):t('결과 확인 필요','Check result')}</Badge></div>
      {job.stage==='ready'&&<p className="muted">{t('아직 설치를 변경하지 않았습니다. 대시보드에서 이 CLI의 업데이트 검토를 열어 승인하세요.','The installation has not changed. Open Review update for this CLI in the dashboard to confirm.')}</p>}
      {job.stage==='completed'&&<p className="muted">{t('설치 버전을 확인했습니다. 대화 재개 완료를 의미하지는 않습니다.','The installed version was verified. Conversation resumption is not verified by this result.')}</p>}
      <p>{job.beforeVersion??'—'} → {job.installedVersion??'—'}{job.requestId.startsWith('external:')&&<> · {t('이 앱 밖에서 설치됨 · 세션 정책만 적용','Installed outside this app · session policy applied')}</>}</p><p className="muted">{new Date(job.updatedAt).toLocaleString(localeFor(language))}</p>
      <details><summary>{t('업데이트한 설치','Updated installation')}</summary><p>{job.target.kind}</p><p className="path">{job.target.executable}</p></details>
      {job.failure&&<Notice tone="warning"><UpdateExplanation code={job.failure}/></Notice>}
    </Panel>)}</section>}</>;
}
