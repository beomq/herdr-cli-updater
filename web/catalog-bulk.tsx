import { useEffect, useRef, useState } from 'react';
import type { AppCommand, AppSnapshot } from '../src/app/types';
import type { CatalogBulk } from '../src/app/catalog-bulk';
import { Badge, Button, Dialog, Notice } from './primitives';
import { useLanguage } from './i18n';
import { CatalogUpdateHistory, CatalogUpdateReviewFacts, catalogReviewBinding, catalogUpdateTargetMatches, UpdateExplanation } from './catalog-updates';

type Props={readonly snapshot:AppSnapshot;readonly act:(command:AppCommand)=>Promise<boolean>;readonly disabled:boolean};
type Review={readonly batch:CatalogBulk;readonly server:string|undefined;readonly bindings:string;readonly snapshot:AppSnapshot};
type Waiting={readonly previousId:string|undefined;readonly batchId:string|undefined;readonly server:string|undefined;readonly targets:string};

export function CatalogBulkActions({snapshot,act,disabled}:Props) {
  const {t}=useLanguage();
  const batch=snapshot.catalogBulk;
  const [pending,setPending]=useState(false);
  const [waiting,setWaiting]=useState<Waiting|null>(null);
  const [review,setReview]=useState<Review|null>(null);
  const busy=useRef(false);
  const active=!!batch&&['checking','planning','updating'].includes(batch.stage);
  const blocked=disabled||pending||active||!!waiting||snapshot.service!=='ready';
  const installed=(snapshot.catalog??[]).some(entry=>entry.installed);
  const targets=JSON.stringify(snapshot.catalog?.map(entry=>catalogReviewBinding(entry)));
  const bindings=(value:CatalogBulk)=>JSON.stringify(value.items.filter(item=>item.status==='ready').map(item=>{
    const job=snapshot.catalogUpdates?.find(job=>job.id===item.jobId);
    const entry=snapshot.catalog?.find(entry=>entry.id===item.catalogId);
    return [item.catalogId,job,catalogReviewBinding(entry)];
  }));
  const stale=!!review&&(!batch||batch.id!==review.batch.id||batch.revision!==review.batch.revision
    ||batch.stage!=='ready'||snapshot.serverInstance!==review.server||bindings(review.batch)!==review.bindings
    ||review.batch.items.some(item=>{if(item.status!=='ready')return false;
      const job=snapshot.catalogUpdates?.find(job=>job.id===item.jobId);
      const entry=snapshot.catalog?.find(entry=>entry.id===item.catalogId);
      return !job||job.stage!=='ready'||job.revision!==item.jobRevision||!catalogUpdateTargetMatches(entry,job)||entry?.installed?.version!==item.beforeVersion;}));
  const labels:Record<CatalogBulk['items'][number]['status'],string>={
    checking:t('최신 조회 중','Checking latest'),available:t('새 버전 있음','New version available'),
    current:t('최신 버전 · 제외','Up to date · excluded'),ahead:t('설치 버전이 더 높음 · 제외','Installed version is newer · excluded'),
    unknown:t('버전 비교 불가 · 제외','Versions not comparable · excluded'),unsupported:t('지원 안 됨 · 제외','Unsupported · excluded'),
    failed:t('실패','Failed'),ready:t('승인 대기','Awaiting confirmation'),updating:t('업데이트 중','Updating'),
    completed:t('설치 업데이트 완료','Installation updated'),skipped:t('건너뜀','Skipped'),uncertain:t('결과 확인 필요','Check result'),
  };
  const stages:Record<CatalogBulk['stage'],string>={checking:t('전체 최신 조회 중','Checking all'),planning:t('전체 업데이트 준비 중','Preparing all updates'),ready:t('전체 업데이트 승인 대기','Awaiting bulk confirmation'),updating:t('전체 업데이트 실행 중','Updating all'),completed:t('전체 작업 결과','Bulk results')};
  useEffect(()=>{
    if(!waiting)return;
    if(snapshot.serverInstance!==waiting.server||targets!==waiting.targets){setWaiting(null);return;}
    if(!batch||batch.id===waiting.previousId)return;
    if(waiting.batchId&&batch.id!==waiting.batchId){setWaiting(null);return;}
    if(batch.stage==='ready'){setReview({batch,server:waiting.server,bindings:bindings(batch),snapshot});setWaiting(null);}
    else if(batch.stage==='completed')setWaiting(null);
    else if(!waiting.batchId)setWaiting({...waiting,batchId:batch.id});
  },[batch,waiting,snapshot.serverInstance,targets]);
  const request=async(kind:'catalog-check-all'|'catalog-update-all-plan')=>{
    if(blocked||!installed||busy.current)return;
    busy.current=true;setPending(true);
    if(kind==='catalog-update-all-plan')setWaiting({previousId:batch?.id,batchId:undefined,server:snapshot.serverInstance,targets});
    try{if(!await act({kind}))setWaiting(null);}
    finally{busy.current=false;setPending(false);}
  };
  const confirm=async()=>{
    if(!review||stale||blocked||busy.current||!review.batch.items.some(item=>item.status==='ready'))return;
    busy.current=true;setPending(true);
    try{if(await act({kind:'catalog-update-all-confirm',batchId:review.batch.id,revision:review.batch.revision}))setReview(null);}
    finally{busy.current=false;setPending(false);}
  };
  const rows=(value:CatalogBulk,model:AppSnapshot=snapshot)=><div className="stack">{value.items.map(item=><div className="stack" key={item.catalogId} data-bulk-catalog-id={item.catalogId} data-bulk-status={item.status} data-bulk-reason={item.reason??undefined}>
    <div className="cluster"><strong>{item.name}</strong><Badge tone={item.status==='completed'?'success':['failed','uncertain'].includes(item.status)?'warning':'neutral'}>{labels[item.status]}</Badge></div>
    <p><span data-version="installed">{item.beforeVersion??t('미확인','Unknown')}</span> → <span data-version="checked-latest">{item.latestVersion??t('미확인','Unknown')}</span></p>
    {item.status==='completed'&&<p className="muted">{t('검증된 설치 버전','Verified installed version')}: {model.catalogUpdates?.find(job=>job.id===item.jobId)?.installedVersion??t('기록 확인 필요','Inspect history')}</p>}
    {(()=>{const job=model.catalogUpdates?.find(job=>job.id===item.jobId);const check=model.catalog?.find(entry=>entry.id===item.catalogId)?.lastCheck;return job?<CatalogUpdateReviewFacts job={job} checkedAt={check&&check.latestVersion===job.checkedVersion?check.checkedAt:null}/>:null;})()}
    {item.reason&&<Notice tone="warning"><UpdateExplanation code={item.reason}/></Notice>}
  </div>)}</div>;
  const explanation=<p className="muted">{t('표시한 최신 버전은 조회 당시 값입니다. 실행 시 공식 배포처의 최신 버전을 설치하고 실제 설치 버전을 검증합니다. 실행 중인 세션과 창은 종료하거나 다시 시작하지 않습니다.','Latest versions shown were checked during preparation. Execution installs the official latest release and verifies the installed version. Running sessions and panes are kept without stopping or restarting.')}</p>;
  return <section className="stack" data-catalog-bulk="" data-bulk-stage={batch?.stage??'idle'}>
    <div className="cluster">
      <Button data-action="catalog-check-all" disabled={blocked||!installed} onClick={()=>void request('catalog-check-all')}>{t('전체 최신 확인','Check all latest')}</Button>
      <Button data-action="catalog-update-all-plan" disabled={blocked||!installed} onClick={()=>void request('catalog-update-all-plan')}>{t('전체 업데이트 준비','Prepare all updates')}</Button>
      {batch?.stage==='ready'&&<Button data-action="catalog-bulk-review" aria-haspopup="dialog" disabled={blocked} onClick={()=>setReview({batch,server:snapshot.serverInstance,bindings:bindings(batch),snapshot})}>{t('전체 업데이트 검토','Review all updates')}</Button>}
    </div>
    <p className="muted">{t('검색 결과와 관계없이 설치된 전체 CLI 카탈로그에 적용합니다. 최신 확인과 업데이트 준비는 설치를 변경하지 않으며, 업데이트 실행은 별도 승인이 필요합니다.','Applies to the whole installed CLI catalog regardless of search results. Checking and preparation do not change installations; execution requires separate confirmation.')}</p>
    {waiting&&<Notice>{t('전체 업데이트를 준비하고 있습니다.','Preparing the whole catalog update.')}<Button onClick={()=>setWaiting(null)}>{t('취소','Cancel')}</Button></Notice>}
    {batch&&<section className="stack" data-bulk-id={batch.id} data-bulk-revision={batch.revision} aria-live="polite"><h3>{stages[batch.stage]}</h3>{explanation}{rows(batch)}</section>}
    {batch?.stage==='completed'&&batch.items.some(item=>item.status==='uncertain'||item.status==='failed')&&<section className="stack" data-bulk-recovery="">
      <Notice tone="warning">{t('일부 항목은 완료되지 않았습니다. 성공한 항목은 반복하지 않으며 미확정 결과는 아래에서 개별 재확인합니다. 실패한 항목은 원인을 확인한 뒤 해당 CLI에서 새로 검토하세요.','Some items did not complete. Completed items are not replayed; uncertain results can be rechecked individually below. Inspect failed items and start a fresh review for that CLI.')}</Notice>
      <CatalogUpdateHistory snapshot={snapshot} jobIds={batch.items.flatMap(item=>item.jobId&&(item.status==='uncertain'||item.status==='failed')?[item.jobId]:[])} act={act} disabled={disabled||pending}/>
    </section>}
    {review&&<Dialog title={t('전체 업데이트 검토','Review all updates')} onClose={()=>setReview(null)}>
      <div className="stack" data-bulk-review-id={review.batch.id} data-bulk-review-revision={review.batch.revision} data-bulk-stale={stale}>
        {explanation}{rows(review.batch,review.snapshot)}
        {stale&&<Notice tone="warning">{t('계획 또는 서비스가 바뀌었습니다. 닫고 다시 검토하세요.','The plan or service changed. Close and review again.')}</Notice>}
        {!review.batch.items.some(item=>item.status==='ready')&&<Notice>{t('업데이트 가능한 설치가 없습니다.','No installations are eligible for update.')}</Notice>}
        <div className="cluster"><Button onClick={()=>setReview(null)}>{t('취소','Cancel')}</Button><Button data-action="catalog-update-all-confirm" tone="primary" disabled={blocked||stale||!review.batch.items.some(item=>item.status==='ready')} onClick={()=>void confirm()}>{t('전체 업데이트 실행','Confirm all updates')}</Button></div>
      </div>
    </Dialog>}
  </section>;
}
