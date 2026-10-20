import { useEffect, useRef, useState } from 'react';
import type { AppCommand, AppSnapshot } from '../src/app/types';
import type { CatalogId } from '../src/app/catalog-types';
import type { RemovalJob } from '../src/app/catalog-removal';
import { Badge, Button, Dialog, Facts, Notice, Panel, SectionHead } from './primitives';
import { useLanguage } from './i18n';
import { removalExplanation } from './removal-status';

export function RemovalActions({snapshot,act,disabled,catalogId,installationId}:{readonly snapshot:AppSnapshot;readonly act:(command:AppCommand)=>Promise<boolean>;readonly disabled:boolean;readonly catalogId:CatalogId;readonly installationId?:string|undefined}){
  const {t}=useLanguage();
  const [waiting,setWaiting]=useState<readonly string[]|null>(null);
  const [review,setReview]=useState<RemovalJob|null>(null);
  const [pending,setPending]=useState(false);
  const [reasonOpen,setReasonOpen]=useState(false);
  const busy=useRef(false);
  const allJobs=(snapshot.removalJobs??[]).filter(job=>job.catalogId===catalogId);
  const entry=snapshot.catalog?.find(row=>row.id===catalogId);
  const support=entry?.installations?.find(row=>row.id===(installationId??entry.selectedInstallationId))?.removalSupport;
  const jobs=allJobs.filter(job=>(job.installationId??null)===(installationId??null));
  const blocked=allJobs.some(job=>job.stage==='removing'||job.stage==='uncertain');
  const current=review&&jobs.find(job=>job.id===review.id);
  const instance=installationId?snapshot.catalog?.find(entry=>entry.id===catalogId)?.installations?.find(row=>row.id===installationId):null;
  const stale=!!review&&(!current||current.stage!=='ready'||current.revision!==review.revision||blocked
    ||(!!installationId&&(!instance||(instance.path!==review.target.executable&&instance.identityPath!==review.target.executable))));
  useEffect(()=>{
    if(!waiting)return;
    const job=(snapshot.removalJobs??[]).find(job=>job.catalogId===catalogId&&(job.installationId??null)===(installationId??null)&&job.stage==='ready'&&!waiting.includes(job.id));
    if(job){setReview(job);setWaiting(null);}
  },[snapshot.removalJobs,waiting,catalogId,installationId]);
  const plan=async()=>{
    if(busy.current||disabled||blocked)return;
    busy.current=true;setPending(true);setWaiting(jobs.map(job=>job.id));
    try{if(!await act({kind:'remove-plan',catalogId,...(installationId?{installationId}:{})}))setWaiting(null);}
    finally{busy.current=false;setPending(false);}
  };
  const confirm=async()=>{
    if(!review||stale||disabled||busy.current)return;
    busy.current=true;setPending(true);
    try{if(await act({kind:'remove-confirm',jobId:review.id,revision:review.revision}))setReview(null);}
    finally{busy.current=false;setPending(false);}
  };
  return <><Button disabled={disabled||pending||blocked||!!waiting||support?.kind==='unsupported'} onClick={()=>void plan()}>{pending||waiting?t('확인 중','Checking'):t('삭제','Remove')}</Button>
    {support?.kind==='unsupported'&&<Button data-removal-reason={support.reason} aria-haspopup="dialog" onClick={()=>setReasonOpen(true)}>{t('제한 이유','Why unavailable')}</Button>}
    {reasonOpen&&<Dialog title={t('삭제 제한 이유','Removal limitation')} onClose={()=>setReasonOpen(false)}><p>{removalExplanation(support?.reason??'removal_source_unverified',t)}</p><a className="catalog-link" href={entry?.sourceUrl} target="_blank" rel="noopener noreferrer">{t('공식 안내','Official guide')}</a></Dialog>}
    {waiting&&<Button onClick={()=>setWaiting(null)}>{t('닫기','Close')}</Button>}
    {blocked&&<span className="muted">{t('삭제 작업 결과를 먼저 확인하세요.','Check the removal result first.')}</span>}
    {review&&<Dialog title={t('CLI 삭제','Remove CLI')} onClose={()=>setReview(null)}>
      <Notice tone="warning">{t('CLI 실행 파일을 제거합니다. 실행 중인 세션이나 자동 업데이트가 있으면 먼저 종료하거나 끄세요. 대화·로그인·사용자 설정은 삭제하지 않습니다.','Remove the CLI installation. Close running sessions and disable automatic updates first. Conversations, login and user settings are preserved.')}</Notice>
      {review.target.kind==='owned'&&<Notice>{t('사용자 파일을 보존하기 위해 설치 내용은 .removed-payload로 보관하고 실행 경로에서 제거합니다. 디스크 공간을 비우는 완전 삭제는 아닙니다.','To preserve user files, installation contents are archived as .removed-payload and removed from the launch path. This does not reclaim installation disk space.')}</Notice>}
      {review.target.kind==='standalone'&&<Notice>{t('독립 실행 파일을 아래 보관 경로에 남기고 실행 경로에서 제거합니다. 다른 버전·설정·로그인·대화·셸 PATH는 그대로 둡니다. 공간을 비우는 완전 삭제는 아닙니다.','Archives the standalone binary and removes its launch path. Other versions, configuration, login, conversations and shell PATH are preserved. This does not reclaim disk space.')}</Notice>}
      <div className="removal-facts"><Facts items={[[t('CLI','CLI'),snapshot.catalog?.find(row=>row.id===catalogId)?.name??catalogId],[t('삭제 방식','Removal method'),review.target.kind==='owned'?t('이 앱의 전용 설치 제거','Remove app-owned installation'):review.target.kind],
        [t('삭제 대상','Removal target'),<span className="path">{review.target.kind==='standalone'?review.target.payload:review.target.kind==='owned'?review.target.target:review.target.kind==='brew'?review.target.payloadRoot:review.target.target+'/node_modules/'+review.target.packageName}</span>],[t('실행 파일','Executable'),<span className="path">{review.target.executable}</span>],
        [t('보존되는 경로','Preserved paths'),review.target.preserve.map(path=><div key={path} className="path">{path}</div>)]]}/></div>
      {!!review.references?.length&&<Notice tone="warning">{t('이 설치를 참조하는 설정이 있습니다. 아래 설정 경로를 수정한 뒤 다시 시도하세요.','Configuration still references this installation. Correct these paths, then try again.')}<ul>{review.references.map(path=><li className="path" key={path}>{path}</li>)}</ul></Notice>}
      {stale&&<Notice tone="warning">{t('설치 상태가 바뀌었습니다. 창을 닫고 삭제 버튼을 다시 누르세요.','The installation changed. Close this dialog and choose Remove again.')}</Notice>}
      <div className="cluster"><Button onClick={()=>setReview(null)}>{t('취소','Cancel')}</Button><Button tone="danger" disabled={disabled||pending||stale||!!review.references?.length} onClick={()=>void confirm()}>{t('삭제하기','Remove CLI')}</Button></div>
    </Dialog>}
  </>;
}

export function RemovalHistory({snapshot}:{readonly snapshot:AppSnapshot}){
  const {t}=useLanguage();const jobs=snapshot.removalJobs??[];
  if(!jobs.length)return null;
  const labels:Record<RemovalJob['stage'],string>={ready:t('삭제 전 확인 · 아직 삭제 안 됨','Not removed · confirmation required'),removing:t('삭제 중','Removing'),completed:t('삭제 완료','Removed'),failed:t('삭제 실패','Removal failed'),uncertain:t('삭제 결과 확인 필요','Check removal result')};
  return <section className="stack"><SectionHead title={t('삭제 작업','Removal jobs')} count={jobs.length}/>{jobs.map(job=><Panel key={job.id}>
    <div className="page-head"><h3>{snapshot.catalog?.find(row=>row.id===job.catalogId)?.name??job.catalogId}</h3><Badge tone={job.stage==='completed'?'success':job.stage==='uncertain'?'warning':'neutral'}>{labels[job.stage]}</Badge></div>
    <p className="path">{job.target.target}</p>{job.failure&&<Notice tone="warning">{t('자동으로 다시 실행하지 않습니다. 대상 경로의 실제 상태를 확인하세요.','This operation will not be retried automatically. Inspect the target path.')+' '+job.failure}</Notice>}
  </Panel>)}</section>;
}
