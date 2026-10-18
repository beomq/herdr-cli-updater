import { expect,test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AppSnapshot } from '../src/app/types';
import type { CatalogBulk } from '../src/app/catalog-bulk';
import { CatalogBulkActions } from './catalog-bulk';

const snapshot:AppSnapshot={revision:1,serverInstance:'server-a',service:'ready',failure:null,installations:[],managed:[],external:[],operations:[],policies:[],catalog:[{
  id:'omo',name:'OmO',description:{ko:'',en:''},executable:'omo',sourceUrl:'https://example.test',method:'npm',availability:'installable',reason:null,
  installed:{path:'/example/omo',version:'1.0.0',managed:false},lastCheck:{status:'available',latestVersion:'2.0.0',checkedAt:1,failure:null},
}]};
const item:CatalogBulk['items'][number]={catalogId:'omo',name:'OmO',beforeVersion:'1.0.0',latestVersion:'2.0.0',status:'ready',reason:null,jobId:'job',jobRevision:1};
const batch:CatalogBulk={id:'batch',revision:4,stage:'ready',items:[item]};
const render=(model:AppSnapshot=snapshot,disabled=false)=>renderToStaticMarkup(<CatalogBulkActions snapshot={model} disabled={disabled} act={async()=>true}/>);
const action=(markup:string,name:string)=>markup.match(new RegExp(`<button[^>]*data-action="${name}"[^>]*>`))?.[0];

test('initial available snapshot exposes counted update intent without executing it',()=>{
  let calls=0;
  const markup=renderToStaticMarkup(<CatalogBulkActions snapshot={snapshot} disabled={false} act={async()=>{calls++;return true;}}/>);
  expect(calls).toBe(0);
  expect(action(markup,'catalog-check-all')).not.toContain('disabled');
  expect(action(markup,'catalog-update-all-plan')).toContain('data-update-count="1"');
  expect(action(markup,'catalog-update-all-confirm')).toBeUndefined();
});
test('no update intent is shown for unchecked current failed or unsupported installations',()=>{
  for(const status of ['current','checking','failed','unknown','unsupported'] as const){
    const catalog=snapshot.catalog?.map(entry=>({...entry,lastCheck:{status,latestVersion:null,checkedAt:1,failure:null}}))??[];
    expect(action(render({...snapshot,catalog}),'catalog-update-all-plan')).toBeUndefined();
  }
  expect(action(render({...snapshot,catalog:[]}),'catalog-update-all-plan')).toBeUndefined();
});
test('external disabled state blocks both commands',()=>{
  const markup=render(snapshot,true);
  expect(action(markup,'catalog-check-all')).toContain('disabled=""');
  expect(action(markup,'catalog-update-all-plan')).toContain('disabled=""');
});
test('empty installed catalog and disconnected service block checks',()=>{
  for(const model of [{...snapshot,catalog:[]},{...snapshot,service:'connecting' as const},{...snapshot,service:'unavailable' as const}])
    expect(action(render(model),'catalog-check-all')).toContain('disabled=""');
});
test('active stages block requests while retaining batch identity without duplicate result rows',()=>{
  for(const stage of ['checking','planning','updating'] as const){
    const markup=render({...snapshot,catalogBulk:{...batch,stage}});
    expect(markup).toContain(`data-bulk-stage="${stage}"`);
    expect(markup).toContain('data-bulk-id="batch" data-bulk-revision="4"');
    expect(action(markup,'catalog-check-all')).toContain('disabled=""');
    expect(action(markup,'catalog-update-all-plan')).toContain('disabled=""');
    expect(markup).not.toContain('data-bulk-catalog-id');
  }
});
test('reloaded ready batch exposes review without opening or submitting it',()=>{
  let calls=0;
  const markup=renderToStaticMarkup(<CatalogBulkActions snapshot={{...snapshot,catalogBulk:batch}} disabled={false} act={async()=>{calls++;return true;}}/>);
  expect(calls).toBe(0);
  expect(action(markup,'catalog-bulk-review')).toContain('aria-haspopup="dialog"');
  expect(action(markup,'catalog-update-all-confirm')).toBeUndefined();
  expect(markup).not.toContain('<dialog');
});
test('every completed bulk outcome stays out of the toolbar result list',()=>{
  for(const status of ['checking','available','current','ahead','unknown','unsupported','failed','ready','updating','completed','skipped','uncertain'] as const){
    const markup=render({...snapshot,catalogBulk:{...batch,stage:'completed',items:[{...item,status,reason:'service_restarted'}]}});
    expect(markup).not.toContain('data-bulk-catalog-id');
    expect(markup).not.toContain('data-bulk-recovery');
    expect(markup).not.toContain('data-action="catalog-update-all-confirm"');
  }
});
test('global guard blocks catalog actions when another family is updating',()=>{
  const guard:AppSnapshot={...snapshot,catalogUpdates:[{id:'outside-active',requestId:'request',catalogId:'codex',revision:1,stage:'updating',target:{kind:'owned',target:'/other',executable:'/other/codex',fingerprint:'fingerprint',preserve:[]},createdAt:0,updatedAt:0,beforeVersion:'1.0.0',installedVersion:null,failure:null}]};
  const markup=renderToStaticMarkup(<CatalogBulkActions snapshot={snapshot} guardSnapshot={guard} disabled={false} act={async()=>true}/>);
  expect(action(markup,'catalog-update-all-plan')).toContain('disabled=""');
});
