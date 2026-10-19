import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AppSnapshot } from '../src/app/types';
import type { CatalogEntry, CatalogInstallation } from '../src/app/catalog-types';
import { CatalogCleanup, cleanupRows, cleanupComplete, cleanupReviewStale } from './catalog-cleanup';

const install=(id:string,manager:CatalogInstallation['manager'],path:string,isDefault=false):CatalogInstallation=>({
  id,catalogId:'omo',manager,root:path.replace(/\/bin\/omo$/,''),packageName:manager==='unknown'?null:'omo-ai',path,identityPath:path.replace('/bin/omo','/lib/node_modules/omo-ai/bin/omo.js'),isDefault,receiptId:null,version:'1.0.0'});
const bun=install('bun','bun','/home/.bun/bin/omo'), npm=install('npm','npm','/home/.npm-global/bin/omo'), nvm=install('nvm','npm','/home/.nvm/v24/bin/omo',true), raw=install('raw','unknown','/home/.local/bin/omo');
const entry:CatalogEntry={id:'omo',name:'OmO',description:{ko:'',en:''},executable:'omo',sourceUrl:'',method:'npm',availability:'installable',reason:null,installed:null,installations:[bun,npm,nvm,raw],selectedInstallationId:'bun',inventoryStatus:'ready'};
const snapshot:AppSnapshot={revision:1,service:'ready',failure:null,installations:[],managed:[],operations:[],policies:[],catalog:[entry],removalJobs:[],
  external:[{id:'e1',pid:77,family:'omo',installationId:null,executable:npm.identityPath,cwd:null,runningVersion:null,control:'observation-only',processState:'observed'}]};

test('the PATH default copy becomes removable when the kept installation is itself on PATH',()=>{
  const reachable={...entry,installations:[{...bun,onPath:true},{...nvm,onPath:true}]};
  expect(cleanupRows(reachable,{...snapshot,external:[]}).map(row=>[row.installation.id,row.status])).toEqual([['bun','management-target'],['nvm','removable']]);
  const unreachable={...entry,installations:[{...bun,onPath:false},{...nvm,onPath:true}]};
  expect(cleanupRows(unreachable,{...snapshot,external:[]}).map(row=>row.status)).toEqual(['management-target','path-default']);
  // A configured new-terminal default is still never removable.
  expect(cleanupRows({...reachable,configuredDefaultInstallationId:'nvm'},{...snapshot,external:[]}).map(row=>row.status)).toEqual(['management-target','configured-default']);
});
test('cleanupRows keeps the management target, PATH default and unknown managers, and protects installations with running sessions',()=>{
  const rows=cleanupRows(entry,snapshot);
  expect(rows.map(row=>[row.installation.id,row.status])).toEqual([['bun','management-target'],['npm','in-use'],['nvm','path-default'],['raw','unknown-manager']]);
  expect(rows.find(row=>row.installation.id==='npm')?.sessionPids).toEqual([77]);
  const free=cleanupRows(entry,{...snapshot,external:[]});
  expect(free.find(row=>row.installation.id==='npm')?.status).toBe('removable');
  expect(cleanupRows({...entry,configuredDefaultInstallationId:'bun'},{...snapshot,external:[]}).find(row=>row.installation.id==='nvm')?.status).toBe('removable');
});

test('only sessions of the same CLI mark an installation as in use',()=>{
  const codex={id:'e2',pid:88,family:'codex' as const,installationId:null,executable:'/home/.npm-global/lib/node_modules/@openai/codex/bin/codex.js',cwd:null,runningVersion:null,control:'observation-only' as const,processState:'observed' as const};
  expect(cleanupRows(entry,{...snapshot,external:[codex]}).find(row=>row.installation.id==='npm')?.status).toBe('removable');
  expect(cleanupRows(entry,{...snapshot,external:[{...codex,family:'pi' as const}]}).find(row=>row.installation.id==='npm')?.status).toBe('in-use');
});

test('cleanup comparison exposes retained selection even for one installation',()=>{
  const markup=renderToStaticMarkup(<CatalogCleanup entry={entry} snapshot={{...snapshot,external:[]}} act={async()=>true} disabled={false}/>);
  expect(markup.match(/type="radio"/g)).toHaveLength(4);
  expect(markup).toContain('data-action="cleanup-review"');
  expect(markup).not.toContain('data-action="cleanup-remove"');
  expect(markup).toMatch(/<details class="cleanup-advanced"><summary>[^<]*<\/summary><label class="check"><input type="checkbox"/);
  expect(markup.match(/type="checkbox"/g)).toHaveLength(1);
  expect(markup.match(/data-cleanup-status="[^"]+"/g)).toEqual(['data-cleanup-status="removable"','data-cleanup-status="path-default"','data-cleanup-status="unknown-manager"']);
  expect(renderToStaticMarkup(<CatalogCleanup entry={{...entry,installations:[bun]}} snapshot={snapshot} act={async()=>true} disabled={false}/>)).toContain('data-action="cleanup-review"');
});

test('completion requires observed sole retained installation, not a finished removal count',()=>{
  expect(cleanupComplete(entry,'bun')).toBe(false);
  expect(cleanupComplete({...entry,installations:[bun,raw]},'bun')).toBe(false);
  expect(cleanupComplete({...entry,installations:[bun],inventoryStatus:'checking'},'bun')).toBe(false);
  expect(cleanupComplete({...entry,installations:[bun],selectedInstallationId:'npm'},'bun')).toBe(false);
  expect(cleanupComplete({...entry,installations:[bun]},'bun')).toBe(true);
});
test('review freezes inventory selection and server before transition',()=>{
  const review={target:bun,makeDefault:true,server:undefined,previous:'bun',inventory:JSON.stringify(entry.installations?.map(row=>[row.id,row.path,row.identityPath,row.version]))};
  expect(cleanupReviewStale(entry,snapshot,review)).toBe(false);
  expect(cleanupReviewStale({...entry,selectedInstallationId:'npm'},snapshot,review)).toBe(true);
  expect(cleanupReviewStale({...entry,installations:[{...bun,version:'2.0.0'},npm,nvm,raw]},snapshot,review)).toBe(true);
  expect(cleanupReviewStale(entry,{...snapshot,serverInstance:'new'},review)).toBe(true);
});
