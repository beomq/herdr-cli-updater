// Isolated interactive regression fixture. Never imported by the product entry.
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { AppCommand, AppSnapshot } from '../src/app/types';
import type { Installation, TargetSelection } from '../src/protocol';
import { Surface } from './app';
import type { View } from './app';
import { LanguageProvider } from './i18n';
import './styles.css';

const installation:Installation={installationId:'owned',family:'codex',channel:'latest',executableRealpath:'/fixture/codex',resources:[],resourcesFingerprint:'fp',owner:{kind:'package',manager:'npm',packageName:'@openai/codex',prefix:'/fixture'},installedVersion:{kind:'known',version:'2'},lastCheck:null};
const target:TargetSelection={targetId:'native',runtimeId:'runtime',installationId:'owned',expectedBinding:{socketId:'socket',socketEpoch:'epoch',paneId:'native-pane',paneGeneration:1,rootIncarnation:{pid:123,startIdentity:'start',executableRealpath:'/fixture/codex'},session:{kind:'conversation',fullId:'conversation-A',storagePathHash:'storage'},cwd:'/fixture',optionsRef:'options',turnGeneration:1,resourcesFingerprint:'fp'}};
const capability={kind:'supported',reason:'verified',evidenceRef:'fixture'} as const;
export const reviewSnapshot:AppSnapshot={serverInstance:'server-A',revision:1,service:'ready',failure:null,installations:[installation],operations:[],policies:[],
  managed:[{id:'managed',installationId:'owned',cwd:'/fixture',generation:1,pid:123,state:'ready',launchedVersion:'1',engineVersion:null,durableSessionId:'conversation-A',updatedAt:0,failure:null,output:[],approval:null}],
  external:[{id:'pane',pid:124,family:'codex',installationId:'owned',executable:'/fixture/codex',cwd:'/fixture',runningVersion:'1',processState:'observed',control:'herdr-pane',herdrPane:{paneId:'pane-A',status:'idle',stateChangeSeq:1},conversation:{id:'conversation-A',title:'pane',path:'/fixture/conversation'}}],
  native:{jobs:[],failure:null,selections:[{installation,update:{kind:'unsupported',reason:'not_verified'},readiness:capability,targets:[{target,runningVersion:{kind:'known',version:'1'},readiness:capability,completion:capability,gracefulExit:capability,resume:capability}]}]},
  catalog:[{id:'codex',name:'Codex',description:{ko:'',en:''},executable:'codex',sourceUrl:'https://example.test',method:'npm',availability:'installable',reason:null,selectedInstallationId:'catalog-owned',installed:{path:'/fixture/codex',version:'2',managed:false}}],
  catalogUpdates:[{id:'job',requestId:'fixture',catalogId:'codex',installationId:'catalog-owned',revision:1,stage:'uncertain',target:{kind:'owned',target:'/fixture',executable:'/fixture/codex',fingerprint:'fp',preserve:[]},createdAt:0,updatedAt:0,beforeVersion:'1',installedVersion:null,failure:null}],
};
declare global {interface Window {reviewCommands:AppCommand[]; reviewChange:(change:'server'|'conversation'|'activity'|'both'|'disabled')=>void; reviewReady:boolean}}
window.reviewCommands=[];
function Fixture(){
  const [snapshot,setSnapshot]=useState(reviewSnapshot);
  const [disabled,setDisabled]=useState(new URLSearchParams(location.search).has('disabled'));
  const [view,setView]=useState<View>(new URLSearchParams(location.search).has('history')?'history':'sessions');
  useEffect(()=>{window.reviewReady=true;window.dispatchEvent(new Event('review-render'));});
  window.reviewChange=change=>{
    if(change==='disabled'){setDisabled(true);return;}
    setSnapshot(previous=>({...previous,...(change==='server'?{serverInstance:'server-B'}:{}),managed:previous.managed.map(session=>({...session,...(change==='conversation'||change==='both'?{durableSessionId:'conversation-B'}:{}),...(change==='activity'||change==='both'?{state:'waiting' as const}:{})}))}));
  };
  return <Surface snapshot={snapshot} view={view} onView={setView} disabled={disabled} act={async command=>{window.reviewCommands.push(command);return false;}}/>;
}
const root=document.getElementById('root');
if(!root)throw new DOMException('Missing fixture root');
createRoot(root).render(<LanguageProvider><Fixture/></LanguageProvider>);
