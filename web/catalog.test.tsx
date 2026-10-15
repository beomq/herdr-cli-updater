import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AppSnapshot } from '../src/app/types';
import type { CatalogEntry, InstallJob } from '../src/app/catalog-types';
import { Catalog, installReviewIsStale } from './catalog';

const entry:CatalogEntry={id:'omo',name:'OmO',description:{ko:'CLI',en:'CLI'},executable:'omo',sourceUrl:'https://example.com/guide',method:'npm',availability:'installable',reason:null,inventoryStatus:'ready',selectedInstallationId:null,installed:null,installMethods:[{method:'npm',label:'npm global',sourceUrl:'https://example.com/guide',recommended:true},{method:'bun',label:'Bun global',sourceUrl:'https://example.com/guide',recommended:false}]};
const snapshot:AppSnapshot={revision:1,serverInstance:'server',service:'ready',failure:null,installations:[],managed:[],external:[],operations:[],policies:[],catalog:[entry]};
const job:InstallJob={id:'job',requestId:'request',catalogId:'omo',revision:1,stage:'ready',sourceUrl:entry.sourceUrl,method:'npm',target:'/usr/local',recipeHash:'hash',createdAt:0,updatedAt:0,installedVersion:null,executablePath:null,failure:null,log:[],makeDefault:false,previousInstallationId:null,official:{catalogId:'omo',method:'npm',sourceUrl:entry.sourceUrl,target:'/usr/local',executable:'/usr/local/bin/omo',manager:'/usr/local/bin/npm',args:['install','--global','omo-ai'],env:{},recipeHash:'a'.repeat(64)}};
const render=(model:AppSnapshot=snapshot)=>renderToStaticMarkup(<Catalog snapshot={model} act={async()=>true} disabled={false}/>);

test('catalog details do not expand inside the grid or reveal installation paths by default',()=>{
  const model:AppSnapshot={...snapshot,catalog:[{...entry,id:'agy',name:'Antigravity CLI',installMethods:[],installed:{path:'/private/example/bin/agy',version:'1.2.12',managed:false}},{...entry,id:'amp',name:'Amp',installMethods:[]}]};
  const markup=render(model);
  expect((markup.match(/data-action="catalog-manage"/g)??[])).toHaveLength(1);
  expect((markup.match(/class="button secondary catalog-detail-trigger"/g)??[])).toHaveLength(1);
  expect(markup).not.toContain('<details');
  expect(markup).not.toContain('/private/example/bin/agy');
  expect(markup).toContain('1.2.12');
});

test('existing installations lead with management, not another installation',()=>{
  const markup=render({...snapshot,catalog:[{...entry,installed:{path:'/existing/omo',version:'1.0.0',managed:true}}],policies:[{installationId:'catalog:omo',mode:'update',intervalMinutes:60,lastCheckedAt:null,nextCheckAt:null,waitingReason:null}]});
  expect(markup).not.toContain('data-action="install-methods"');
  expect(markup.match(/<button[^>]*data-action="catalog-manage"[^>]*>/)?.[0]).not.toContain('disabled');
  expect(markup).not.toContain('data-action="install-confirm"');
});

test('catalog cards do not expose removal or terminal controls',()=>{
  const markup=render({...snapshot,catalog:[{...entry,installed:{path:'/existing/omo',version:'1.0.0',managed:false},installations:[{id:'bun',catalogId:'omo',manager:'bun',root:'/existing',packageName:'omo-ai',path:'/existing/omo',identityPath:'/existing/omo',receiptId:null,isDefault:true,version:'1.0.0'}]}]});
  expect(markup).not.toContain('data-removal-installation');
  expect(markup).not.toContain('data-action="default-plan"');
  expect(markup).not.toContain('data-action="catalog-select"');
});

test('missing or empty official methods offer a guide rather than an install action',()=>{
  const {installMethods: omitted,...withoutMethods}=entry;
  for(const row of [withoutMethods,{...entry,installMethods:[]}]){
    const markup=render({...snapshot,catalog:[row]});
    expect(markup).not.toContain('data-action="install-methods"');
    expect(markup).toContain(`href="${entry.sourceUrl}"`);
  }
});

test('old stored ready plans cannot be reviewed or confirmed',()=>{
  const {official: omitted,...legacy}=job;
  const markup=render({...snapshot,installJobs:[legacy]});
  expect(markup).not.toContain('data-action="install-review"');
  expect(markup).not.toContain('data-action="install-confirm"');
  expect(installReviewIsStale({...snapshot,installJobs:[job]}, legacy, 'server')).toBe(true);
});

test('official failures expose inspection but never archive',()=>{
  const markup=render({...snapshot,installJobs:[{...job,stage:'failed',failure:'installed_version_unverified'}]});
  expect(markup).toContain('data-action="install-inspect"');
  expect(markup).not.toContain('data-action="install-archive"');
  const {official: omitted,...legacy}=job;
  expect(render({...snapshot,installJobs:[{...legacy,stage:'failed'}]})).toContain('data-action="install-archive"');
});

test('official review binds server, revision, plan, default and previous target',()=>{
  const model={...snapshot,installJobs:[job]};
  expect(installReviewIsStale(model,job,'server')).toBe(false);
  expect(installReviewIsStale(model,job,'old-server')).toBe(true);
  expect(installReviewIsStale({...model,service:'unavailable'},job,'server')).toBe(true);
  expect(installReviewIsStale({...model,installJobs:[]},job,'server')).toBe(true);
  for(const changed of [{...job,revision:2},{...job,stage:'completed' as const},{...job,makeDefault:true},{...job,previousInstallationId:'changed'},{...job,official:{...job.official!,executable:'/changed/omo'}}]){
    expect(installReviewIsStale({...model,installJobs:[changed]},job,'server')).toBe(true);
  }
  expect(installReviewIsStale({...model,catalog:[{...entry,selectedInstallationId:'changed'}]},job,'server')).toBe(true);
  expect(installReviewIsStale({...model,installJobs:[job,{...job,id:'other',stage:'uncertain'}]},job,'server')).toBe(true);
  const oldCombined={...job,makeDefault:true};
  expect(installReviewIsStale({...model,installJobs:[oldCombined]},oldCombined,'server')).toBe(true);
});
