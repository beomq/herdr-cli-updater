import { expect,test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AppSnapshot } from '../src/app/types';
import type { CatalogBulk } from '../src/app/catalog-bulk';
import { CatalogBulkActions } from './catalog-bulk';

const snapshot:AppSnapshot={revision:1,serverInstance:'server-a',service:'ready',failure:null,installations:[],managed:[],external:[],operations:[],policies:[],catalog:[{
  id:'omo',name:'OmO',description:{ko:'',en:''},executable:'omo',sourceUrl:'https://example.test',method:'npm',availability:'installable',reason:null,
  installed:{path:'/example/omo',version:'1.0.0',managed:false},
}]};
const item:CatalogBulk['items'][number]={catalogId:'omo',name:'OmO',beforeVersion:'1.0.0',latestVersion:'2.0.0',status:'ready',reason:null,jobId:'job',jobRevision:1};
const batch:CatalogBulk={id:'batch',revision:4,stage:'ready',items:[item]};
const render=(model:AppSnapshot=snapshot,disabled=false)=>renderToStaticMarkup(<CatalogBulkActions snapshot={model} disabled={disabled} act={async()=>true}/>);
const action=(markup:string,name:string)=>markup.match(new RegExp(`<button[^>]*data-action="${name}"[^>]*>`))?.[0];

test('initial rendering exposes both whole-catalog commands and sends nothing',()=>{
  let calls=0;
  const markup=renderToStaticMarkup(<CatalogBulkActions snapshot={snapshot} disabled={false} act={async()=>{calls++;return true;}}/>);
  expect(calls).toBe(0);
  expect(markup).toContain('data-bulk-stage="idle"');
  expect(action(markup,'catalog-check-all')).not.toContain('disabled');
  expect(action(markup,'catalog-update-all-plan')).not.toContain('disabled');
  expect(action(markup,'catalog-update-all-confirm')).toBeUndefined();
});
test('external disabled state blocks both commands',()=>{
  const markup=render(snapshot,true);
  expect(action(markup,'catalog-check-all')).toContain('disabled=""');
  expect(action(markup,'catalog-update-all-plan')).toContain('disabled=""');
});
test('empty installed catalog and disconnected service block requests',()=>{
  for(const model of [{...snapshot,catalog:[]},{...snapshot,service:'connecting' as const},{...snapshot,service:'unavailable' as const}]){
    const markup=render(model);
    expect(action(markup,'catalog-check-all')).toContain('disabled=""');
    expect(action(markup,'catalog-update-all-plan')).toContain('disabled=""');
  }
});
test('active machine stages block new requests and preserve batch identity',()=>{
  for(const stage of ['checking','planning','updating'] as const){
    const markup=render({...snapshot,catalogBulk:{...batch,stage}});
    expect(markup).toContain(`data-bulk-stage="${stage}"`);
    expect(markup).toContain('data-bulk-id="batch" data-bulk-revision="4"');
    expect(action(markup,'catalog-check-all')).toContain('disabled=""');
    expect(action(markup,'catalog-update-all-plan')).toContain('disabled=""');
  }
});
test('reloaded ready batch exposes review but neither opens nor submits confirmation',()=>{
  let calls=0;
  const markup=renderToStaticMarkup(<CatalogBulkActions snapshot={{...snapshot,catalogBulk:batch}} disabled={false} act={async()=>{calls++;return true;}}/>);
  expect(calls).toBe(0);
  expect(action(markup,'catalog-bulk-review')).toContain('aria-haspopup="dialog"');
  expect(action(markup,'catalog-update-all-confirm')).toBeUndefined();
  expect(markup).not.toContain('<dialog');
  expect(markup).toContain('data-bulk-status="ready"');
});
test('every row machine status and exclusion reason is retained outside a dialog',()=>{
  for(const status of ['checking','available','current','ahead','unknown','unsupported','failed','ready','updating','completed','skipped','uncertain'] as const){
    const markup=render({...snapshot,catalogBulk:{...batch,stage:'completed',items:[{...item,status,reason:'service_restarted'}]}});
    expect(markup).toContain(`data-bulk-catalog-id="omo" data-bulk-status="${status}" data-bulk-reason="service_restarted"`);
    expect(markup).not.toContain('<dialog');
  }
});
test('results preserve checked versions without relying on the displayed catalog',()=>{
  const markup=render({...snapshot,catalog:[],catalogBulk:{...batch,stage:'completed',items:[{...item,status:'completed'}]}});
  expect(markup).toContain('data-version="installed">1.0.0');
  expect(markup).toContain('data-version="checked-latest">2.0.0');
  expect(markup).toContain('data-bulk-catalog-id="omo"');
});
test('unknown versions remain distinct from observed empty values',()=>{
  const markup=render({...snapshot,catalogBulk:{...batch,stage:'completed',items:[{...item,status:'unknown',beforeVersion:null,latestVersion:null}]}});
  expect(markup).toContain('data-bulk-status="unknown"');
  expect(markup).not.toContain('data-version="installed">0');
  expect(markup).not.toContain('data-version="checked-latest">0');
});
test('partial bulk results expose per-job recovery without replaying completed items',()=>{
  const job={id:'job',requestId:'request',catalogId:'omo' as const,revision:8,stage:'uncertain' as const,target:{kind:'owned' as const,target:'/example',executable:'/example/omo',fingerprint:'fingerprint',preserve:[]},createdAt:0,updatedAt:0,beforeVersion:'1.0.0',installedVersion:null,failure:'service_restarted'};
  let calls=0;
  const markup=renderToStaticMarkup(<CatalogBulkActions snapshot={{...snapshot,catalogUpdates:[job],catalogBulk:{...batch,stage:'completed',items:[{...item,status:'uncertain'},{...item,catalogId:'codex',name:'Codex',jobId:'completed',status:'completed'}]}}} disabled={false} act={async()=>{calls++;return true;}}/>);
  expect(calls).toBe(0);
  expect(markup).toContain('data-bulk-recovery=""');
  expect(markup).toContain('data-action="catalog-update-reconcile" data-job-id="job"');
  expect(markup).not.toContain('data-job-id="completed"');
  expect(markup).not.toContain('data-action="catalog-update-all-confirm"');
});
test('partial bulk recovery retains active jobs outside displayed batch members',()=>{
  const job={id:'job',requestId:'request',catalogId:'omo' as const,revision:8,stage:'uncertain' as const,target:{kind:'owned' as const,target:'/example',executable:'/example/omo',fingerprint:'fingerprint',preserve:[]},createdAt:0,updatedAt:0,beforeVersion:'1.0.0',installedVersion:null,failure:'service_restarted'};
  const markup=render({...snapshot,catalogUpdates:[job,{...job,id:'outside-active',catalogId:'codex',stage:'updating'}],catalogBulk:{...batch,stage:'completed',items:[{...item,status:'uncertain'}]}});
  const trigger=action(markup,'catalog-update-reconcile');
  expect(trigger).toBeDefined();
  expect(trigger).toContain('disabled=""');
  expect(trigger).toContain('data-reason="update_in_progress"');
  expect(markup).not.toContain('data-update-job="outside-active"');
});
