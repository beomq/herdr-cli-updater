import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AppOperation, AppSnapshot, ExternalSession } from '../src/app/types';
import { installationSnapshot, lastVerifiedUpdate, parseView, Surface } from './app';

test('saved tabs restore only supported navigation values',()=>{
  for(const value of ['dashboard','installations','sessions','operations','policies'] as const)expect(parseView(value)).toBe(value);
  for(const value of [null,'','removed','https://example.com'])expect(parseView(value)).toBe('dashboard');
});
test('internal engine metadata starts collapsed while the launched version remains visible',()=>{
  const snapshot:AppSnapshot={revision:1,service:'ready',failure:null,installations:[],external:[],operations:[],policies:[],managed:[{
    id:'session',installationId:'owned',cwd:'/example',generation:1,pid:123,state:'ready',
    launchedVersion:'launch-8.0.0',engineVersion:'engine-9.9.9',durableSessionId:'conversation',updatedAt:1,failure:null,output:[],approval:null,
  }]};
  const html=renderToStaticMarkup(createElement(Surface,{snapshot,view:'sessions',onView:()=>{},act:async()=>true,disabled:false}));
  const details=[...html.matchAll(/<details([^>]*)>([\s\S]*?)<\/details>/g)].find(match=>match[2]?.includes('engine-9.9.9'));
  if(!details)throw new Error('engine metadata is not inside details');
  expect(details[1]).not.toMatch(/\bopen\b/);
  const primary=html.replace(/<details[^>]*>[\s\S]*?<\/details>/g,'');
  expect(primary).not.toContain('engine-9.9.9');
  expect(primary).toContain('launch-8.0.0');
});
test('session versions show the disk value once and never substitute it for a missing running value',()=>{
  const snapshot:AppSnapshot={revision:1,service:'ready',failure:null,installations:[],managed:[],operations:[],policies:[],
    catalog:[{id:'omo',name:'OmO',description:{ko:'',en:''},executable:'omo',sourceUrl:'https://example.com',method:'npm',availability:'installable',reason:null,installed:{path:'/cli',version:'5.1.18',managed:false}}],
    external:[{id:'process',pid:123,family:'omo',origin:'herdr',installationId:null,catalogId:'omo',executable:'/cli',cwd:null,runningVersion:'5.1.10',diskPackage:{name:'omo-ai',version:'5.1.18',installedAt:0},control:'herdr-pane',herdrPane:{paneId:'w1:p1',status:'idle',stateChangeSeq:1}}]};
  const render=(state:AppSnapshot)=>renderToStaticMarkup(createElement(Surface,{snapshot:state,view:'sessions',onView:()=>{},act:async()=>true,disabled:false}));
  const markup=render(snapshot);
  expect(markup.match(/5\.1\.18/g)).toHaveLength(1);
  expect(markup.match(/5\.1\.10/g)).toHaveLength(1);
  const missing=render({...snapshot,external:snapshot.external.map(row=>({...row,runningVersion:null}))});
  expect(missing.match(/5\.1\.18/g)).toHaveLength(1);
  expect(missing).not.toContain('5.1.10');
});

const operation = (fields: Partial<AppOperation>): AppOperation => ({
  id:'update', requestId:'request', installationId:'owned', kind:'update',
  stage:'completed', revision:1, targetVersion:'2', beforeVersion:'1',
  installedVersion:'2', sessionIds:[], restart:false, createdAt:10,
  updatedAt:900, failure:null, detail:null, jobId:null, ...fields,
});

test('verified installation history uses installedAt independently from restart outcome', () => {
  expect(lastVerifiedUpdate([
    operation({installedAt:100, stage:'failed', restart:true}),
    operation({installedAt:200, stage:'restarting', updatedAt:1000}),
    operation({installedAt:300, installationId:'other'}),
    operation({installedAt:400, kind:'restart'}),
  ], 'owned')).toBe(200);
});

test('legacy and unverified records never substitute operation modification time', () => {
  expect(lastVerifiedUpdate([
    operation({}), operation({installedAt:null}),
  ], 'owned')).toBeNull();
});

test('installation details exclude same-family unlinked and other-installation observations', () => {
  const external = (id:string, installationId:string|null):ExternalSession => ({
    id, installationId, family:'omo', pid:200, executable:'/cli', cwd:null,
    runningVersion:null, control:'observation-only',
  });
  const snapshot:AppSnapshot = {
    revision:1, service:'ready', failure:null, installations:[], managed:[],
    external:[external('linked','owned'),external('unlinked',null),external('other','other')],
    operations:[operation({}),operation({installationId:'other'})],
    policies:[{installationId:'owned',mode:'check',intervalMinutes:60,lastCheckedAt:null,nextCheckAt:null,waitingReason:null},
      {installationId:'other',mode:'off',intervalMinutes:60,lastCheckedAt:null,nextCheckAt:null,waitingReason:null}],
  };
  const scoped=installationSnapshot(snapshot,'owned');
  expect(scoped.external.map(s=>s.id)).toEqual(['linked']);
  expect(scoped.operations.map(o=>o.installationId)).toEqual(['owned']);
  expect(scoped.policies.map(p=>p.installationId)).toEqual(['owned']);
  expect(snapshot.external).toHaveLength(3);
});

test('dashboard excludes unsupported catalog entries without performing actions',()=>{
  let calls=0;
  const snapshot:AppSnapshot={revision:1,service:'ready',failure:null,installations:[],external:[],managed:[],operations:[],policies:[],observedAt:1,
    catalog:[{id:'codex',name:'Codex',description:{ko:'',en:''},executable:'codex',sourceUrl:'https://example.test',method:'npm',availability:'installable',reason:null,installed:{path:'/codex',version:'3.2.1',managed:false}},
      {id:'grok',name:'Grok',description:{ko:'',en:''},executable:'grok',sourceUrl:'https://example.test',method:'script',availability:'installable',reason:null,installed:{path:'/grok',version:'1.2.3',managed:false},updateSupport:{kind:'unsupported',reason:'update_source_unverified'}}]};
  const html=renderToStaticMarkup(createElement(Surface,{snapshot,view:'dashboard',onView:()=>{},act:async()=>{calls++;return true;},disabled:false}));
  expect(calls).toBe(0);
  expect(html.match(/data-catalog-id="[^"]+"/g)).toEqual(['data-catalog-id="codex"']);
  const checks=[...html.matchAll(/<button[^>]*data-action="catalog-check"[^>]*>/g)].map(match=>match[0]);
  expect(checks).toHaveLength(1);expect(checks[0]).not.toContain('disabled');
  expect(html).toContain('3.2.1');expect(html).not.toContain('1.2.3');
});

test('unsupported herdr sessions remain visible without actionable buttons',()=>{
  const snapshot:AppSnapshot={revision:1,service:'ready',failure:null,installations:[],managed:[],operations:[],policies:[],external:[{
    id:'unsupported',pid:123,installationId:null,catalogId:'grok',executable:'/bin/grok',cwd:'/project/unsupported-session',runningVersion:null,
    control:'observation-only',herdrPane:{paneId:'w1:p1',status:'idle',stateChangeSeq:1},
  }]};
  const html=renderToStaticMarkup(createElement(Surface,{snapshot,view:'sessions',onView:()=>{},act:async()=>true,disabled:false}));
  const card=html.match(/<section class="panel">(?:(?!<\/section>)[\s\S])*unsupported-session[\s\S]*?<\/section>/)?.[0];
  expect(card).toBeDefined();
  expect(card).toContain('/bin/grok');
  expect(card).not.toContain('<button');
});
