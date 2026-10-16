import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AppSnapshot } from '../src/app/types';
import type { CatalogCheck, CatalogEntry } from '../src/app/catalog-types';
import type { CatalogUpdateJob } from '../src/app/catalog-updates';
import type { Installation } from '../src/protocol';
import { CatalogDashboardRow, catalogUpdateAction } from './catalog-dashboard';
import { engineUpdateAction } from './dashboard';
import { Surface } from './app';

const entry=(fields:Partial<CatalogEntry>={}):CatalogEntry=>({id:'codex',name:'Codex',description:{ko:'',en:''},executable:'codex',sourceUrl:'https://example.test',method:'npm',availability:'installable',reason:null,
  installed:{path:'/fixture/codex',version:'1.0.0',managed:false},...fields});
const check=(status:CatalogCheck['status'],latestVersion:string|null='2.0.0'):CatalogCheck=>({status,latestVersion,checkedAt:10,failure:status==='failed'?'latest_network':null});
const job=(stage:CatalogUpdateJob['stage']):CatalogUpdateJob=>({id:'job-'+stage,requestId:'request',catalogId:'codex',revision:1,stage,target:{kind:'owned',target:'/fixture',executable:'/fixture/codex',fingerprint:'fingerprint',preserve:[]},createdAt:0,updatedAt:0,beforeVersion:'1.0.0',installedVersion:null,failure:null});
const snapshot=(catalog:CatalogEntry,fields:Partial<AppSnapshot>={}):AppSnapshot=>({revision:1,service:'ready',failure:null,installations:[],managed:[],external:[],operations:[],policies:[],observedAt:1,catalog:[catalog],...fields});
const row=(catalog:CatalogEntry,jobs:readonly CatalogUpdateJob[]=[],disabled=false)=>renderToStaticMarkup(<CatalogDashboardRow entry={catalog} snapshot={snapshot(catalog,{catalogUpdates:[...jobs]})} act={async()=>true} disabled={disabled} sessions={null} history={null} automation={null}/>);
const updateButton=(markup:string)=>{const found=markup.match(/<button[^>]*data-action="update"[^>]*>/g)??[];expect(found).toHaveLength(1);return found[0]!;};
const attribute=(tag:string,name:string)=>tag.match(new RegExp(`${name}="([^"]*)"`))?.[1]??null;

test('every catalog check and job state maps to one deterministic update action and reason code',()=>{
  const cases:[CatalogEntry,readonly CatalogUpdateJob[],string,string|null][]=[
    [entry(),[],'update','not_checked'],
    [entry({lastCheck:check('checking',null)}),[],'update','checking'],
    [entry({lastCheck:check('available')}),[],'update',null],
    [entry({lastCheck:check('current','1.0.0')}),[],'update','current'],
    [entry({lastCheck:check('ahead','0.9.0')}),[],'update','ahead'],
    [entry({lastCheck:check('unknown','nightly')}),[],'update','not_comparable'],
    [entry({lastCheck:check('failed',null)}),[],'update','check_failed'],
    [entry({lastCheck:check('unsupported',null)}),[],'update','unsupported'],
    [entry({updateSupport:{kind:'unsupported',reason:'self_update_only'},lastCheck:check('available')}),[],'update','unsupported'],
    [entry({inventoryStatus:'checking',lastCheck:check('available')}),[],'update','inventory_checking'],
    [entry({inventoryStatus:'failed',lastCheck:check('available')}),[],'update','inventory_failed'],
    [entry({installed:null,lastCheck:check('available')}),[],'update','no_selected_installation'],
    [entry({lastCheck:check('available')}),[job('ready')],'review',null],
    [entry({lastCheck:check('current','1.0.0')}),[job('updating')],'progress',null],
    [entry({lastCheck:check('available')}),[job('ready'),job('uncertain')],'inspect',null],
  ];
  for(const [catalog,jobs,kind,reason] of cases)expect(catalogUpdateAction(catalog,jobs)).toEqual({kind,reason} as never);
});

test('update stays discoverable for blocked states but only an available check can request a plan',()=>{
  for(const status of ['current','ahead','unknown','failed','checking'] as const){
    const tag=updateButton(row(entry({lastCheck:check(status)})));
    expect(attribute(tag,'aria-disabled')).toBe('true');
    expect(attribute(tag,'data-reason')).not.toBeNull();
    expect(tag).not.toContain('disabled=""');
  }
  const ready=updateButton(row(entry({lastCheck:check('available')})));
  expect(attribute(ready,'aria-disabled')).toBeNull();
  expect(attribute(ready,'data-reason')).toBeNull();
  const offline=updateButton(row(entry({lastCheck:check('available')}),[],true));
  expect(attribute(offline,'data-reason')).toBe('service_unavailable');
});

test('blocked update reasons are announced through aria-describedby',()=>{
  const markup=row(entry());
  const described=attribute(updateButton(markup),'aria-describedby')?.split(' ')??[];
  expect(described).toHaveLength(2);
  for(const id of described)expect(markup).toContain(`id="${id}"`);
});

test('latest check is a separate control from update',()=>{
  const markup=row(entry({lastCheck:check('failed',null)}));
  const checks=markup.match(/<button[^>]*data-action="catalog-check"[^>]*>/g)??[];
  expect(checks).toHaveLength(1);
  expect(checks[0]).not.toContain('disabled');
});

test('installed and latest evidence render in separate cells and unknown latest is never the installed version',()=>{
  const evidence=(markup:string,name:string)=>markup.match(new RegExp(`data-evidence="${name}"[^>]*>([^<]*)<`))?.[1];
  const unchecked=row(entry());
  expect(evidence(unchecked,'installed')).toBe('1.0.0');
  expect(evidence(unchecked,'latest')).toBe('—');
  expect(evidence(row(entry({lastCheck:check('failed',null)})),'latest')).toBe('—');
  expect(evidence(row(entry({lastCheck:check('available','2.0.0')})),'latest')).toBe('2.0.0');
  expect(evidence(row(entry({lastCheck:check('current','1.0.0')})),'latest')).toBe('1.0.0');
});

const engine=(fields:Partial<Installation>={}):Installation=>({installationId:'engine-omo',family:'omo',channel:'stable',executableRealpath:'/engine/omo.js',resourcesFingerprint:'fingerprint',resources:[],
  owner:{kind:'package',manager:'bun',packageName:'omo-ai',prefix:'/engine'},installedVersion:{kind:'known',version:'3.0.0'},
  lastCheck:{checkedAt:10,result:{kind:'update-available',installedVersion:'3.0.0',availableVersion:'3.1.0',checkedAt:10}},...fields});

test('engine update actions keep their own reason codes and never claim latest from a failed check',()=>{
  expect(engineUpdateAction(engine(),[])).toEqual({kind:'update',reason:null});
  expect(engineUpdateAction(engine({lastCheck:null}),[])).toEqual({kind:'update',reason:'not_checked'});
  expect(engineUpdateAction(engine({lastCheck:{checkedAt:10,result:{kind:'unavailable',failure:{code:'network'} as never,checkedAt:10}}}),[])).toEqual({kind:'update',reason:'check_failed'});
  expect(engineUpdateAction(engine({owner:{kind:'unknown',reason:'unverified_owner'}}),[])).toEqual({kind:'update',reason:'owner_unverified'});
  expect(engineUpdateAction(engine({family:'codex'}),[])).toEqual({kind:'update',reason:'unsupported'});
});

test('a family row keeps catalog and engine-only routes distinct inside one CLI entry',()=>{
  const catalog=entry({id:'omo',name:'OmO',executable:'omo',installed:{path:'/catalog/omo',version:'2.0.0',managed:false}});
  const markup=renderToStaticMarkup(<Surface snapshot={snapshot(catalog,{installations:[engine()]})} view="updates" onView={()=>{}} act={async()=>true} disabled={false}/>);
  expect(markup.match(/data-catalog-id="omo"/g)).toHaveLength(1);
  expect(markup.match(/data-engine-installation="engine-omo"/g)).toHaveLength(1);
  const family=markup.slice(markup.indexOf('data-catalog-id="omo"'));
  expect(family).toContain('data-engine-installation="engine-omo"');
  expect(markup).toContain('data-route="catalog"');
  expect(markup).toContain('data-route="engine"');
  expect(markup.match(/data-action="update"/g)).toHaveLength(2);
});

test('engine-only installations without a catalog row remain actionable on the update view',()=>{
  const markup=renderToStaticMarkup(<Surface snapshot={{...snapshot(entry()),catalog:[],installations:[engine()]}} view="updates" onView={()=>{}} act={async()=>true} disabled={false}/>);
  const tag=updateButton(markup);
  expect(attribute(tag,'data-reason')).toBeNull();
  expect(markup).toContain('data-action="check"');
});

type Node={readonly attrs:Record<string,string>;readonly children:Node[]};
const parse=(markup:string):Node=>{
  const root:Node={attrs:{},children:[]};const stack=[root];
  new HTMLRewriter().on('*',{element(element){
    const node:Node={attrs:Object.fromEntries(element.attributes),children:[]};
    stack.at(-1)!.children.push(node);
    if(!element.selfClosing&&element.canHaveContent){stack.push(node);element.onEndTag(()=>{stack.pop();});}
  }}).transform(markup);
  return root;
};
const all=(node:Node,match:(node:Node)=>boolean,stop:(node:Node)=>boolean=()=>false):Node[]=>node.children.flatMap(child=>[...(match(child)?[child]:[]),...(stop(child)?[]:all(child,match,stop))]);
const isRoute=(node:Node)=>'data-catalog-id' in node.attrs||'data-engine-installation' in node.attrs;
const targetOf=(section:Node)=>{
  const own=all(section,()=>true,isRoute);
  const button=own.find(node=>node.attrs['data-action']==='update');
  const target=own.find(node=>'data-update-target' in node.attrs);
  if(!button||!target)throw new Error('update control without target');
  expect(button.attrs['aria-describedby']?.split(' ')).toContain(target.attrs['id']!);
  return target.attrs['data-update-target'];
};

test('switching the selected catalog installation changes the visible update target',()=>{
  const copy=(id:string)=>({id,catalogId:'omo' as const,manager:'bun' as const,root:'/copies/'+id,packageName:'omo-ai',path:`/copies/${id}/omo`,identityPath:`/copies/${id}/omo`,isDefault:false,receiptId:null,version:'1.0.0'});
  const render=(selected:string)=>parse(row(entry({id:'omo',name:'OmO',installations:[copy('a'),copy('b')],selectedInstallationId:selected,installed:{path:`/copies/${selected}/omo`,version:'1.0.0',managed:false},lastCheck:check('available')})));
  const family=(root:Node)=>all(root,node=>node.attrs['data-catalog-id']==='omo')[0]!;
  const a=targetOf(family(render('a')));
  const b=targetOf(family(render('b')));
  expect(a).toBe('/copies/a/omo');
  expect(b).toBe('/copies/b/omo');
});

test('two same-package engine routes nest in one family row with distinct visible targets',()=>{
  const catalog=entry({id:'omo',name:'OmO',executable:'omo',installed:{path:'/catalog/omo',version:'2.0.0',managed:false}});
  const markup=renderToStaticMarkup(<Surface snapshot={snapshot(catalog,{installations:[engine({installationId:'omo-a',executableRealpath:'/engine/omo-a'}),engine({installationId:'omo-b',executableRealpath:'/engine/omo-b'})]})} view="updates" onView={()=>{}} act={async()=>true} disabled={false}/>);
  const root=parse(markup);
  const family=all(root,node=>node.attrs['data-catalog-id']==='omo');
  expect(family).toHaveLength(1);
  const routes=all(family[0]!,node=>'data-engine-installation' in node.attrs,isRoute);
  expect(routes.map(route=>route.attrs['data-engine-installation'])).toEqual(['omo-a','omo-b']);
  expect(routes.map(targetOf)).toEqual(['/engine/omo-a','/engine/omo-b']);
  expect(targetOf(family[0]!)).toBe('/catalog/omo');
  const outside=all(root,node=>'data-engine-installation' in node.attrs,node=>'data-catalog-id' in node.attrs);
  expect(outside).toHaveLength(0);
});

test('primary navigation exposes updates, sessions and history with Add CLI as an explicit entry',()=>{
  const markup=renderToStaticMarkup(<Surface snapshot={snapshot(entry())} view="updates" onView={()=>{}} act={async()=>true} disabled={false}/>);
  const nav=markup.match(/<nav[\s\S]*?<\/nav>/)?.[0]??'';
  expect([...nav.matchAll(/data-view="([^"]+)"/g)].map(match=>match[1])).toEqual(['updates','sessions','history']);
  expect(markup).toContain('data-action="add-cli"');
  const add=renderToStaticMarkup(<Surface snapshot={snapshot(entry())} view="add" onView={()=>{}} act={async()=>true} disabled={false}/>);
  expect(add).toContain('data-action="back-to-updates"');
  expect(add.match(/<nav[\s\S]*?<\/nav>/)?.[0]).toMatch(/data-view="updates" aria-current="page"/);
});
