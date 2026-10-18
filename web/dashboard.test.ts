import { expect, test } from 'bun:test';
import type { Installation } from '../src/protocol';
import type { AppOperation, AppSnapshot, ExternalSession } from '../src/app/types';
import { catalogSnapshot, dashboardAction, dashboardSummary, installedCatalog, observationGroups, outdatedSessions, supportedSnapshot } from './dashboard';
import type { CatalogEntry } from '../src/app/catalog-types';

const installation:Installation={installationId:'omo-a',family:'omo',channel:'stable',executableRealpath:'/omo/bin/omo.js',resourcesFingerprint:'fingerprint',resources:[],owner:{kind:'package',manager:'bun',packageName:'omo-ai',prefix:'/omo'},installedVersion:{kind:'known',version:'1'},lastCheck:{checkedAt:10,result:{kind:'update-available',installedVersion:'1',availableVersion:'2',checkedAt:10}}};
const operation=(stage:AppOperation['stage'],id='omo-a'):AppOperation=>({id:'op',requestId:'r',installationId:id,kind:'prepare',stage,revision:1,targetVersion:'2',beforeVersion:'1',installedVersion:null,sessionIds:[],restart:false,createdAt:10,updatedAt:10,failure:null,detail:null,jobId:null});
const external=(id:string,fields:Partial<ExternalSession>={}):ExternalSession=>({id,pid:2,family:'codex',installationId:null,executable:'/codex',cwd:null,runningVersion:null,control:'observation-only',...fields});
const snapshot:AppSnapshot={revision:1,service:'ready',failure:null,installations:[installation],managed:[],external:[],operations:[],policies:[]};

test('dashboard actions prefer inspection and existing operations over new preparation',()=>{
  expect(dashboardAction(installation,[])).toBe('prepare');
  expect(dashboardAction({...installation,lastCheck:null},[])).toBe('check');
  expect(dashboardAction({...installation,owner:{kind:'unknown',reason:'unverified_owner'}},[])).toBe('support');
  expect(dashboardAction(installation,[operation('ready')])).toBe('review');
  expect(dashboardAction(installation,[operation('preparing'),operation('ready')])).toBe('progress');
  expect(dashboardAction(installation,[operation('ready'),operation('uncertain')])).toBe('inspect');
  expect(dashboardAction(installation,[operation('ready','another')])).toBe('prepare');
  for(const stage of ['completed','failed','cancelled'] as const)expect(dashboardAction(installation,[operation(stage)])).toBe('prepare');
});

test('outdated sessions are herdr panes whose recorded running version differs from the version now on disk',()=>{
  const pane=(id:string,fields:Partial<ExternalSession>={})=>external(id,{family:'omo',herdrPane:{paneId:'w1:'+id,status:'idle',stateChangeSeq:1},processState:'observed',runningVersion:'1',runningVersionEvidence:'launch-environment',diskPackage:{name:'omo-ai',version:'2',installedAt:1},...fields});
  const model={...snapshot,observedAt:10,external:[
    pane('old'),
    pane('current',{runningVersion:'2'}),
    pane('inferred',{runningVersionEvidence:'started-before-install'}),
    pane('unknown-running',{runningVersion:null}),
    pane('no-disk',{diskPackage:null,installationId:null}),
    pane('linked',{diskPackage:null,installationId:'omo-a',runningVersion:'0.9'}),
    pane('exited',{processState:'exited'}),
    external('outside',{runningVersion:'1',diskPackage:{name:'codex',version:'2',installedAt:1}}),
  ]};
  expect(outdatedSessions(model).map(s=>s.id)).toEqual(['old','linked']);
  expect(dashboardSummary(model).outdated).toBe(2);
  expect(dashboardSummary({...model,observationFailure:'failed'}).outdated).toBeNull();
  expect(dashboardSummary(snapshot).outdated).toBeNull();
});

test('missing or failed observations never report zero active sessions',()=>{
  expect(dashboardSummary(snapshot).sessions).toBeNull();
  expect(dashboardSummary({...snapshot,observedAt:10}).sessions).toBe(0);
  expect(dashboardSummary({...snapshot,observedAt:10,observationFailure:'failed'}).sessions).toBeNull();
  // Sessions outside herdr are observed but not managed, so they do not count.
  expect(dashboardSummary({...snapshot,observedAt:10,external:[external('one')]}).sessions).toBe(0);
  expect(dashboardSummary({...snapshot,observedAt:10,external:[external('one',{herdrPane:{paneId:'w1:p1',status:'idle',stateChangeSeq:1}}),external('two')]}).sessions).toBe(1);
  expect(dashboardSummary({...snapshot,installations:[{...installation,lastCheck:null}]})).toMatchObject({updates:0,unchecked:1});
});

test('observations group without equating display links to update authority',()=>{
  const grouped=observationGroups({...snapshot,external:[external('a',{catalogId:'codex'}),external('b'),external('managed-link',{installationId:'omo-a'})],catalog:[{id:'codex',name:'Codex',description:{ko:'CLI',en:'CLI'},executable:'codex',sourceUrl:'https://example.test',method:'npm',availability:'installable',reason:null,installed:{path:'/codex',version:'1',managed:false}}]});
  expect(grouped).toEqual([{family:'codex',count:2,catalogLinked:1,unlinked:1}]);
  expect(observationGroups({...snapshot,external:[external('missing',{catalogId:'codex'})]})).toEqual([{family:'codex',count:1,catalogLinked:0,unlinked:1}]);
});

const catalogEntry=(id:CatalogEntry['id'],path:string):CatalogEntry=>({id,name:id,description:{ko:'',en:''},executable:id,sourceUrl:'https://example.test',method:'npm',availability:'installable',reason:null,installed:{path,version:'1.0.0',managed:false}});
test('dashboard counts installed catalog entries without running sessions or duplicate engine rows',()=>{
  const model:AppSnapshot={...snapshot,catalog:[
    {...catalogEntry('omo','/omo/bin/omo.js'),lastCheck:{status:'available',latestVersion:'2.0.0',checkedAt:10,failure:null}},
    {...catalogEntry('grok','/grok'),updateSupport:{kind:'unsupported',reason:'update_source_unverified'}},
    {...catalogEntry('codex','/codex'),installed:null,installations:[{id:'copy',catalogId:'codex',manager:'npm',root:'/copy',path:'/copy/codex',identityPath:'/copy/codex',packageName:'@openai/codex',version:'1',isDefault:false,receiptId:null}]},
    {...catalogEntry('kimi','/kimi'),installed:null},
  ],observedAt:10};
  expect(installedCatalog(model).map(entry=>entry.id)).toEqual(['omo','codex']);
  expect(dashboardSummary(model)).toMatchObject({installed:2,updates:1,unchecked:1,sessions:0});
});
test('management scope removes unsupported installations and policies but retains session observations',()=>{
  const model:AppSnapshot={...snapshot,installations:[installation,{...installation,installationId:'grok',family:'grok'}],
    catalog:[catalogEntry('omo','/omo'),catalogEntry('grok','/grok')],
    policies:[{installationId:'catalog:grok',mode:'update',intervalMinutes:60,lastCheckedAt:null,nextCheckAt:10,waitingReason:null}],
    external:[external('grok',{catalogId:'grok'})]};
  const scoped=supportedSnapshot(model);
  expect(scoped.installations.map(row=>row.family)).toEqual(['omo']);
  expect(scoped.catalog?.map(row=>row.id)).toEqual(['omo']);
  expect(scoped.policies).toEqual([]);
  expect(scoped.external).toBe(model.external);
});
test('catalog detail scopes policies and history and preserves all same-family pane observations',()=>{
  const entry=catalogEntry('codex','/codex');
  const model:AppSnapshot={...snapshot,catalog:[entry],external:[external('codex'),external('omo',{family:'omo'})],
    policies:[{installationId:'catalog:codex',mode:'off',intervalMinutes:60,lastCheckedAt:null,nextCheckAt:null,waitingReason:null},
      {installationId:'catalog:omo',mode:'off',intervalMinutes:60,lastCheckedAt:null,nextCheckAt:null,waitingReason:null}]};
  const scoped=catalogSnapshot(model,entry);
  expect(scoped.catalog).toEqual([entry]);
  expect(scoped.external.map(session=>session.id)).toEqual(['codex']);
  expect(scoped.policies.map(policy=>policy.installationId)).toEqual(['catalog:codex']);
  expect(scoped.installations).toEqual([]);
});
