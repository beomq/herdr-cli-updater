import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AppSnapshot } from '../src/app/types';
import type { CatalogEntry, CatalogInstallation } from '../src/app/catalog-types';
import type { CatalogDefaultJob } from '../src/app/catalog-default-jobs';
import { CatalogInstallations, defaultReviewIsStale, installationControlsBlocked } from './catalog-installations';

const bun:CatalogInstallation={id:'bun',catalogId:'omo',manager:'bun',root:'/home/.bun/global',packageName:'omo-ai',path:'/home/.bun/bin/omo',identityPath:'/home/.bun/global/omo.js',isDefault:false,receiptId:null,version:'1.0.0'};
const npm:CatalogInstallation={...bun,id:'npm',manager:'npm',root:'/usr/local/lib',path:'/usr/local/bin/omo',identityPath:'/usr/local/lib/omo.js',isDefault:true};
const unknown:CatalogInstallation={...bun,id:'unknown',manager:'unknown',path:'/observed/omo',identityPath:'/observed/omo',isDefault:false};
const entry:CatalogEntry={id:'omo',name:'OmO',description:{ko:'CLI',en:'CLI'},executable:'omo',sourceUrl:'https://example.com',method:'npm',availability:'installable',reason:null,installed:null,installations:[bun,npm,unknown],selectedInstallationId:bun.id,inventoryStatus:'ready'};
const snapshot:AppSnapshot={revision:1,service:'ready',failure:null,installations:[],managed:[],external:[],operations:[],policies:[],defaultJobs:[]};
const policy={installationId:'catalog:omo',mode:'update' as const,intervalMinutes:60,lastCheckedAt:null,nextCheckAt:null,waitingReason:null};
const review:CatalogDefaultJob={id:'job',requestId:'request',catalogId:'omo',installationId:'bun',revision:1,stage:'ready',createdAt:1,updatedAt:1,failure:null,result:null,plan:{id:'plan',catalogId:'omo',installationId:'bun',directory:'/app',home:'/home',path:'/usr/local/bin',shell:'/bin/zsh',executable:bun.path,identityPath:bun.identityPath,launcher:'/app/launchers/omo',profile:'/home/.zshrc',description:'',applicability:'new-interactive-zsh-shells',limitations:[],fingerprints:{target:'a'.repeat(64),profile:null,launcher:null,home:'a'.repeat(64),directory:'a'.repeat(64),launchers:null,zshenv:null,zprofile:null,zlogin:null}}};
const render=(model:AppSnapshot=snapshot,row:CatalogEntry=entry,disabled=false)=>renderToStaticMarkup(<CatalogInstallations entry={row} snapshot={model} disabled={disabled} act={async()=>true}/>);
const action=(markup:string,kind:string)=>markup.match(new RegExp(`<button[^>]*data-action="${kind}"[^>]*>`))?.[0]??'';

test('initial render observes rows without actions or confirmation',()=>{
  let calls=0;
  const markup=renderToStaticMarkup(<CatalogInstallations entry={entry} snapshot={snapshot} disabled={false} act={async()=>{calls++;return true;}}/>);
  expect(calls).toBe(0);
  expect(markup.match(/data-installation-id=/g)).toHaveLength(3);
  expect(markup).not.toContain('<select');expect(markup).not.toContain('<dialog');
  expect(markup).not.toContain('data-action="default-confirm"');
  expect(markup.match(/data-path-default=/g)).toHaveLength(1);
  expect(markup.match(/data-management-target=/g)).toHaveLength(1);
  expect(markup).toContain(bun.path);expect(markup).toContain(bun.root);
});
test('individual removal remains available in details for every discovered installation',()=>{
  expect(render().match(/data-removal-installation="([^"]+)"/g)).toEqual(['data-removal-installation="bun"','data-removal-installation="npm"','data-removal-installation="unknown"']);
});
test('PATH default and completed future-shell configuration prevent redundant plans',()=>{
  expect(action(render(snapshot,{...entry,selectedInstallationId:npm.id}),'default-plan')).toContain('disabled');
  const completed:CatalogDefaultJob={...review,stage:'completed',result:{version:'1.0.0',launcher:'/app/launchers/omo',profile:'/home/.zshrc',backup:'/app/backup'}};
  const markup=render({...snapshot,defaultJobs:[completed]},{...entry,configuredDefaultInstallationId:bun.id});
  expect(action(markup,'default-plan')).toContain('disabled');
  expect(markup).toContain('data-future-default="bun"');
  expect(markup.match(/data-path-default=/g)).toHaveLength(1);
  expect(action(render(),'default-plan')).not.toContain('disabled');
  expect(action(render({...snapshot,defaultJobs:[completed]}),'default-plan')).not.toContain('disabled');
});
test('inventory, offline and external disabled guard all controls',()=>{
  for(const markup of [render(snapshot,entry,true),render({...snapshot,service:'unavailable'}),render(snapshot,{...entry,inventoryStatus:'checking'})]){
    expect(action(markup,'default-plan')).toContain('disabled');
    expect([...markup.matchAll(/<button[^>]*data-action="catalog-select"[^>]*>/g)].every(match=>match[0].includes('disabled'))).toBe(true);
  }
  expect(installationControlsBlocked(entry,{...snapshot,policies:[{...policy,mode:'off'}]})).toBe(false);
});
test('automation permits target selection but still blocks independent default switching',()=>{
  const markup=render({...snapshot,policies:[policy]});
  expect(action(markup,'default-plan')).toContain('disabled');
  const buttons=[...markup.matchAll(/<button[^>]*data-action="catalog-select"[^>]*>/g)].map(match=>match[0]);
  expect(buttons.filter(button=>!button.includes('disabled'))).toHaveLength(2);
  expect(installationControlsBlocked(entry,{...snapshot,policies:[policy]},{automation:false})).toBe(false);
});
test('advanced legacy controls do not advertise another installation',()=>{
  const row={...entry,installations:[{...bun,manager:'owned' as const}],installMethods:[{method:'npm' as const,label:'npm',sourceUrl:entry.sourceUrl,recommended:true}]};
  let calls=0;
  const markup=renderToStaticMarkup(<CatalogInstallations entry={row} snapshot={snapshot} disabled={false} act={async()=>true} onInstall={()=>{calls++;}}/>);
  expect(markup).not.toContain('data-action="catalog-migrate"');
  expect(calls).toBe(0);
});
test('old core automation matches any instance, not only selected management target',()=>{
  const core={installationId:'core',family:'omo',channel:'stable',executableRealpath:npm.identityPath,resourcesFingerprint:'fingerprint',resources:[],owner:{kind:'unknown',reason:'unverified_owner'},installedVersion:{kind:'unknown',reason:'not_captured'},lastCheck:null} as const;
  expect(installationControlsBlocked(entry,{...snapshot,installations:[core],policies:[{...policy,installationId:'core'}]})).toBe(true);
  expect(installationControlsBlocked(entry,{...snapshot,installations:[{...core,executableRealpath:'/unrelated/omo'}],policies:[{...policy,installationId:'core'}]})).toBe(true);
  expect(installationControlsBlocked(entry,{...snapshot,installations:[{...core,family:'codex'}],policies:[{...policy,installationId:'core'}]})).toBe(false);
});
test('cleanup is not blocked by automation that only updates the management target',()=>{
  const automation={...policy,nextCheckAt:1000};
  expect(installationControlsBlocked(entry,{...snapshot,policies:[automation]})).toBe(true);
  expect(installationControlsBlocked(entry,{...snapshot,policies:[automation]},{automation:false})).toBe(false);
});
test('active and uncertain jobs block default changes and target selection',()=>{
  for(const stage of ['applying','uncertain'] as const){
    const model={...snapshot,defaultJobs:[{...review,stage}]};
    expect(installationControlsBlocked(entry,model,{automation:false})).toBe(true);
    expect([...render(model).matchAll(/<button[^>]*data-action="catalog-select"[^>]*>/g)].every(match=>match[0].includes('disabled'))).toBe(true);
  }
  const target={kind:'owned' as const,target:'/app',executable:bun.path,fingerprint:'fingerprint',preserve:[]};
  const base={id:'job',requestId:'request',catalogId:'omo' as const,revision:1,createdAt:0,updatedAt:0,failure:null,target};
  for(const stage of ['updating','uncertain'] as const)expect(installationControlsBlocked(entry,{...snapshot,catalogUpdates:[{...base,stage,beforeVersion:null,installedVersion:null}]},{automation:false})).toBe(true);
  for(const stage of ['removing','uncertain'] as const)expect(installationControlsBlocked(entry,{...snapshot,removalJobs:[{...base,stage}]},{automation:false})).toBe(true);
  for(const stage of ['installing','verifying','uncertain'] as const)expect(installationControlsBlocked(entry,{...snapshot,installJobs:[{...base,target:'/app',stage,sourceUrl:'https://example.com',method:'npm',recipeHash:'hash',installedVersion:null,executablePath:null,log:[]}]},{automation:false})).toBe(true);
});
test('review binds selection, executable, identity, plan and revision',()=>{
  expect(defaultReviewIsStale(entry,[review],review)).toBe(false);
  expect(defaultReviewIsStale({...entry,selectedInstallationId:npm.id},[review],review)).toBe(false);
  for(const field of ['path','identityPath'] as const)expect(defaultReviewIsStale({...entry,installations:[{...bun,[field]:'/changed'}]},[review],review)).toBe(true);
  expect(defaultReviewIsStale(entry,[],review)).toBe(true);
  expect(defaultReviewIsStale(entry,[{...review,revision:2}],review)).toBe(true);
  expect(defaultReviewIsStale(entry,[{...review,stage:'completed'}],review)).toBe(true);
  expect(defaultReviewIsStale(entry,[{...review,plan:{...review.plan,launcher:'/changed'}}],review)).toBe(true);
});
