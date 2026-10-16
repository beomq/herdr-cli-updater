import { useEffect, useRef, useState } from 'react';
import type { AppCommand, AppSnapshot } from '../src/app/types';
import type { CatalogEntry, CatalogInstallation } from '../src/app/catalog-types';
import type { RemovalJob } from '../src/app/catalog-removal';
import { Badge, Button, Facts, Notice } from './primitives';
import { useLanguage } from './i18n';

type Act=(command:AppCommand)=>Promise<boolean>;
export type CleanupRow={readonly installation:CatalogInstallation;readonly status:'removable'|'management-target'|'path-default'|'configured-default'|'in-use'|'unknown-manager';readonly sessionPids:readonly number[]};
export function cleanupRows(entry:CatalogEntry,snapshot:AppSnapshot):readonly CleanupRow[]{
  return (entry.installations??[]).map(installation=>{
    const sessionPids=snapshot.external.filter(session=>session.processState!=='exited'
      &&(session.family===entry.id||session.catalogId===entry.id||(entry.id==='omo'&&session.family==='pi'))
      &&(session.executable===installation.identityPath||session.executable===installation.path||session.executable.startsWith(installation.root+'/'))).map(session=>session.pid);
    const status:CleanupRow['status']=installation.id===entry.selectedInstallationId?'management-target'
      :entry.configuredDefaultInstallationId===installation.id?'configured-default'
      :(!entry.configuredDefaultInstallationId&&installation.isDefault)?'path-default'
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
  const [review,setReview]=useState<Review|null>(null);
  const [approved,setApproved]=useState<Review|null>(null);
  const [pending,setPending]=useState(false);
  const [failed,setFailed]=useState(false);
  const [current,setCurrent]=useState<{id:string;known:readonly string[]}|null>(null);
  const [removalReview,setRemovalReview]=useState<{job:RemovalJob;installation:CatalogInstallation}|null>(null);
  const [done,setDone]=useState<readonly string[]>([]);
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
  const managers:Record<CatalogInstallation['manager'],string>={bun:'Bun',npm:'npm',brew:'Homebrew',owned:t('앱 전용 설치','App-owned'),unknown:t('독립 설치 / 출처 확인 필요','Standalone / source needs verification')};
  const reason=(row:CleanupRow)=>({removable:t('제거 검토 가능','Can review removal'),'management-target':t('남길 설치','Keep'),'path-default':t('보류 · 현재 기본 실행','Held · current default'),'configured-default':t('보류 · 새 터미널 기본','Held · configured default'),'in-use':t('보류 · 실행 중 세션 있음','Held · sessions running'),'unknown-manager':t('보류 · 삭제 출처 확인 필요','Held · removal source unverified')})[row.status];
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
  const transition=async()=>{
    if(!review||cleanupReviewStale(entry,snapshot,review)||blocked||busy.current||!review.target.version)return;
    busy.current=true;setPending(true);setFailed(false);
    try{
      const ok=await act({kind:'catalog-select',catalogId:entry.id,installationId:review.target.id,reviewed:{path:review.target.path,identityPath:review.target.identityPath,version:review.target.version,makeDefault:review.makeDefault}});
      if(ok){setApproved(review);setReview(null);}else setFailed(true);
    }catch{setFailed(true);}finally{busy.current=false;setPending(false);}
  };
  const next=async()=>{
    if(!ready||blocked||failed||current||busy.current)return;
    const row=actual.find(row=>row.status==='removable'&&approved?.removalIds?.includes(row.installation.id));if(!row)return;
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
  return <section className="stack" data-catalog-cleanup={entry.id}>
    <h2>{t('설치 정리','Organize installations')}</h2>
    <p className="muted">{t('기존 설치 중 남길 것을 고르세요. 검증과 전환이 끝난 뒤 다른 사본을 하나씩 승인해 정리합니다. 여러 설치를 계속 유지해도 됩니다.','Choose an existing installation to keep. Verify and switch first, then approve each other copy for removal. Keeping multiple installations is also supported.')}</p>
    {recommendation&&<p>{t('공식 권장 방식','Official recommendation')}: <a href={recommendation.sourceUrl} target="_blank" rel="noopener noreferrer">{recommendation.label}</a></p>}
    <fieldset className="stack" disabled={blocked||!!approved||!!review}><legend>{t('1. 남길 설치 선택','1. Choose what to keep')}</legend>
      {(entry.installations??[]).map(row=><label className="check consolidation-choice" key={row.id}><input type="radio" name={'retain-'+entry.id} checked={targetId===row.id} onChange={()=>{setTargetId(row.id);setMakeDefault(false);}}/><span className="stack"><strong>{managers[row.manager]} · {row.version??t('버전 미확인','Version unknown')}</strong><span className="path">{row.path}</span><span className="cluster">{row.id===entry.selectedInstallationId&&<Badge>{t('업데이트 대상','Update target')}</Badge>}{row.isDefault&&<Badge>{t('현재 기본 실행','Current default')}</Badge>}{row.id===entry.configuredDefaultInstallationId&&<Badge>{t('새 터미널 기본','New-terminal default')}</Badge>}</span></span></label>)}
    </fieldset>
    {!approved&&!review&&<>
      <label className="check"><input type="checkbox" checked={makeDefault} disabled={blocked||!target||target.manager==='owned'||selectedDefault?.id===targetId} onChange={e=>setMakeDefault(e.target.checked)}/><span>{t('남길 설치를 새 터미널의 기본 실행으로도 사용','Also use this installation by default in new terminals')}</span></label>
      <p className="muted">{t('체크하면 ~/.zshrc의 PATH를 변경합니다. 현재 대화는 유지하며 자동 업데이트가 꺼져 있으면 그대로 둡니다.','Checking changes PATH in ~/.zshrc. Current conversations stay open and disabled automation stays off.')}</p>
      <div className="cluster"><Button data-action="cleanup-review" tone="primary" disabled={blocked||!target?.version} onClick={()=>{if(target){setFailed(false);setReview({target,makeDefault,server:snapshot.serverInstance,inventory:inventoryKey(entry),previous:entry.selectedInstallationId??null,removalIds:preview.filter(row=>row.status==='removable').map(row=>row.installation.id)});}}}>{t('변경 내용 검토','Review changes')}</Button></div>
      {onInstall&&<details><summary>{t('원하는 설치 방식이 없나요?','Need a different installation method?')}</summary><p>{t('이미 설치된 방식은 위에서 선택하세요. 없는 방식만 추가 설치한 뒤 이 화면으로 돌아옵니다. 기존 사본은 아직 삭제하지 않습니다.','Select an existing method above. Only add a missing method, then return here. Existing copies are not removed yet.')}</p><Button data-action="cleanup-install" onClick={onInstall} disabled={blocked}>{t('설치 방법 확인','Review installation methods')}</Button></details>}
    </>}
    {review&&<section className="stack" data-cleanup-review="true"><h3>{t('2. 전환과 정리 결과 검토','2. Review transition and cleanup')}</h3>
      <Facts items={[[t('업데이트 대상으로 남길 설치','Retained update target'),<span className="path">{review.target.path}</span>],[t('터미널 기본 실행','Terminal default'),review.makeDefault?t('남길 설치로 변경','Switch to retained installation'):t('변경하지 않음','Keep current default')]]}/>
      <ul className="stack">{preview.map(row=><li key={row.installation.id}><Badge>{reason(row)}</Badge><p className="path">{row.installation.path}</p></li>)}</ul>
      <p>{t('먼저 남길 설치를 검증하고 업데이트 대상·승인한 기본 실행을 전환합니다. 실패하면 삭제 단계로 진행하지 않습니다. 각 사본의 삭제는 이후 별도로 승인합니다.','First verify and switch the update target and approved terminal default. Failure prevents cleanup. Approve each removal separately afterward.')}</p>
      {cleanupReviewStale(entry,snapshot,review)&&<Notice tone="warning">{t('설치 상태가 바뀌었습니다. 돌아가서 다시 검토하세요.','Installations changed. Go back and review again.')}</Notice>}
      <div className="cluster"><Button disabled={pending} onClick={()=>setReview(null)}>{t('돌아가기','Back')}</Button><Button data-action="cleanup-transition" tone="primary" disabled={blocked||cleanupReviewStale(entry,snapshot,review)} onClick={()=>void transition()}>{t('검증하고 전환','Verify and switch')}</Button></div>
    </section>}
    {approved&&<section className="stack"><h3>{t('3. 남은 사본 정리','3. Clean up remaining copies')}</h3>
      {!ready&&<Notice tone="warning">{t('전환 결과 또는 설치가 달라졌습니다. 새 상태를 확인하고 다시 검토하세요. 삭제는 진행하지 않습니다.','Transition or installation changed. Review fresh state; removal is blocked.')}</Notice>}
      <ul className="stack">{actual.map(row=><li key={row.installation.id}><Badge>{reason(row)}</Badge><p className="path">{row.installation.path}</p></li>)}</ul>
      <Notice tone={cleanupComplete(entry,approved.target.id)?'success':'warning'}>{cleanupComplete(entry,approved.target.id)?t('설치 정리 완료 · 남길 설치 하나만 확인됨','Consolidation complete · only the retained installation remains'):t(`정리 진행 / 보류 · 남은 사본 ${Math.max(0,(entry.installations?.length??0)-1)}개 · 이번 정리 ${done.length}개`,`In progress / held · ${Math.max(0,(entry.installations?.length??0)-1)} copies remain · ${done.length} removed this time`)}</Notice>
      {removalReview&&<section className="stack"><h3>{t('이 사본 제거 검토','Review this copy for removal')}</h3>
        <div className="removal-facts"><Facts items={[
          [t('정확한 실행 파일','Exact executable'),<span className="path">{removalReview.job.target.executable}</span>],
          [t('버전','Version'),removalReview.installation.version??t('미확인','Unknown')],
          [t('제거 방법','Removal method'),removalReview.job.target.kind],
          [t('제거 위치','Removal location'),<span className="path">{removalReview.job.target.target}</span>],
          [t('보존 경로','Preserved paths'),removalReview.job.target.preserve.map(path=><span key={path} className="path">{path}</span>)],
        ]}/></div>
        <p>{t('대화·로그인·사용자 데이터는 보존합니다.','Conversations, login and user data are preserved.')}</p>
        <p>{removalReview.job.target.kind==='owned'||removalReview.job.target.kind==='standalone'?t('실행 경로에서 제거하고 파일은 보관합니다. 디스크 공간을 비우는 완전 삭제가 아닙니다.','Removes the launch path and archives files; disk space is not reclaimed.'):t('패키지 관리자로 이 설치를 제거합니다.','Remove this installation using its package manager.')}</p>
        {!!removalReview.job.references?.length&&<Notice tone="warning">{t('이 설치를 참조하는 설정 때문에 보류합니다.','Held because configuration references this installation.')}<ul>{removalReview.job.references.map(path=><li key={path} className="path">{path}</li>)}</ul></Notice>}
        {removalStale&&<Notice tone="warning">{t('제거 대상 또는 계획이 바뀌었습니다. 선택부터 다시 검토하세요.','Removal target or plan changed. Review from selection again.')}</Notice>}
        <Button data-action="cleanup-remove" tone="danger" disabled={blocked||!ready||failed||removalStale||!!removalReview.job.references?.length} onClick={()=>void remove(removalReview.job)}>{t('이 사본 제거 승인','Approve removal of this copy')}</Button></section>}
      {current&&!job&&<Notice>{t('제거 계획 확인 중','Preparing removal review')}</Notice>}
      {job?.stage==='removing'&&<Notice>{t('제거 결과 확인 중','Checking removal result')}</Notice>}
      {!current&&<Button data-action="cleanup-next" disabled={blocked||!ready||failed||!actual.some(row=>row.status==='removable'&&approved.removalIds?.includes(row.installation.id))} onClick={()=>void next()}>{t('다음 사본 제거 검토','Review next copy')}</Button>}
      <Button disabled={pending||job?.stage==='removing'} onClick={()=>{setApproved(null);setCurrent(null);setRemovalReview(null);setDone([]);setFailed(false);}}>{t('선택부터 다시 검토','Review from selection')}</Button>
    </section>}
    {failed&&<Notice tone="error">{t('작업이 완료되지 않아 정리를 중단했습니다. 기존 사본은 추가로 삭제하지 않습니다. 작업 기록과 현재 경로를 확인하세요.','The operation did not complete. Cleanup stopped without deleting further copies. Inspect job history and current paths.')}</Notice>}
  </section>;
}
