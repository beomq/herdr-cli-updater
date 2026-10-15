import type { PaneSessionPolicy } from '../src/app/types';
import { useLanguage } from './i18n';

export const paneSessionLabels=(t:(ko:string,en:string)=>string):Record<PaneSessionPolicy,[string,string]>=>({
  'keep':[t('업데이트만','Update only'),t('세션은 그대로 둡니다. 새 버전은 각 세션을 직접 다시 시작할 때 적용됩니다.','Sessions are left alone; the new version applies when you restart each one yourself.')],
  'restart-idle':[t('대기 중 세션만 다시 시작','Restart idle sessions only'),t('업데이트 직후 대기 중인 herdr 창 세션을 같은 대화로 다시 시작합니다. 작업 중인 세션은 건드리지 않습니다.','Right after the update, idle herdr-pane sessions are restarted in the same conversation. Working sessions are left alone.')],
  'restart-all':[t('모두 다시 시작 (작업 끝나면)','Restart all (after work finishes)'),t('대기 중 세션은 바로, 작업 중 세션은 끝날 때까지 기다렸다가 다시 시작합니다. 30분 안에 안 끝나면 그대로 둡니다.','Idle sessions restart now; working sessions restart once they finish. Sessions still working after 30 minutes are left alone.')],
});
export function PaneSessionChoice({value,disabled,onChange,compact,name='pane-sessions'}:{value:PaneSessionPolicy;disabled:boolean;onChange:(value:PaneSessionPolicy)=>void;compact?:boolean;name?:string}){
  const {t}=useLanguage();const labels=paneSessionLabels(t);
  return <fieldset className="stack"><legend>{t('업데이트 후 herdr 창 세션','herdr-pane sessions after update')}</legend>
    {(Object.keys(labels) as PaneSessionPolicy[]).map(key=><label className="check" key={key}><input type="radio" name={name} checked={value===key} disabled={disabled} onChange={()=>onChange(key)}/><span><strong>{labels[key][0]}</strong>{!compact&&<> · <span className="muted">{labels[key][1]}</span></>}</span></label>)}
    <p className="muted">{t('응답을 기다리는 세션은 어떤 선택에서도 건드리지 않습니다. 강제 종료는 하지 않습니다.','Sessions waiting for your answer are never touched. Nothing is force-killed.')}</p>
  </fieldset>;
}
