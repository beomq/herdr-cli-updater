import { useEffect, useRef, useState } from 'react';
import type { AppCommand, AppSnapshot, PaneSessionPolicy } from '../src/app/types';
import type { CatalogBulk } from '../src/app/catalog-bulk';
import { PaneSessionSummary } from './pane-session-choice';
import { Badge, Button, Dialog, Notice } from './primitives';
import { useLanguage } from './i18n';
import { CatalogUpdateReviewFacts, catalogReviewBinding, catalogUpdateTargetMatches, UpdateExplanation } from './catalog-updates';
import { workspaceBusy } from './automation-settings';

type Props={readonly snapshot:AppSnapshot;readonly guardSnapshot?:AppSnapshot;readonly act:(command:AppCommand)=>Promise<boolean>;readonly disabled:boolean};
type Review={readonly batch:CatalogBulk;readonly server:string|undefined;readonly bindings:string;readonly snapshot:AppSnapshot};
type Waiting={readonly previousId:string|undefined;readonly batchId:string|undefined;readonly server:string|undefined};

export function CatalogBulkActions({snapshot,guardSnapshot=snapshot,act,disabled}:Props) {
  const {t}=useLanguage();
  const batch=snapshot.catalogBulk;
  const [pending,setPending]=useState(false);
  const [waiting,setWaiting]=useState<Waiting|null>(null);
  const [review,setReview]=useState<Review|null>(null);
  // Updates apply to open sessions by default; the review keeps the choice visible.
  const [paneSessions,setPaneSessions]=useState<PaneSessionPolicy>('restart-all');
  const busy=useRef(false);
  const active=!!batch&&['checking','planning','updating'].includes(batch.stage);
  const blocked=disabled||pending||active||workspaceBusy(guardSnapshot)||!!waiting||snapshot.service!=='ready';
  const installed=(snapshot.catalog??[]).some(entry=>entry.installed);
  const readyCount=batch?.stage==='ready'?batch.items.filter(item=>item.status==='ready').length:0;
  const available=(snapshot.catalog??[]).filter(entry=>entry.installed&&entry.lastCheck?.status==='available'&&entry.updateSupport?.kind!=='unsupported'
    &&entry.inventoryStatus!=='checking'&&entry.inventoryStatus!=='failed'&&!snapshot.catalogUpdates?.some(job=>job.catalogId===entry.id&&['updating','uncertain'].includes(job.stage))).length;
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
    current:t('최신 버전','Up to date'),ahead:t('설치 버전이 더 높음','Installed version is newer'),
    unknown:t('버전 비교 불가','Versions not comparable'),unsupported:t('지원 안 됨','Unsupported'),
    failed:t('실패','Failed'),ready:t('승인 대기','Awaiting confirmation'),updating:t('업데이트 중','Updating'),
    completed:t('설치 업데이트 완료','Installation updated'),skipped:t('건너뜀','Skipped'),uncertain:t('결과 확인 필요','Check result'),
  };
  useEffect(()=>{
    if(!waiting)return;
    // Planning refreshes the inventory first, so catalog drift while waiting is expected; the confirmation's own stale guard covers it.
    if(snapshot.serverInstance!==waiting.server){setWaiting(null);return;}
    if(!batch||batch.id===waiting.previousId)return;
    if(waiting.batchId&&batch.id!==waiting.batchId){setWaiting(null);return;}
    if(batch.stage==='ready'){setReview({batch,server:waiting.server,bindings:bindings(batch),snapshot});setWaiting(null);}
    else if(batch.stage==='completed')setWaiting(null);
    else if(!waiting.batchId)setWaiting({...waiting,batchId:batch.id});
  },[batch,waiting,snapshot.serverInstance]);
  const request=async(kind:'catalog-check-all'|'catalog-update-all-plan')=>{
    if(blocked||!installed||busy.current)return;
    busy.current=true;setPending(true);
    if(kind==='catalog-update-all-plan')setWaiting({previousId:batch?.id,batchId:undefined,server:snapshot.serverInstance});
    try{if(!await act({kind}))setWaiting(null);}
    finally{busy.current=false;setPending(false);}
  };
  const confirm=async()=>{
    if(!review||stale||blocked||busy.current||!review.batch.items.some(item=>item.status==='ready'))return;
    busy.current=true;setPending(true);
    try{if(await act({kind:'catalog-update-all-confirm',batchId:review.batch.id,revision:review.batch.revision,paneSessions}))setReview(null);}
    finally{busy.current=false;setPending(false);}
  };
  // The review answers "what changes": one line per update, details folded; CLIs that stay as they are collapse into one sentence.
  const skippedStatuses:readonly CatalogBulk['items'][number]['status'][]=['current','ahead','unknown','unsupported'];
  const rows=(value:CatalogBulk,model:AppSnapshot=snapshot)=>{
    const changing=value.items.filter(item=>!skippedStatuses.includes(item.status)),skipped=value.items.filter(item=>skippedStatuses.includes(item.status));
    return <div className="stack">
      {changing.map(item=><div className="stack update-row" key={item.catalogId} data-bulk-catalog-id={item.catalogId} data-bulk-status={item.status} data-bulk-reason={item.reason??undefined}>
        <p className="cluster"><strong>{item.name}</strong><span className="update-change"><span data-version="installed">{item.beforeVersion??t('미확인','Unknown')}</span> → <strong data-version="checked-latest">{item.latestVersion??t('미확인','Unknown')}</strong></span>
          {item.status!=='ready'&&item.status!=='available'&&<Badge tone={item.status==='completed'?'success':['failed','uncertain'].includes(item.status)?'warning':'neutral'}>{labels[item.status]}</Badge>}</p>
        {item.status==='completed'&&<p className="muted">{t('검증된 설치 버전','Verified installed version')}: {model.catalogUpdates?.find(job=>job.id===item.jobId)?.installedVersion??t('기록 확인 필요','Inspect history')}</p>}
        {(()=>{const job=model.catalogUpdates?.find(job=>job.id===item.jobId);const check=model.catalog?.find(entry=>entry.id===item.catalogId)?.lastCheck;return job?<details><summary>{t('자세히','Details')}</summary><CatalogUpdateReviewFacts job={job} checkedAt={check&&check.latestVersion===job.checkedVersion?check.checkedAt:null}/></details>:null;})()}
        {item.reason&&<Notice tone="warning"><UpdateExplanation code={item.reason}/></Notice>}
      </div>)}
      {skipped.length>0&&<p className="muted" data-bulk-skipped={skipped.length}>{t('그대로 두는 CLI','Left as they are')} {skipped.length}: {skipped.map((item,index)=><span key={item.catalogId} data-bulk-catalog-id={item.catalogId} data-bulk-status={item.status} data-bulk-reason={item.reason??undefined}>{index>0&&', '}{item.name}{item.status!=='current'&&<> ({labels[item.status]})</>}</span>)}</p>}
    </div>;
  };
  const explanation=<p className="muted">{t('공식 배포처의 최신 버전을 설치하고 설치된 버전을 확인합니다.','Installs the latest official release of each and verifies the installed version.')}</p>;
  return <section className="stack" data-catalog-bulk="" data-bulk-stage={batch?.stage??'idle'} data-bulk-id={batch?.id} data-bulk-revision={batch?.revision}>
    <div className="cluster">
      <Button data-action="catalog-check-all" disabled={blocked||!installed} onClick={()=>void request('catalog-check-all')}>{active||waiting?t('업데이트 확인 중','Checking updates'):t('업데이트 확인','Update check')}</Button>
      {batch?.stage==='ready'&&readyCount>0?<Button data-action="catalog-bulk-review" aria-haspopup="dialog" tone="primary" data-update-count={readyCount} disabled={blocked} onClick={()=>setReview({batch,server:snapshot.serverInstance,bindings:bindings(batch),snapshot})}>{t(`전체 업데이트 ${readyCount}`,`Update all ${readyCount}`)}</Button>
        :available>0&&<Button data-action="catalog-update-all-plan" tone="primary" data-update-count={available} disabled={blocked} onClick={()=>void request('catalog-update-all-plan')}>{t(`전체 업데이트 ${available}`,`Update all ${available}`)}</Button>}
    </div>
    <p className="muted">{t('전체 설치를 확인하며 검색에 영향받지 않습니다. 진행과 결과는 각 CLI 카드에 표시합니다.','Checks all installations regardless of search. Progress and results stay on each CLI card.')}</p>
    {review&&<Dialog title={t(`업데이트 ${review.batch.items.filter(item=>item.status==='ready').length}개를 실행할까요?`,`Run ${review.batch.items.filter(item=>item.status==='ready').length} updates?`)} onClose={()=>setReview(null)}>
      <div className="stack" data-bulk-review-id={review.batch.id} data-bulk-review-revision={review.batch.revision} data-bulk-stale={stale}>
        {explanation}{rows(review.batch,review.snapshot)}
        <PaneSessionSummary name="catalog-bulk-pane-sessions" value={paneSessions} disabled={blocked||stale} onChange={setPaneSessions}/>
        {stale&&<Notice tone="warning">{t('계획 또는 서비스가 바뀌었습니다. 닫고 다시 여세요.','The plan or service changed. Close and open it again.')}</Notice>}
        {!review.batch.items.some(item=>item.status==='ready')&&<Notice>{t('업데이트 가능한 설치가 없습니다.','No installations are eligible for update.')}</Notice>}
        <div className="cluster"><Button onClick={()=>setReview(null)}>{t('취소','Cancel')}</Button><Button data-action="catalog-update-all-confirm" tone="primary" disabled={blocked||stale||!review.batch.items.some(item=>item.status==='ready')} onClick={()=>void confirm()}>{t(`업데이트 ${review.batch.items.filter(item=>item.status==='ready').length}개 실행`,`Update ${review.batch.items.filter(item=>item.status==='ready').length}`)}</Button></div>
      </div>
    </Dialog>}
  </section>;
}
