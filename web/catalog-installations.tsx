import { useEffect, useRef, useState } from 'react';
import type { AppCommand, AppSnapshot } from '../src/app/types';
import type { CatalogEntry, CatalogInstallation } from '../src/app/catalog-types';
import type { CatalogDefaultJob } from '../src/app/catalog-default-jobs';
import { AgentMark } from './agent-mark';
import type { RemovalJob } from '../src/app/catalog-removal';
import { cleanupRows } from './catalog-cleanup';
import { removalExplanation } from './removal-status';
import { Badge, Button, Dialog, Facts, Notice } from './primitives';
import { useLanguage } from './i18n';
import { versionStatusLabel } from './install-status';
import { Select } from './select';

type Props={readonly entry:CatalogEntry;readonly snapshot:AppSnapshot;readonly act:(command:AppCommand)=>Promise<boolean>;readonly disabled:boolean;readonly onInstall?:()=>void};
type Waiting={readonly ids:readonly string[];readonly installation:CatalogInstallation;readonly serverInstance:string|undefined};

export function locationRemovalIsStale(entry:CatalogEntry,snapshot:AppSnapshot,installation:CatalogInstallation,review:RemovalJob,server:string|undefined):boolean {
  const row=entry.installations?.find(row=>row.id===installation.id);
  const current=snapshot.removalJobs?.find(job=>job.id===review.id);
  return snapshot.service!=='ready'||snapshot.serverInstance!==server||!row
    ||JSON.stringify(row)!==JSON.stringify(installation)||!current||current.stage!=='ready'
    ||current.revision!==review.revision||JSON.stringify(current)!==JSON.stringify(review)
    ||(review.installationId??null)!==(installation.id===entry.selectedInstallationId?null:installation.id)
    ||(review.target.executable!==installation.path&&review.target.executable!==installation.identityPath);
}

function LocationRemoval({entry,snapshot,act,disabled,installation}:{entry:CatalogEntry;snapshot:AppSnapshot;act:Props['act'];disabled:boolean;installation:CatalogInstallation}) {
  const {t}=useLanguage();
  const [waiting,setWaiting]=useState<{known:readonly string[];row:CatalogInstallation;server:string|undefined}|null>(null);
  const [review,setReview]=useState<{job:RemovalJob;row:CatalogInstallation;server:string|undefined}|null>(null);
  const [pending,setPending]=useState(false);
  const [unknown,setUnknown]=useState(false);
  const busy=useRef(false);
  const state=cleanupRows(entry,snapshot).find(row=>row.installation.id===installation.id);
  const defaultHeld=entry.configuredDefaultInstallationId===installation.id||(!entry.configuredDefaultInstallationId&&installation.isDefault);
  const sourceHeld=installation.removalSupport?.kind==='unsupported'||(installation.manager==='unknown'&&installation.removalSupport?.kind!=='review');
  const held=!!state?.sessionPids.length||defaultHeld||sourceHeld;
  const blocked=disabled||!!held||installationControlsBlocked(entry,snapshot)||unknown;
  const stale=!!review&&locationRemovalIsStale(entry,snapshot,review.row,review.job,review.server);
  useEffect(()=>{
    if(!waiting)return;
    if(snapshot.serverInstance!==waiting.server||JSON.stringify(installation)!==JSON.stringify(waiting.row)){setWaiting(null);setUnknown(true);return;}
    const job=snapshot.removalJobs?.find(job=>job.catalogId===entry.id&&(job.installationId??null)===(installation.id===entry.selectedInstallationId?null:installation.id)&&!waiting.known.includes(job.id));
    if(job){setWaiting(null);if(job.stage==='ready')setReview({job,row:waiting.row,server:waiting.server});else setUnknown(true);}
  },[snapshot.removalJobs,snapshot.serverInstance,installation,entry.selectedInstallationId,waiting]);
  const plan=async()=>{
    if(blocked||pending||waiting||busy.current)return;
    busy.current=true;setPending(true);setWaiting({known:(snapshot.removalJobs??[]).map(job=>job.id),row:installation,server:snapshot.serverInstance});
    try{if(!await act({kind:'remove-plan',catalogId:entry.id,...(installation.id===entry.selectedInstallationId?{}:{installationId:installation.id})})){setWaiting(null);setUnknown(true);}}
    catch{setWaiting(null);setUnknown(true);}finally{busy.current=false;setPending(false);}
  };
  const confirm=async()=>{
    if(!review||blocked||stale||pending||busy.current||review.job.references?.length)return;
    busy.current=true;setPending(true);
    try{if(await act({kind:'remove-confirm',jobId:review.job.id,revision:review.job.revision}))setReview(null);else setUnknown(true);}
    catch{setUnknown(true);}finally{busy.current=false;setPending(false);}
  };
  return <>
    {held&&<div data-removal-blocked="true"><Notice tone="warning">{state?.sessionPids.length?t(`실행 중인 세션이 있습니다: ${state.sessionPids.join(', ')}`,`Sessions are running: ${state.sessionPids.join(', ')}`):sourceHeld?removalExplanation(installation.removalSupport?.reason??'removal_source_unverified',t):t('터미널 기본 실행입니다. 다른 설치로 전환한 뒤 다시 시도하세요.','This is the terminal default. Switch to another installation, then try again.')}</Notice></div>}
    {installationControlsBlocked(entry,snapshot)&&<p className="muted">{t('자동 업데이트·진행 중이거나 결과 미확인인 작업·설치 목록을 먼저 확인하세요.','Removal is blocked by automation, active or uncertain work, or unverified inventory.')}</p>}
    <Button data-action="location-remove-plan" disabled={blocked||pending||!!waiting} onClick={()=>void plan()}>{t('이 위치 제거','Remove at this location')}</Button>
    {waiting&&<Button onClick={()=>setWaiting(null)}>{t('닫기','Close pending review')}</Button>}
    {unknown&&<Notice tone="warning">{t('요청 결과가 미확인입니다. 자동 재시도하지 않습니다. 최신 상태를 확인한 뒤 다시 여세요.','Request outcome is unknown. No automatic retry; inspect fresh state and reopen.')}</Notice>}
    {review&&<Dialog title={t('이 위치의 설치를 제거할까요?','Remove the installation at this location?')} onClose={()=>setReview(null)}>
      <div className="removal-facts"><Facts items={[
        [t('정확한 실행 파일','Exact executable'),<span className="path">{review.job.target.executable}</span>],
        [t('버전','Version'),review.row.version??t('미확인','Unknown')],
        [t('제거 방법','Removal method'),review.job.target.kind],
        [t('제거 대상','Removal target'),<span className="path">{review.job.target.kind==='standalone'?review.job.target.payload:review.job.target.kind==='brew'?review.job.target.payloadRoot:review.job.target.kind==='owned'?review.job.target.target:review.job.target.target+'/node_modules/'+review.job.target.packageName}</span>],
        [t('보존 경로','Preserved paths'),review.job.target.preserve.map(path=><span className="path" key={path}>{path}</span>)],
      ]}/></div>
      <Notice>{t('대화·로그인·사용자 데이터를 보존합니다.','Conversations, login and user data are preserved.')}</Notice>
      {(review.job.target.kind==='owned'||review.job.target.kind==='standalone')&&<Notice>{t('파일을 보관하고 실행 경로에서 제거합니다. 디스크 공간을 비우는 완전 삭제가 아닙니다.','Files are archived and removed from the launch path; this does not reclaim disk space.')}</Notice>}
      {!!review.job.references?.length&&<Notice tone="warning">{t('이 위치를 참조하는 설정 때문에 제거할 수 없습니다.','Configuration references block removal.')}<ul>{review.job.references.map(path=><li className="path" key={path}>{path}</li>)}</ul></Notice>}
      {stale&&<Notice tone="warning">{t('위치·버전·계획 또는 서비스가 바뀌었습니다. 닫고 다시 여세요.','Location, version, plan or service changed. Close and open it again.')}</Notice>}
      <Button data-action="location-remove-confirm" tone="danger" disabled={blocked||pending||stale||!!review.job.references?.length} onClick={()=>void confirm()}>{t('이 위치 제거 승인','Confirm removal at this location')}</Button>
    </Dialog>}
  </>;
}

export function installationControlsBlocked(entry:CatalogEntry,snapshot:AppSnapshot,options:{readonly automation?:boolean}={}):boolean {
  const core=snapshot.installations.filter(installation=>installation.family===entry.id);
  return entry.inventoryStatus!=='ready'
    ||(options.automation!==false&&snapshot.policies.some(policy=>policy.mode!=='off'&&(policy.installationId==='catalog:'+entry.id||core.some(installation=>installation.installationId===policy.installationId))))
    ||(snapshot.installJobs??[]).some(job=>job.catalogId===entry.id&&['installing','verifying','uncertain'].includes(job.stage))
    ||(snapshot.catalogUpdates??[]).some(job=>job.catalogId===entry.id&&['updating','uncertain'].includes(job.stage))
    ||(snapshot.removalJobs??[]).some(job=>job.catalogId===entry.id&&['removing','uncertain'].includes(job.stage))
    ||(snapshot.defaultJobs??[]).some(job=>job.catalogId===entry.id&&['applying','uncertain'].includes(job.stage))
    ||snapshot.operations.some(operation=>core.some(installation=>installation.installationId===operation.installationId)&&!['completed','failed','cancelled'].includes(operation.stage));
}

export function defaultReviewIsStale(entry:CatalogEntry,jobs:readonly CatalogDefaultJob[],review:CatalogDefaultJob):boolean {
  const installation=entry.installations?.find(row=>row.id===review.installationId);
  const current=jobs.find(job=>job.id===review.id);
  return !installation||review.catalogId!==entry.id
    ||review.plan.installationId!==installation.id||review.plan.catalogId!==entry.id
    ||installation.path!==review.plan.executable||installation.identityPath!==review.plan.identityPath
    ||!current||current.stage!=='ready'||current.revision!==review.revision
    ||JSON.stringify(current.plan)!==JSON.stringify(review.plan);
}

export function CatalogInstallations({entry,snapshot,act,disabled}:Props) {
  const {t}=useLanguage();
  const [pending,setPending]=useState(false);
  const busy=useRef(false);
  const [waiting,setWaiting]=useState<Waiting|null>(null);
  const [review,setReview]=useState<CatalogDefaultJob|null>(null);
  const [reviewServer,setReviewServer]=useState<string|undefined>();
  const [unknown,setUnknown]=useState(false);
  const rows=entry.installations??[];
  const selected=rows.find(row=>row.id===entry.selectedInstallationId);
  const [terminalId,setTerminalId]=useState(()=>{
    const candidate=rows.find(row=>row.id===(entry.configuredDefaultInstallationId??entry.selectedInstallationId));
    return candidate?.manager!=='owned'?candidate?.id??'':'';
  });
  const terminal=rows.find(row=>row.id===terminalId);
  const observed=rows.find(row=>row.isDefault);
  const future=rows.find(row=>row.id===entry.configuredDefaultInstallationId);
  const jobs=(snapshot.defaultJobs??[]).filter(job=>job.catalogId===entry.id);
  const configured=terminal&&entry.configuredDefaultInstallationId===terminal.id;
  const selectionBlocked=disabled||snapshot.service!=='ready'||installationControlsBlocked(entry,snapshot,{automation:false});
  const blocked=disabled||snapshot.service!=='ready'||installationControlsBlocked(entry,snapshot);
  const selectionLocked=selectionBlocked||pending||!!waiting||unknown;
  const locked=blocked||pending||!!waiting||unknown;
  const stale=!!review&&(defaultReviewIsStale(entry,jobs,review)||reviewServer!==snapshot.serverInstance||review.installationId!==terminalId||!!terminal?.isDefault||!!configured);
  useEffect(()=>{
    if(!waiting)return;
    const row=rows.find(item=>item.id===waiting.installation.id);
    if(snapshot.serverInstance!==waiting.serverInstance||terminalId!==waiting.installation.id||!row||row.path!==waiting.installation.path||row.identityPath!==waiting.installation.identityPath){setWaiting(null);setUnknown(true);return;}
    const job=jobs.find(item=>item.installationId===row.id&&!waiting.ids.includes(item.id));
    if(job){setWaiting(null);if(job.stage==='ready'){setReview(job);setReviewServer(snapshot.serverInstance);}else if(job.stage==='uncertain')setUnknown(true);}
  },[snapshot.defaultJobs,snapshot.serverInstance,terminalId,entry.installations,waiting]);
  const select=async(row:CatalogInstallation)=>{
    if(selectionLocked||busy.current||row.id===entry.selectedInstallationId)return;
    busy.current=true;setPending(true);setReview(null);
    try{if(!await act({kind:'catalog-select',catalogId:entry.id,installationId:row.id}))setUnknown(true);}
    catch{setUnknown(true);}
    finally{busy.current=false;setPending(false);}
  };
  const plan=async()=>{
    if(locked||busy.current||!terminal||terminal.isDefault||configured||terminal.manager==='owned')return;
    busy.current=true;setPending(true);
    setWaiting({ids:jobs.map(job=>job.id),installation:terminal,serverInstance:snapshot.serverInstance});
    try{if(!await act({kind:'default-plan',catalogId:entry.id,installationId:terminal.id})){setWaiting(null);setUnknown(true);}}
    catch{setWaiting(null);setUnknown(true);}
    finally{busy.current=false;setPending(false);}
  };
  const confirm=async()=>{
    if(!review||locked||stale||busy.current)return;
    busy.current=true;setPending(true);
    try{if(await act({kind:'default-confirm',jobId:review.id,revision:review.revision}))setReview(null);else setUnknown(true);}
    catch{setUnknown(true);}
    finally{busy.current=false;setPending(false);}
  };
  const managers:Record<CatalogInstallation['manager'],string>={owned:t('레거시 앱 전용','Legacy app-owned'),bun:'Bun',npm:'npm',brew:'Homebrew',unknown:t('출처 미확인','Unknown manager')};
  return <section className="stack" data-catalog-installations={entry.id}>
    <h3 className="cli-heading"><AgentMark agent={entry.id} size={24}/>{t('설치 위치와 업데이트 대상','Installation locations and update target')}</h3>
    <Facts items={[[t('업데이트 대상','Update target'),selected?`${managers[selected.manager]} · ${selected.version??'—'}`:t('선택되지 않음','Not selected')]]}/>
    <p className="muted">{t('CLI별 자동·일괄 업데이트 대상은 하나입니다. 관리 대상을 바꾸면 기존 자동화도 검증된 대상으로 이전하며 다른 설치는 수동으로 관리합니다. 선택만으로 셸 기본 실행은 바뀌지 않습니다.','Each CLI has one automatic and bulk update target. Selecting a verified target transfers existing automation; other installations remain manual. Selection does not change the shell default.')}</p>
    <p className="muted">{t('출처 미확인 행은 관찰된 실행 경로이며 별개의 설치 패키지로 확인된 수가 아닙니다.','Unknown-manager rows are observed execution paths, not a count of proven distinct installed packages.')}</p>
    {entry.inventoryStatus!=='ready'&&<Notice tone="warning">{entry.inventoryStatus==='checking'?t('설치 목록 확인 중','Checking installation inventory'):t('설치 목록이 확인되지 않았습니다.','Installation inventory is not verified.')}</Notice>}
    {selectionBlocked&&<p className="muted">{t('진행 중이거나 결과 미확인인 작업과 설치 목록을 확인한 뒤 관리 대상을 변경할 수 있습니다.','Verify inventory and inspect active or uncertain jobs before changing the management target.')}</p>}
    {blocked&&!selectionBlocked&&<p className="muted">{t('관리 대상은 선택할 수 있습니다. 기본 실행 전환은 자동 업데이트를 끈 뒤 할 수 있습니다.','Management target selection is available. Switching the default launcher needs automation turned off first.')}</p>}
    {!rows.length&&<Notice>{t('확인된 설치 인스턴스가 없습니다.','No verified installation instances.')}</Notice>}
    <div className="stack">{rows.map(row=><div className="summary-row" key={row.id} data-installation-id={row.id}>
      <div className="stack">
        <div className="cluster"><strong>{managers[row.manager]}</strong><span className="path">{row.version??versionStatusLabel(row.versionStatus,t)}</span>{row.isDefault&&<span data-path-default="true"><Badge>{t('PATH 기본 실행','PATH default')}</Badge></span>}{row.id===entry.selectedInstallationId&&<span data-management-target="true"><Badge>{t('관리 대상','Management target')}</Badge></span>}</div>
        <details><summary>{t('실행 파일 · 설치 루트','Executable · installation root')}</summary><Facts items={[[t('실행 파일','Executable'),<span className="path">{row.path}</span>],[t('설치 루트','Installation root'),<span className="path">{row.root}</span>]]}/></details>
        <div className="cluster"><Button data-action="catalog-select" aria-pressed={row.id===entry.selectedInstallationId} disabled={selectionLocked||row.id===entry.selectedInstallationId} onClick={()=>void select(row)}>{t('업데이트 대상으로 선택','Select for updates')}</Button>
        </div>
      </div>
    </div>)}</div>
    <section className="stack" data-role="terminal-default">
    <h3>{t('터미널 실행','Terminal execution')}</h3>
    <p>{t(`새 터미널에서 ${entry.executable} 명령으로 실행할 설치입니다. 업데이트 대상은 바꾸지 않습니다.`,`Choose what ${entry.executable} runs in a new terminal. This does not change the update target.`)}</p>
    <Facts items={[[t('서비스가 관찰한 PATH 기본','PATH default observed by service'),observed?<span className="path">{observed.path}</span>:t('확인되지 않음','Unknown')],[t('새 터미널에 설정한 기본','Configured for new terminals'),future?<span className="path">{future.path}</span>:t('앱에서 설정하지 않음','Not configured by this app')]]}/>
    {selected&&(future??observed)&&(future??observed)?.id!==selected.id&&<Notice tone="warning">{t('업데이트 대상과 터미널 기본 실행이 다릅니다. 앱이 업데이트한 버전과 새 터미널에서 실행하는 버전이 다를 수 있습니다.','The update target and terminal default differ. The updated version may not be the one a new terminal runs.')}</Notice>}
    <Select label={t('터미널에서 사용할 설치','Installation to run')} value={terminalId} options={[{value:'',label:t('설치를 선택하세요','Choose an installation')},...rows.filter(row=>row.manager!=='owned').map(row=>({value:row.id,label:`${managers[row.manager]} · ${row.version??'—'} · ${row.path}`}))]} disabled={locked} onChange={id=>{setTerminalId(id);setReview(null);}}/>
    {future&&<span data-future-default={future.id}><Badge>{t('새 셸 기본 실행 설정 완료','Default configured for new shells')}</Badge></span>}
    <Button data-action="default-plan" disabled={locked||!terminal||terminal.manager==='owned'||terminal.isDefault||!!configured} onClick={()=>void plan()}>{pending||waiting?t('확인 중','Checking'):t('이 설치를 터미널 기본으로 설정','Set this installation as terminal default')}</Button>
    <p className="muted">{t('승인하면 ~/.zshrc를 수정합니다. 현재 열린 대화는 유지하며 새 대화형 zsh부터 적용됩니다.','Confirmation changes ~/.zshrc for new interactive zsh shells. Existing conversations stay open.')}</p>
    </section>
    <section className="stack" data-role="installation-removal"><h3>{t('설치 삭제','Remove installations')}</h3>
    {rows.map(row=><details key={row.id} data-removal-installation={row.id}><summary>{t('이 설치 제거','Remove this installation')+' · '+managers[row.manager]+' · '+(row.version??'—')}</summary><div className="stack"><p className="path">{row.path}</p><p className="muted">{t('이 설치만 제거하며 대화·로그인·사용자 데이터는 보존합니다.','Remove only this installation; preserve conversations, login and user data.')}</p><LocationRemoval entry={entry} snapshot={snapshot} act={act} disabled={locked} installation={row}/></div></details>)}
    </section>
    {waiting&&<Button onClick={()=>setWaiting(null)}>{t('대기 취소','Stop waiting')}</Button>}
    {unknown&&<Notice tone="warning">{t('요청 결과가 확인되지 않았습니다. 자동으로 재시도하지 않습니다. 최신 작업 상태와 실제 경로를 확인하세요.','The request outcome is unknown. It will not retry automatically. Inspect the latest job state and actual paths.')}<Button disabled={disabled||pending} onClick={()=>void act({kind:'refresh'}).then(ok=>{if(ok){setUnknown(false);setWaiting(null);setReview(null);}})}>{t('최신 상태 확인','Refresh status')}</Button></Notice>}
    {jobs.filter(job=>job.stage!=='ready').map(job=><div className="stack" key={job.id} data-default-job={job.id} data-stage={job.stage}><Badge tone={job.stage==='completed'?'success':job.stage==='failed'?'error':'warning'}>{job.stage}</Badge><p className="path">{job.plan.executable}</p>{job.result&&<Facts items={[[t('검증 버전','Verified version'),job.result.version],[t('런처','Launcher'),<span className="path">{job.result.launcher}</span>],[t('프로필','Profile'),<span className="path">{job.result.profile}</span>],[t('백업','Backup'),<span className="path">{job.result.backup??t('없음','None')}</span>]]}/>}<p className="muted">{t('새 대화형 zsh에 적용됩니다. 현재 열린 셸과 세션이 바뀌었다는 뜻은 아닙니다.','Applies to new interactive zsh shells, not all existing shells or sessions.')}</p>{job.failure&&<Notice tone="warning">{job.failure+' · '+t('실제 경로를 확인하세요. 자동 재시도하지 않습니다.','Inspect actual paths. No automatic retry.')}</Notice>}</div>)}
    {review&&<Dialog title={t('기본 실행을 전환할까요?','Switch the default launcher?')} onClose={()=>setReview(null)}>
      <Notice tone="warning">{t('공식 실행 파일의 폴더를 ~/.zshrc의 PATH 앞에 둡니다. 같은 폴더의 다른 명령도 우선될 수 있습니다. 앱 전용 런처는 만들지 않으며 새 대화형 zsh에 적용됩니다.','Prepends the official executable directory to PATH in ~/.zshrc. Other commands in that directory may also take precedence. No app-owned launcher is created; applies to new interactive zsh shells.')}</Notice>
      <div className="removal-facts"><Facts items={[[t('정확한 실행 파일','Exact executable'),<span className="path">{review.plan.executable}</span>],[t('셸 프로필 (~/.zshrc)','Shell profile (~/.zshrc)'),<span className="path">{review.plan.profile}</span>]]}/></div>
      {review.plan.limitations.map((limitation,index)=><p className="muted" key={index}>{limitation}</p>)}
      {stale&&<Notice tone="warning">{t('선택·경로·계획이 바뀌었습니다. 닫고 다시 여세요.','Selection, paths or plan changed. Close and open it again.')}</Notice>}
      <div className="cluster"><Button onClick={()=>setReview(null)}>{t('취소','Cancel')}</Button><Button data-action="default-confirm" tone="primary" disabled={locked||stale} onClick={()=>void confirm()}>{t('기본 실행 전환 승인','Confirm default switch')}</Button></div>
    </Dialog>}
  </section>;
}
