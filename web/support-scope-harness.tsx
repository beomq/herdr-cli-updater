// Test-only surface: no service connection or real CLI actions.
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { AppSnapshot } from '../src/app/types';
import { catalogDefinitions } from '../src/app/catalog-registry';
import { Surface, parseView } from './app';
import { LanguageProvider } from './i18n';
import './styles.css';

const snapshot:AppSnapshot={revision:1,service:'ready',failure:null,observedAt:1,
  installations:[],managed:[],operations:[],policies:[],
  catalog:catalogDefinitions.map(row=>({...row,availability:'installable',installed:null})),
  external:[
    {id:'supported',pid:100,family:'omo',catalogId:'omo',installationId:null,executable:'/example/omo',cwd:'/example/supported-omo',runningVersion:'5.1.32',control:'herdr-pane',herdrPane:{paneId:'w1:p1',status:'idle',stateChangeSeq:1}},
    {id:'unsupported',pid:101,catalogId:'grok',installationId:null,executable:'/example/grok',cwd:'/example/unsupported-grok',runningVersion:null,control:'observation-only',herdrPane:{paneId:'w1:p2',status:'working',stateChangeSeq:1}},
  ],
};
function Harness(){
  const [view,setView]=useState(parseView(new URLSearchParams(location.search).get('view')));
  return <Surface snapshot={snapshot} view={view} onView={setView} act={async()=>false} disabled={false}/>;
}
const root=document.getElementById('root');
if(!root)throw new DOMException('Missing harness root','InvalidStateError');
createRoot(root).render(<LanguageProvider><Harness/></LanguageProvider>);
