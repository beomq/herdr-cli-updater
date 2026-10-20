import { useEffect, useRef, useState } from 'react';
import type { AppCommand, AppSnapshot } from '../src/app/types';
import type { CatalogEntry, CatalogInstallation } from '../src/app/catalog-types';
import type { RemovalJob } from '../src/app/catalog-removal';
import { Badge, Button, Facts, Notice } from './primitives';
import { useLanguage } from './i18n';

type Act=(command:AppCommand)=>Promise<boolean>;
export type CleanupRow={readonly installation:CatalogInstallation;readonly status:'removable'|'management-target'|'path-default'|'configured-default'|'in-use'|'unknown-manager';readonly sessionPids:readonly number[]};
export function cleanupRows(entry:CatalogEntry,snapshot:AppSnapshot):readonly CleanupRow[]{
  // When the kept installation is reachable on PATH, removing today's PATH default only shifts the
  // command to the kept copy; the hold exists for the case where the command would vanish.
  const keptOnPath=(entry.installations??[]).find(row=>row.id===entry.selectedInstallationId)?.onPath===true;
  return (entry.installations??[]).map(installation=>{
    const sessionPids=snapshot.external.filter(session=>session.processState!=='exited'
      &&(session.family===entry.id||session.catalogId===entry.id||(entry.id==='omo'&&session.family==='pi'))
      &&(session.executable===installation.identityPath||session.executable===installation.path||session.executable.startsWith(installation.root+'/'))).map(session=>session.pid);
    const status:CleanupRow['status']=installation.id===entry.selectedInstallationId?'management-target'
      :entry.configuredDefaultInstallationId===installation.id?'configured-default'
      :(!entry.configuredDefaultInstallationId&&installation.isDefault&&!keptOnPath)?'path-default'
      :installation.removalSupport?.kind==='unsupported'||(installation.manager==='unknown'&&installation.removalSupport?.kind!=='review')?'unknown-manager'
      :sessionPids.length?'in-use':'removable';
    return {installation,status,sessionPids};
  });
}
type Review={readonly target:CatalogInstallation;readonly makeDefault:boolean;readonly server:string|undefined;readonly inventory:string;readonly previous:string|null;readonly removalIds?:readonly string[]};
const inventoryKey=(entry:CatalogEntry)=>JSON.stringify((entry.installations??[]).map(row=>[row.id,row.path,row.identityPath,row.version]));
export function cleanupReviewStale(entry:CatalogEntry,snapshot:AppSnapshot,review:Review):boolean {
  return snapshot.service!=='ready'||snapshot.serverInstance!==review.server||entry.inventoryStatus!=='ready'
    ||inventoryKey(entry)!==review.inventory||(entry.selectedInstallationId??null)!==review.previous;
}
export function cleanupComplete(entry:CatalogEntry,targetId:string):boolean {
  return entry.inventoryStatus==='ready'&&entry.selectedInstallationId===targetId&&entry.installations?.length===1&&entry.installations[0]?.id===targetId;
}
export function CatalogCleanup({entry,snapshot,act,disabled,onInstall}:{readonly entry:CatalogEntry;readonly snapshot:AppSnapshot;readonly act:Act;readonly disabled:boolean;readonly onInstall?:()=>void}){
  const {t}=useLanguage();
  const [targetId,setTargetId]=useState(entry.selectedInstallationId??'');
  const [makeDefault,setMakeDefault]=useState(false);
  const [approved,setApproved]=useState<Review|null>(null);
  const [pending,setPending]=useState(false);
  const [failed,setFailed]=useState(false);
  const [current,setCurrent]=useState<{id:string;known:readonly string[]}|null>(null);
  const [removalReview,setRemovalReview]=useState<{job:RemovalJob;installation:CatalogInstallation}|null>(null);
  const [done,setDone]=useState<readonly string[]>([]);
  const [kept,setKept]=useState<readonly string[]>([]);
  const attempted=useRef<readonly string[]>([]);
  const busy=useRef(false);
  const target=entry.installations?.find(row=>row.id===targetId);
  const jobs=(snapshot.removalJobs??[]).filter(job=>job.catalogId===entry.id);
  const job=current?jobs.find(row=>row.installationId===current.id&&!current.known.includes(row.id)):undefined;
  const selectedDefault=entry.installations?.find(row=>row.id===entry.configuredDefaultInstallationId)??entry.installations?.find(row=>row.isDefault);
  const preview=cleanupRows({...entry,selectedInstallationId:targetId,...(makeDefault?{configuredDefaultInstallationId:targetId}:{})},snapshot);
  const actual=cleanupRows(entry,snapshot);
  const removalStale=!!removalReview&&(!job||JSON.stringify(job)!==JSON.stringify(removalReview.job)
    ||!actual.some(row=>row.status==='removable'&&JSON.stringify(row.installation)===JSON.stringify(removalReview.installation)));
  const ready=!!approved&&entry.selectedInstallationId===approved.target.id
    &&entry.installations?.some(row=>row.id===approved.target.id&&row.path===approved.target.path&&row.identityPath===approved.target.identityPath&&row.version===approved.target.version)
    &&(!approved.makeDefault||entry.configuredDefaultInstallationId===approved.target.id)&&snapshot.serverInstance===approved.server;
  const blocked=disabled||pending||snapshot.service!=='ready'||entry.inventoryStatus!=='ready';
  const recommendation=entry.installMethods?.find(row=>row.recommended);
  const queued=approved&&ready&&!failed&&!current&&!removalReview&&!blocked
    ?actual.find(row=>row.status==='removable'&&approved.removalIds?.includes(row.installation.id)&&!kept.includes(row.installation.id)&&!attempted.current.includes(row.installation.id)):undefined;
  const managers:Record<CatalogInstallation['manager'],string>={bun:'Bun',npm:'npm',brew:'Homebrew',owned:t('앱 전용 설치','App-owned'),unknown:t('독립 설치 / 출처 확인 필요','Standalone / source needs verification')};
  const tone=(row:CleanupRow)=>row.status==='management-target'?'success':row.status==='removable'?'warning':'neutral';
  const reason=(row:CleanupRow)=>kept.includes(row.installation.id)?t('유지하기로 함','Kept'):({removable:t('제거 대상','To remove'),'management-target':t('남길 설치','Keep'),'path-default':t('보류 · 현재 기본 실행','Held · current default'),'configured-default':t('보류 · 새 터미널 기본','Held · configured default'),'in-use':t('보류 · 실행 중 세션 있음','Held · sessions running'),'unknown-manager':t('보류 · 삭제 출처 확인 필요','Held · removal source unverified')})[row.status];
  useEffect(()=>{
    if(job?.stage==='ready'&&!removalReview){
      const row=actual.find(row=>row.installation.id===job.installationId);
      if(row&&approved?.removalIds?.includes(row.installation.id))setRemovalReview({job,installation:row.installation});
    }
    if(!job||!['completed','failed','uncertain'].includes(job.stage))return;
    if(job.stage==='completed')setDone(values=>values.includes(job.id)?values:[...values,job.id]);
    else setFailed(true);
    setCurrent(null);setRemovalReview(null);
  },[job,removalReview]);
  // Planning is read-only: it prepares one review at a time. Deletion still waits for an explicit approval per copy.
  useEffect(()=>{if(queued)void plan(queued);},[queued?.installation.id]);
  const transition=async()=>{
    if(!target?.version||blocked||busy.current)return;
    const review:Review={target,makeDefault,server:snapshot.serverInstance,inventory:inventoryKey(entry),previous:entry.selectedInstallationId??null,removalIds:preview.filter(row=>row.status==='removable').map(row=>row.installation.id)};
    if(cleanupReviewStale(entry,snapshot,review)||!review.target.version)return;
    busy.current=true;setPending(true);setFailed(false);
    try{
      const ok=await act({kind:'catalog-select',catalogId:entry.id,installationId:review.target.id,reviewed:{path:review.target.path,identityPath:review.target.identityPath,version:review.target.version,makeDefault:review.makeDefault}});
      if(ok)setApproved(review);else setFailed(true);
    }catch{setFailed(true);}finally{busy.current=false;setPending(false);}
  };
  const plan=async(row:CleanupRow)=>{
    if(busy.current)return;
    attempted.current=[...attempted.current,row.installation.id];
    busy.current=true;setPending(true);setCurrent({id:row.installation.id,known:jobs.map(job=>job.id)});
    try{if(!await act({kind:'remove-plan',catalogId:entry.id,installationId:row.installation.id})){setCurrent(null);setFailed(true);}}
    catch{setCurrent(null);setFailed(true);}finally{busy.current=false;setPending(false);}
  };
  const remove=async(job:RemovalJob)=>{
    if(!ready||blocked||failed||busy.current||removalStale||!removalReview||job.stage!=='ready'||job.references?.length)return;
    busy.current=true;setPending(true);
    try{if(!await act({kind:'remove-confirm',jobId:job.id,revision:job.revision}))setFailed(true);}
    catch{setFailed(true);}finally{busy.current=false;setPending(false);}
  };
  const keep=(id:string)=>{setKept(values=>[...values,id]);setCurrent(null);setRemovalReview(null);};
  const restart=()=>{setApproved(null);setCurrent(null);setRemovalReview(null);setDone([]);setKept([]);attempted.current=[];setFailed(false);};
  const others=actual.filter(row=>row.installation.id!==approved?.target.id);
  const remaining=others.filter(row=>row.status==='removable'&&approved?.removalIds?.includes(row.installation.id)&&!kept.includes(row.installation.id)).length;
  const outcome=(rows:readonly CleanupRow[],keepId:string)=><ul className="stack cleanup-outcome" data-cleanup-outcome="true">{rows.filter(row=>row.installation.id!==keepId).map(row=><li key={row.installation.id} className="cluster" data-cleanup-status={kept.includes(row.installation.id)?'kept':row.status}><Badge tone={tone(row)}>{reason(row)}</Badge><span className="path">{row.installation.path}</span></li>)}</ul>;
  const herdrNote=entry.herdrLaunch?.status==='unsupported'?t('herdr 전용 실행 종류가 없어 업데이트 대상만 바뀝니다.','No dedicated herdr launch kind; only the update target changes.'):t('지원하는 herdr에서는 이후 새 에이전트 실행에도 적용됩니다. 열린 대화는 그대로입니다.','A supporting herdr also uses it for new agent starts. Open conversations stay unchanged.');
  return <section className="stack" data-catalog-cleanup={entry.id}>
    <h2>{t('설치 정리','Organize installations')}</h2>
    {!approved&&<>
      <p className="muted">{t('남길 설치를 고르면 업데이트 대상으로 전환한 뒤, 나머지 사본을 하나씩 확인하며 제거합니다.','Pick the installation to keep. It becomes the update target, then you confirm each other copy before removal.')}</p>
      {recommendation&&<p className="muted">{t('공식 권장 방식','Official recommendation')}: <a href={recommendation.sourceUrl} target="_blank" rel="noopener noreferrer">{recommendation.label}</a></p>}
      <fieldset className="stack" disabled={blocked}><legend>{t('남길 설치','Installation to keep')}</legend>
        {(entry.installations??[]).map(row=><label className="check consolidation-choice" key={row.id}><input type="radio" name={'retain-'+entry.id} checked={targetId===row.id} onChange={()=>{setTargetId(row.id);setMakeDefault(false);}}/><span className="stack"><strong>{managers[row.manager]} · {row.version??t('버전 미확인','Version unknown')}</strong><span className="path">{row.path}</span><span className="cluster">{row.id===entry.selectedInstallationId&&<Badge>{t('업데이트 대상','Update target')}</Badge>}{row.isDefault&&<Badge>{t('현재 기본 실행','Current default')}</Badge>}{row.id===entry.configuredDefaultInstallationId&&<Badge>{t('새 터미널 기본','New-terminal default')}</Badge>}</span></span></label>)}
      </fieldset>
      {target&&(entry.installations?.length??0)>1&&<div className="stack cleanup-preview"><h3>{t('나머지 사본','Other copies')}</h3>{outcome(preview,target.id)}</div>}
      {target&&preview.some(row=>row.status==='removable'&&row.installation.isDefault)&&<Notice>{t(`제거하면 새 터미널의 ${entry.executable} 명령은 남길 설치(${target.path})를 실행합니다. 이미 PATH에 있어 셀 설정은 바꾸지 않습니다.`,`After removal, ${entry.executable} in new terminals runs the kept installation (${target.path}). It is already on PATH; no shell files change.`)}</Notice>}
      <p className="muted">{herdrNote}</p>
      <details className="cleanup-advanced"><summary>{t('고급: 일반 터미널 PATH','Advanced: general terminal PATH')}</summary>
        <label className="check"><input type="checkbox" checked={makeDefault} disabled={blocked||!target||target.manager==='owned'||selectedDefault?.id===targetId} onChange={e=>setMakeDefault(e.target.checked)}/><span>{t('새 zsh 터미널에서도 이 설치를 기본으로 사용 (~/.zshrc PATH 변경)','Also use this installation in new zsh terminals (changes PATH in ~/.zshrc)')}</span></label>
      </details>
      <div className="cluster"><Button data-action="cleanup-review" tone="primary" disabled={blocked||!target?.version} onClick={()=>void transition()}>{t('이 설치 남기기','Keep this installation')}</Button></div>
      {onInstall&&<details><summary>{t('원하는 설치 방식이 없나요?','Need a different installation method?')}</summary><p>{t('없는 방식만 추가 설치한 뒤 돌아옵니다. 기존 사본은 삭제하지 않습니다.','Add only a missing method, then return. Existing copies are not removed.')}</p><Button data-action="cleanup-install" onClick={onInstall} disabled={blocked}>{t('설치 방법 확인','Review installation methods')}</Button></details>}
    </>}
    {approved&&<section className="stack" data-cleanup-approved="true">
      <Facts items={[[t('남길 설치','Kept installation'),<span className="path">{approved.target.path}</span>]]}/>
      {!ready&&<Notice tone="warning">{t('전환 결과 또는 설치가 달라졌습니다. 삭제는 진행하지 않습니다. 선택부터 다시 하세요.','Transition or installations changed. Removal is blocked; start again from selection.')}</Notice>}
      {others.length>0&&outcome(actual,approved.target.id)}
      {cleanupComplete(entry,approved.target.id)?<Notice tone="success">{t('정리 완료 · 남길 설치 하나만 확인됨','Done · only the kept installation remains')}</Notice>
        :remaining===0&&!current?<Notice>{t(`더 제거할 사본이 없습니다 · 이번에 제거 ${done.length}개`,`Nothing else to remove · ${done.length} removed this time`)}</Notice>
        :<p className="muted">{t(`제거 대상 ${remaining}개 · 이번에 제거 ${done.length}개`,`${remaining} to remove · ${done.length} removed this time`)}</p>}
      {removalReview&&job?.stage==='ready'&&<section className="stack cleanup-confirm" data-cleanup-confirm={removalReview.installation.id}><h3>{t('이 사본을 제거할까요?','Remove this copy?')}</h3>
        <div className="removal-facts"><Facts items={[
          [t('정확한 실행 파일','Exact executable'),<span className="path">{removalReview.job.target.executable}</span>],
          [t('버전','Version'),removalReview.installation.version??t('미확인','Unknown')],
          [t('제거 방법','Removal method'),removalReview.job.target.kind==='owned'||removalReview.job.target.kind==='standalone'?t(`${removalReview.job.target.kind} · 실행 경로에서 빼고 파일은 보관`,`${removalReview.job.target.kind} · unlinks and archives files`):t(`${removalReview.job.target.kind} · 패키지 관리자로 제거`,`${removalReview.job.target.kind} · package manager removal`)],
          [t('제거 위치','Removal location'),<span className="path">{removalReview.job.target.target}</span>],
          [t('보존 (대화·로그인·데이터)','Preserved (conversations, login, data)'),removalReview.job.target.preserve.map(path=><span key={path} className="path">{path}</span>)],
        ]}/></div>
        {!!removalReview.job.references?.length&&<Notice tone="warning">{t('이 설치를 참조하는 설정 때문에 보류합니다.','Held because configuration references this installation.')}<ul>{removalReview.job.references.map(path=><li key={path} className="path">{path}</li>)}</ul></Notice>}
        {removalStale&&<Notice tone="warning">{t('제거 대상 또는 계획이 바뀌었습니다. 선택부터 다시 하세요.','Removal target or plan changed. Start again from selection.')}</Notice>}
        <div className="cluster"><Button data-action="cleanup-remove" tone="danger" disabled={blocked||!ready||failed||removalStale||!!removalReview.job.references?.length} onClick={()=>void remove(removalReview.job)}>{t('제거','Remove')}</Button><Button data-action="cleanup-keep" disabled={pending} onClick={()=>keep(removalReview.installation.id)}>{t('이 사본은 유지','Keep this copy')}</Button></div>
      </section>}
      {current&&!job&&<Notice>{t('제거 계획 확인 중','Preparing removal review')}</Notice>}
      {job?.stage==='removing'&&<Notice>{t('제거 결과 확인 중','Checking removal result')}</Notice>}
      <div className="cluster"><Button data-action="cleanup-restart" disabled={pending||job?.stage==='removing'} onClick={restart}>{t('선택부터 다시','Start over')}</Button></div>
    </section>}
    {failed&&<Notice tone="error">{t('작업이 완료되지 않아 정리를 멈췄습니다. 추가로 삭제하지 않습니다. 작업 기록과 현재 경로를 확인하세요.','The operation did not complete. Cleanup stopped without further removal. Inspect history and current paths.')}</Notice>}
  </section>;
}
