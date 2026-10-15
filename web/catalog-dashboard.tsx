import { useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { AppCommand, AppSnapshot } from '../src/app/types';
import type { CatalogEntry } from '../src/app/catalog-types';
import type { CatalogUpdateJob } from '../src/app/catalog-updates';
import { AgentMark } from './agent-mark';
import { CatalogInstallations } from './catalog-installations';
import { UpdateExplanation } from './catalog-updates';
import { Badge, Button, Dialog, Facts, Notice } from './primitives';
import { localeFor, useLanguage } from './i18n';
import { versionStatusLabel } from './install-status';

type Tab='overview'|'sessions'|'history'|'automation';
type Props={readonly entry:CatalogEntry;readonly snapshot:AppSnapshot;readonly act:(command:AppCommand)=>Promise<boolean>;
  readonly disabled:boolean;readonly sessions:ReactNode;readonly history:ReactNode;readonly automation:ReactNode};

export function CatalogDashboardRow({entry,snapshot,act,disabled,sessions,history,automation}:Props) {
  const {language,t}=useLanguage();
  const id=useId();
  const [tab,setTab]=useState<Tab|null>(null);
  const [pending,setPending]=useState(false);
  const [waiting,setWaiting]=useState<readonly string[]|null>(null);
  const [review,setReview]=useState<{readonly job:CatalogUpdateJob;readonly server:string|undefined}|null>(null);
  const busy=useRef(false);
  const jobs=snapshot.catalogUpdates??[];
  const activeJob=jobs.find(job=>job.stage==='updating'||job.stage==='uncertain');
  const ready=[...jobs].reverse().find(job=>job.stage==='ready');
  const current=review&&jobs.find(job=>job.id===review.job.id);
  const stale=!!review&&(!current||current.stage!=='ready'||current.revision!==review.job.revision
    ||review.server!==snapshot.serverInstance||(review.job.installationId??null)!==(entry.selectedInstallationId??null)
    ||![entry.installed?.path,entry.installed?.identityPath].includes(review.job.target.executable)||!!activeJob);
  const blocked=disabled||pending||!!waiting||!!activeJob||!entry.installed||entry.inventoryStatus==='checking'||entry.inventoryStatus==='failed';
  const check=entry.lastCheck;
  const unsupported=entry.updateSupport?.kind==='unsupported'||check?.status==='unsupported';
  const status=check?.status??'unchecked';
  const labels={unchecked:t('최신 확인 전','Not checked'),checking:t('최신 조회 중','Checking latest'),available:t('새 버전 있음','New version available'),current:t('최신 버전','Up to date'),ahead:t('설치 버전이 더 높음','Installed version is newer'),unknown:t('버전 비교 불가','Versions not comparable'),unsupported:t('앱 내 조회 미지원','In-app check unavailable'),failed:t('최신 조회 실패','Latest check failed')};
  const policy=snapshot.policies.find(row=>row.mode!=='off');
  const running=snapshot.observedAt==null||snapshot.observationFailure?null:snapshot.external.filter(row=>row.herdrPane&&row.processState!=='exited').length;
  const managed=snapshot.managed.filter(row=>['starting','ready','working','waiting','stopping','restarting'].includes(row.state)).length;
  const tabs:readonly Tab[]=['overview','sessions','history','automation'];
  const titles={overview:t('개요','Overview'),sessions:t('세션','Sessions'),history:t('기록','History'),automation:t('자동화','Automation')};
  const stamp=(at:number|null|undefined)=>at==null?t('아직 없음','Not yet'):new Date(at).toLocaleString(localeFor(language));
  useEffect(()=>{
    if(!waiting)return;
    const planned=jobs.find(job=>job.stage==='ready'&&!waiting.includes(job.id));
    if(planned){setReview({job:planned,server:snapshot.serverInstance});setWaiting(null);}
  },[jobs,waiting,snapshot.serverInstance]);
  const plan=async()=>{
    if(blocked||busy.current)return;
    if(ready){setReview({job:ready,server:snapshot.serverInstance});return;}
    busy.current=true;setPending(true);setWaiting(jobs.map(job=>job.id));
    try{if(!await act({kind:'catalog-update-plan',catalogId:entry.id}))setWaiting(null);}
    finally{busy.current=false;setPending(false);}
  };
  const confirm=async()=>{
    if(!review||stale||blocked||busy.current)return;
    busy.current=true;setPending(true);
    try{if(await act({kind:'catalog-update-confirm',jobId:review.job.id,revision:review.job.revision,paneSessions:'keep'})){setReview(null);setTab('history');}}
    finally{busy.current=false;setPending(false);}
  };
  return <section className="cli-entry" data-catalog-id={entry.id}>
    <div className="cli-row">
      <div className="cli-identity"><h2 className="cli-heading"><AgentMark agent={entry.id} size={24}/>{entry.name}<Badge tone={status==='current'?'success':'neutral'}>{unsupported&&status==='unchecked'?labels.unsupported:labels[status]}</Badge></h2>
        <p className="cli-version">{entry.installed?.version??versionStatusLabel(entry.installed?.versionStatus,t)}{status==='available'&&check?.latestVersion&&<> <span>→ {check.latestVersion}</span></>}</p>
        <p className="muted">{t('설치된 버전','Installed version')}{(entry.installations?.length??0)>1&&` · ${entry.installations?.length} ${t('개 설치 위치','installation paths')}`}</p>
      </div>
      <div className="cli-actions">
        <Button data-action="catalog-check" disabled={blocked||entry.updateSupport?.kind==='unsupported'||status==='checking'} onClick={()=>void act({kind:'catalog-check',catalogId:entry.id})}>{t('최신 확인','Check latest')}</Button>
        {activeJob?<Button onClick={()=>setTab('history')}>{t('진행·결과 보기','View progress / result')}</Button>:(ready||status==='available')&&!unsupported&&<Button data-action="catalog-update-plan" tone="primary" disabled={blocked} onClick={()=>void plan()}>{ready?t('업데이트 검토','Review update'):t('업데이트 준비','Prepare update')}</Button>}
        <Button aria-expanded={tab!==null} aria-controls={id} onClick={()=>setTab(tab?null:'overview')}>{tab?t('상세 닫기','Close details'):t('상세 보기','Details')}</Button>
      </div>
      <dl className="cli-status">
        <div><dt>{t('실행 세션','Active sessions')}</dt><dd><Button className="status-link" onClick={()=>setTab('sessions')}>{t('herdr 창','herdr panes')} {running??'—'}{managed>0&&` · ${t('관리','Managed')} ${managed}`} →</Button></dd></div>
        <div><dt>{t('자동 업데이트','Automatic updates')}</dt><dd><Button className="status-link" onClick={()=>setTab('automation')}>{policy?t('켜짐','On'):unsupported?t('지원 안 됨','Unsupported'):t('꺼짐','Off')} →</Button></dd>{policy&&<dd>{t('다음 확인','Next check')}: {stamp(policy.nextCheckAt)}</dd>}</div>
        <div><dt>{t('최신 버전 조회','Latest version check')}</dt><dd>{stamp(check?.checkedAt)}</dd><dd>{check?.latestVersion??t('확인 전 / 확인 불가','Not checked / unavailable')}</dd></div>
      </dl>
    </div>
    {waiting&&<Notice>{t('설치 출처와 업데이트 대상을 확인 중입니다.','Checking installation source and update target.')}<Button onClick={()=>setWaiting(null)}>{t('닫기','Close')}</Button></Notice>}
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
          {!!entry.installations?.length?<CatalogInstallations entry={entry} snapshot={snapshot} act={act} disabled={disabled}/>:<p className="path">{entry.installed?.path}</p>}
          <a className="catalog-link" href={entry.sourceUrl} target="_blank" rel="noopener noreferrer">{t('공식 안내','Official guide')}</a>
        </>:tab==='sessions'?sessions:tab==='history'?history:automation}
      </div>
    </div>}
    {review&&<Dialog title={entry.name+' · '+t('업데이트 검토','Review update')} onClose={()=>setReview(null)}>
      <Notice>{t('선택한 설치만 업데이트합니다. 실행 중인 세션은 종료하거나 다시 시작하지 않습니다. 실행 시 배포처의 최신 버전을 받아 설치한 뒤 버전을 검증합니다.','Updates only this installation. Running sessions are not stopped or restarted. The latest release is fetched at execution and its installed version is verified.')}</Notice>
      <div className="removal-facts"><Facts items={[[t('설치된 버전','Installed version'),review.job.beforeVersion??t('미확인','Unknown')],[t('설치 방식','Installation method'),review.job.target.kind],[t('대상 실행 파일','Target executable'),<span className="path">{review.job.target.executable}</span>]]}/></div>
      {stale&&<Notice tone="warning">{t('설치 또는 계획이 바뀌었습니다. 닫고 다시 검토하세요.','The installation or plan changed. Close and review again.')}</Notice>}
      <div className="cluster"><Button onClick={()=>setReview(null)}>{t('취소','Cancel')}</Button><Button data-action="catalog-update-confirm" tone="primary" disabled={blocked||stale} onClick={()=>void confirm()}>{t('설치 업데이트 실행','Update installation')}</Button></div>
    </Dialog>}
  </section>;
}
