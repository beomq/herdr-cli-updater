import { useRef, useState } from 'react';
import type { AppCommand, AppSnapshot, PaneSessionPolicy } from '../src/app/types';
import { Button, Dialog, Notice } from './primitives';
import { PaneSessionChoice } from './pane-session-choice';
import { useLanguage } from './i18n';

/** Display scopes must never narrow the command guard. Ready reviews are not running work. */
export function workspaceBusy(snapshot:AppSnapshot):boolean {
  return !!snapshot.catalogBulk&&['checking','planning','updating'].includes(snapshot.catalogBulk.stage)
    ||!!snapshot.catalogUpdates?.some(job=>job.stage==='updating')
    ||!!snapshot.installJobs?.some(job=>['installing','verifying','uncertain'].includes(job.stage))
    ||!!snapshot.removalJobs?.some(job=>['removing','uncertain'].includes(job.stage))
    ||!!snapshot.defaultJobs?.some(job=>['applying','uncertain'].includes(job.stage))
    ||snapshot.operations.some(job=>!['ready','completed','failed','cancelled'].includes(job.stage));
}

export function AutomationToggle({name,installationId,enabled,act,disabled}:{readonly name:string;readonly installationId:string;readonly enabled:boolean;readonly act:(command:AppCommand)=>Promise<boolean>;readonly disabled:boolean}) {
  const {t}=useLanguage();
  const [pending,setPending]=useState(false);
  const busy=useRef(false);
  const toggle=async()=>{
    if(disabled||busy.current)return;
    busy.current=true;setPending(true);
    try{await act({kind:'automation',installationId,enabled:!enabled});}
    finally{busy.current=false;setPending(false);}
  };
  return <button type="button" role="switch" aria-checked={enabled} aria-label={name+' '+t('자동 업데이트','Automatic updates')} className="automation-switch" disabled={disabled||pending} onClick={()=>void toggle()}><span aria-hidden="true" className="switch-track"/>{pending?t('저장 중','Saving'):enabled?t('켜짐','On'):t('꺼짐','Off')}</button>;
}

export function AutomationSettings({snapshot,act,disabled}:{readonly snapshot:AppSnapshot;readonly act:(command:AppCommand)=>Promise<boolean>;readonly disabled:boolean}) {
  const {t}=useLanguage();
  const [review,setReview]=useState<{readonly value:PaneSessionPolicy;readonly server:string|undefined;readonly binding:string}|null>(null);
  const [pending,setPending]=useState(false);
  const busy=useRef(false);
  const settings=snapshot.automationSettings;
  const binding=JSON.stringify([settings,snapshot.policies.map(policy=>[policy.installationId,policy.paneSessions??'restart-idle'])]);
  const mixed=!!settings&&snapshot.policies.some(policy=>(policy.paneSessions??'restart-idle')!==settings.paneSessions);
  const blocked=disabled||snapshot.service!=='ready'||workspaceBusy(snapshot)||pending||!settings;
  const stale=!!review&&(review.server!==snapshot.serverInstance||review.binding!==binding);
  const save=async()=>{
    if(!review||blocked||stale||busy.current)return;
    busy.current=true;setPending(true);
    try{if(await act({kind:'automation-settings',paneSessions:review.value}))setReview(null);}
    finally{busy.current=false;setPending(false);}
  };
  return <>
    <Button data-action="automation-settings" aria-haspopup="dialog" disabled={!settings} onClick={()=>{if(settings)setReview({value:settings.paneSessions,server:snapshot.serverInstance,binding});}}>{t('자동 업데이트 설정','Automatic update settings')}</Button>
    {review&&<Dialog title={t('자동 업데이트 설정','Automatic update settings')} onClose={()=>setReview(null)}>
      <p>{t('저장하면 현재와 앞으로 추가할 모든 자동 업데이트 정책에 적용합니다. 자동화를 켜거나 실행 주기를 변경하지 않으며, 지금 세션을 재시작하지 않습니다.','Saving applies to all existing and future automatic update policies. It does not enable automation, change schedules or restart sessions now.')}</p>
      {mixed&&<Notice tone="warning"><span data-automation-mixed="true">{t('기존 정책 중 다른 세션 설정이 있습니다. 저장 전까지 각 정책의 기존 선택이 유지됩니다. 저장하면 아래 선택으로 통일합니다.','Some existing policies use different session settings. Their choices remain until you save; saving unifies them to the choice below.')}</span></Notice>}
      <PaneSessionChoice name="automatic-pane-sessions" value={review.value} disabled={blocked||stale} onChange={value=>setReview({...review,value})}/>
      {stale&&<Notice tone="warning">{t('설정 또는 서비스가 바뀌었습니다. 닫고 다시 검토하세요.','Settings or service changed. Close and review again.')}</Notice>}
      <Button data-action="automation-settings-save" tone="primary" disabled={blocked||stale} onClick={()=>void save()}>{t('모든 자동 업데이트에 저장','Save for all automatic updates')}</Button>
    </Dialog>}
  </>;
}
