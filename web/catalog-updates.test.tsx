import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AppSnapshot } from '../src/app/types';
import { CatalogUpdateHistory, CatalogUpdateReviewFacts, CatalogUpdates, catalogHistory, catalogRecoveryBlock, catalogReviewBinding, catalogUpdateTargetMatches, usesCatalogUpdatePolicy } from './catalog-updates';
import type { CatalogUpdateJob } from '../src/app/catalog-updates';

const snapshot: AppSnapshot = {
  revision: 1, service: 'ready', failure: null, installations: [], managed: [], external: [], operations: [], policies: [],
  catalog: [{ id: 'omo', name: 'OmO', description: { ko: 'CLI', en: 'CLI' }, executable: 'omo', sourceUrl: 'https://example.com', method: 'npm', availability: 'installable', reason: null, installed: { path: '/example/bin/omo', version: '1.2.3', managed: false } }],
};

test('initial catalog update rendering performs no actions', () => {
  let calls = 0;
  const markup=renderToStaticMarkup(<CatalogUpdates snapshot={snapshot} act={async () => { calls++; return true; }} disabled={false} />);
  expect(calls).toBe(0);
  expect(markup).not.toContain('aria-haspopup="dialog"');
  expect(markup).not.toContain('role="combobox"');
});
test('automation links to catalog details without duplicating installation controls',()=>{
  const entry=snapshot.catalog?.[0];if(!entry)throw new Error('missing fixture');
  const model={...snapshot,catalog:[{...entry,selectedInstallationId:'bun',installations:[{id:'bun',catalogId:'omo' as const,manager:'bun' as const,root:'/example',packageName:'omo-ai',path:'/example/bin/omo',identityPath:'/example/bin/omo',receiptId:null,isDefault:true,version:'1.2.3'}]}]};
  const markup=renderToStaticMarkup(<CatalogUpdates snapshot={model} act={async()=>true} disabled={false} onOpenCatalog={()=>{}}/>);
  expect(markup).toContain('data-action="open-catalog-detail"');
  expect(markup).not.toContain('data-action="catalog-select"');
  expect(markup).not.toContain('data-action="default-plan"');
  expect(markup).not.toContain('data-removal-installation');
});
test('automation toggle reflects persisted policy rather than defaulting to enabled',()=>{
  const render=(model:AppSnapshot)=>renderToStaticMarkup(<CatalogUpdates snapshot={model} act={async()=>true} disabled={false}/>);
  expect(render(snapshot)).toMatch(/role="switch" aria-checked="false"/);
  expect(render({...snapshot,policies:[{installationId:'catalog:omo',mode:'update',intervalMinutes:1440,lastCheckedAt:null,nextCheckAt:1000,waitingReason:null}]}))
    .toMatch(/role="switch" aria-checked="true"/);
});
test('pane session policy radio reflects saved intent and defaults to keep for absent policies',()=>{
  const render=(model:AppSnapshot)=>renderToStaticMarkup(<CatalogUpdates snapshot={model} act={async()=>true} disabled={false}/>);
  const checkedIndex=(markup:string)=>[...markup.matchAll(/<input type="radio"[^>]*>/g)].findIndex(match=>match[0].includes('checked=""'));
  expect(checkedIndex(render(snapshot))).toBe(0);
  for(const [index,paneSessions] of (['keep','restart-idle','restart-all'] as const).entries())
    expect(checkedIndex(render({...snapshot,policies:[{installationId:'catalog:omo',mode:'update',intervalMinutes:60,paneSessions,lastCheckedAt:null,nextCheckAt:1000,waitingReason:null}]}))).toBe(index);
  const unsupported:AppSnapshot={...snapshot,catalog:snapshot.catalog?.map(entry=>({...entry,updateSupport:{kind:'unsupported',reason:'manual_update_required'}}))??[]};
  expect(render(unsupported)).not.toContain('업데이트 후 herdr 창 세션');
});
test('unsupported installations block enabling but retain an enabled shutdown toggle',()=>{
  const model:AppSnapshot={...snapshot,catalog:snapshot.catalog?.map(entry=>({...entry,updateSupport:{kind:'unsupported',reason:'manual_update_required'}}))??[]};
  const render=(value:AppSnapshot)=>renderToStaticMarkup(<CatalogUpdates snapshot={value} act={async()=>true} disabled={false}/>);
  expect(render(model)).toMatch(/role="switch"[^>]*disabled=""/);
  const enabled=render({...model,policies:[{installationId:'catalog:omo',mode:'update',intervalMinutes:1440,lastCheckedAt:null,nextCheckAt:1000,waitingReason:null}]});
  expect(enabled.match(/<button[^>]*role="switch"[^>]*>/)?.[0]).not.toContain('disabled');
});
test('a verified Bun shim alias uses catalog update policy instead of duplicating an unqualified core policy',()=>{
  const core={installationId:'core',family:'omo',channel:'unknown',executableRealpath:'/home/.bun/install/global/node_modules/omo-ai/bin/omo.js',resourcesFingerprint:'fingerprint',resources:[],owner:{kind:'unknown',reason:'unverified_owner'},installedVersion:{kind:'known',version:'5.1.18'},lastCheck:null} as const;
  const model:AppSnapshot={...snapshot,installations:[core],catalog:snapshot.catalog?.map(entry=>({...entry,installed:{path:'/home/.bun/bin/omo',identityPath:core.executableRealpath,source:'bun-global',version:'5.1.18',managed:false}}))??[]};
  expect(usesCatalogUpdatePolicy(model,core)).toBe(true);
  const markup=renderToStaticMarkup(<CatalogUpdates snapshot={model} act={async()=>true} disabled={false}/>);
  expect(markup.match(/<h3 class="cli-heading">/g)).toHaveLength(1);
  expect(markup).toContain(core.executableRealpath);
  expect(usesCatalogUpdatePolicy({...model,policies:[{installationId:'core',mode:'check',intervalMinutes:60,lastCheckedAt:null,nextCheckAt:null,waitingReason:null}]},core)).toBe(false);
});

test('catalog row is excluded when the core OmO executable path matches', () => {
  const core = { installationId: 'core', family: 'omo', channel: 'stable', executableRealpath: '/example/bin/omo', resourcesFingerprint: 'fingerprint', resources: [], owner: { kind: 'unknown', reason: 'unverified_owner' }, installedVersion: { kind: 'unknown', reason: 'not_captured' }, lastCheck: null } as const;
  const markup = renderToStaticMarkup(<CatalogUpdates snapshot={{ ...snapshot, installations: [core] }} act={async () => true} disabled={false} />);
  expect(markup).not.toContain('<h3 class="cli-heading">');
});

test('a different installed OmO executable remains available for catalog updates', () => {
  const core = { installationId: 'core', family: 'omo', channel: 'stable', executableRealpath: '/other/bin/omo', resourcesFingerprint: 'fingerprint', resources: [], owner: { kind: 'unknown', reason: 'unverified_owner' }, installedVersion: { kind: 'unknown', reason: 'not_captured' }, lastCheck: null } as const;
  const markup = renderToStaticMarkup(<CatalogUpdates snapshot={{ ...snapshot, installations: [core] }} act={async () => true} disabled={false} />);
  expect(markup).toContain('<h3 class="cli-heading">');
  expect(markup).toContain('/example/bin/omo');
});

test('uncertain jobs disable re-enabling automation', () => {
  const markup = renderToStaticMarkup(<CatalogUpdates snapshot={{ ...snapshot, catalogUpdates: [{ id: 'job', requestId: 'request', catalogId: 'omo', revision: 1, stage: 'uncertain', target: { kind: 'owned', target: '/example', executable: '/example/bin/omo', fingerprint: 'fingerprint', preserve: [] }, createdAt: 0, updatedAt: 0, beforeVersion: null, installedVersion: null, failure: null }] }} act={async () => true} disabled={false} />);
  expect(markup).toMatch(/role="switch"[^>]*disabled=""/);
});

test('unsupported installations remain visible with their enable toggle disabled', () => {
  const catalog = snapshot.catalog?.map(entry => ({ ...entry, updateSupport: { kind: 'unsupported', reason: 'self_update_only' } as const }));
  const markup = renderToStaticMarkup(<CatalogUpdates snapshot={{ ...snapshot, catalog: catalog ?? [] }} act={async () => true} disabled={false} />);
  expect(markup).toContain('/example/bin/omo');
  expect(markup).toMatch(/role="switch"[^>]*disabled=""/);
});

test('unsupported installations retain an enabled policy shutdown entry point', () => {
  const catalog = snapshot.catalog?.map(entry => ({ ...entry, updateSupport: { kind: 'unsupported', reason: 'update_source_unverified' } as const }));
  const markup = renderToStaticMarkup(<CatalogUpdates snapshot={{ ...snapshot, catalog: catalog ?? [], policies: [{ installationId: 'catalog:omo', mode: 'update', intervalMinutes: 1440, firstCheck: 'after-interval', lastCheckedAt: null, nextCheckAt: null, waitingReason: null }] }} act={async () => true} disabled={false} />);
  expect(markup.match(/<button[^>]*role="switch"[^>]*>/)?.[0]).not.toContain('disabled');
});
test('up-to-date checks do not appear as completed updates',()=>{
  const base={requestId:'request',catalogId:'omo' as const,revision:1,stage:'completed' as const,target:{kind:'owned' as const,target:'/example',executable:'/example/bin/omo',fingerprint:'fingerprint',preserve:[]},createdAt:0,updatedAt:0,failure:null};
  const markup=renderToStaticMarkup(<CatalogUpdates snapshot={{...snapshot,catalogUpdates:[
    {...base,id:'unchanged',beforeVersion:'1.1.1',installedVersion:'1.1.1'},
    {...base,id:'changed',beforeVersion:'2.2.2',installedVersion:'3.3.3'},
  ]}} act={async()=>true} disabled={false}/>);
  expect(markup).not.toContain('1.1.1');
  expect(markup).toContain('2.2.2');expect(markup).toContain('3.3.3');
});
test('prepared catalog updates remain visible in the history until confirmation',()=>{
  const job={id:'prepared',requestId:'request',catalogId:'omo' as const,revision:0,stage:'ready' as const,target:{kind:'owned' as const,target:'/example',executable:'/example/bin/omo',fingerprint:'fingerprint',preserve:[]},createdAt:0,updatedAt:0,beforeVersion:'1',installedVersion:null,failure:null};
  expect(catalogHistory({...snapshot,catalogUpdates:[job]}).map(row=>row.id)).toEqual(['prepared']);
});

const uncertain:CatalogUpdateJob={id:'recover',requestId:'request',catalogId:'omo',revision:7,stage:'uncertain',target:{kind:'owned',target:'/example',executable:'/example/bin/omo',fingerprint:'fingerprint',preserve:[]},createdAt:0,updatedAt:1,beforeVersion:'1.2.3',installedVersion:null,failure:'service_restarted',checkedVersion:'2.0.0'};
test('recovery requires the exact selected target and fresh inventory without submitting on render',()=>{
  const model={...snapshot,catalogUpdates:[uncertain]};
  expect(catalogRecoveryBlock(model,uncertain,'reconcile')).toBeNull();
  expect(catalogRecoveryBlock(model,uncertain,'archive-unverified')).toBe('reconcile_before_archive');
  expect(catalogRecoveryBlock({...model,service:'connecting'},uncertain,'reconcile')).toBe('service_unavailable');
  expect(catalogRecoveryBlock({...model,catalog:[]},uncertain,'reconcile')).toBe('recovery_target_changed');
  expect(catalogRecoveryBlock({...model,catalogUpdates:[uncertain,{...uncertain,id:'active',stage:'updating'}]},uncertain,'reconcile')).toBe('update_in_progress');
  let calls=0;
  const markup=renderToStaticMarkup(<CatalogUpdateHistory snapshot={model} act={async()=>{calls++;return true;}}/>);
  expect(calls).toBe(0);
  expect(markup).toContain('data-action="catalog-update-reconcile"');
  expect(markup.match(/<button[^>]*data-action="catalog-update-archive-unverified"[^>]*>/)?.[0]).toContain('disabled=""');
  expect(markup).not.toContain('data-action="catalog-update-recover-confirm"');
});
test('target bindings distinguish selection source and installed version changes',()=>{
  const entry=snapshot.catalog?.[0];if(!entry)throw new Error('missing fixture');
  expect(catalogUpdateTargetMatches(entry,uncertain)).toBe(true);
  for(const changed of [{...entry,selectedInstallationId:'other'},{...entry,inventoryStatus:'checking' as const},{...entry,installed:{path:'/other',version:'1.2.3',managed:false}}])expect(catalogUpdateTargetMatches(changed,uncertain)).toBe(false);
  for(const changed of [{...entry,sourceUrl:'https://different.test'},{...entry,installed:{...entry.installed,path:'/example/bin/omo',version:'2.0.0',managed:false}}])expect(catalogReviewBinding(changed)).not.toBe(catalogReviewBinding(entry));
});
test('archived unverified jobs retain a distinct non-success outcome without recovery actions',()=>{
  const markup=renderToStaticMarkup(<CatalogUpdateHistory snapshot={{...snapshot,catalogUpdates:[{...uncertain,stage:'archived-unverified'}]}} act={async()=>true}/>);
  expect(markup).toContain('data-update-stage="archived-unverified"');
  expect(markup).not.toContain('badge success');
  expect(markup).not.toContain('data-action="catalog-update-reconcile"');
});
test('review separates observed latest from executable target and unpinned release policy',()=>{
  const markup=renderToStaticMarkup(<CatalogUpdateReviewFacts job={uncertain} checkedAt={1000}/>);
  expect(markup).toContain('data-review="target">/example/bin/omo');
  expect(markup).toContain('data-review="installed">1.2.3');
  expect(markup).toContain('data-review="checked-latest">2.0.0');
  expect(markup).toContain('data-review="checked-at"');
  expect(markup).toContain('data-release-policy="then-latest"');
});
test('recovery review exposes action-specific evidence without installation execution policy',()=>{
  for(const action of ['reconcile','archive-unverified'] as const){
    const markup=renderToStaticMarkup(<CatalogUpdateReviewFacts job={uncertain} checkedAt={null} action={action}/>);
    expect(markup).toContain(`data-review-action="${action}"`);
    expect(markup).toContain('data-review="target">/example/bin/omo');
    expect(markup).toContain('data-review="checked-latest">2.0.0');
    expect(markup).not.toContain('data-release-policy=');
  }
  const install=renderToStaticMarkup(<CatalogUpdateReviewFacts job={uncertain} checkedAt={1000}/>);
  expect(install).toContain('data-review-action="install"');
  expect(install).toContain('data-release-policy="then-latest"');
});
