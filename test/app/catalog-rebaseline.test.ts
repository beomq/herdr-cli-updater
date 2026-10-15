import { expect, test } from 'bun:test';
import { newerVersion, parseBinding, rebaselineRow } from '../../src/app/catalog-rebaseline';
import type { CatalogEntry } from '../../src/app/catalog-types';
import type { UpdatePolicy } from '../../src/app/types';

test('newerVersion compares numerically and ranks releases above their prereleases',()=>{
  expect(newerVersion('5.1.32','5.1.30')).toBe(true);
  expect(newerVersion('5.1.30','5.1.32')).toBe(false);
  expect(newerVersion('5.10.0','5.9.9')).toBe(true);
  expect(newerVersion('5.1.30','5.1.30')).toBe(false);
  expect(newerVersion('5.1.0','5.1.0-0.beta.53')).toBe(true);
  expect(newerVersion('5.1.0-0.beta.53','5.1.0')).toBe(false);
  expect(newerVersion('v2.0.0','1.9.9')).toBe(true);
});

const binding=JSON.stringify(['bun','/home/.bun/install/global','/home/.bun/bin/omo','/opt/bun','omo-ai']);
const policy:UpdatePolicy={installationId:'catalog:omo',mode:'update',intervalMinutes:60,catalogBinding:binding,lastCheckedAt:0,nextCheckAt:1,waitingReason:null,lastInstalledVersion:'5.1.30'};
const row={id:'r',catalogId:'omo' as const,manager:'bun' as const,root:'/home/.bun/install/global',packageName:'omo-ai',path:'/home/.bun/bin/omo',identityPath:'/home/.bun/install/global/node_modules/omo-ai/bin/omo.js',receiptId:null,version:'5.1.32',isDefault:true};
const entry:CatalogEntry={id:'omo',name:'OmO',description:{ko:'',en:''},executable:'omo',sourceUrl:'https://example.com',method:'npm',availability:'installable',reason:null,installed:{path:row.path,version:'5.1.32',managed:false},installations:[row],inventoryStatus:'ready'};

test('parseBinding reads the serialized update binding tuple',()=>{
  expect(parseBinding(binding)).toEqual({kind:'bun',target:'/home/.bun/install/global',executable:'/home/.bun/bin/omo',packageName:'omo-ai'});
  expect(parseBinding('not json')).toBeNull();
});

test('rebaselineRow qualifies only a bound, inventory-validated, newer install the worker dropped',()=>{
  expect(rebaselineRow(policy,entry,false,10_000_000)).toEqual(row);
  expect(rebaselineRow(policy,entry,true,10_000_000)).toBeNull();
  expect(rebaselineRow({...policy,mode:'off'},entry,false,10_000_000)).toBeNull();
  expect(rebaselineRow(policy,{...entry,inventoryStatus:'checking'},false,10_000_000)).toBeNull();
  expect(rebaselineRow({...policy,catalogBinding:undefined},entry,false,10_000_000)).toBeNull();
  expect(rebaselineRow(policy,{...entry,installations:[{...row,path:'/elsewhere/omo'}]},false,10_000_000)).toBeNull();
  expect(rebaselineRow(policy,{...entry,installations:[{...row,manager:'npm'}]},false,10_000_000)).toBeNull();
  expect(rebaselineRow(policy,{...entry,installations:[{...row,packageName:'other'}]},false,10_000_000)).toBeNull();
  expect(rebaselineRow(policy,{...entry,installations:[{...row,version:'5.1.29'}]},false,10_000_000)).toBeNull();
  expect(rebaselineRow(policy,{...entry,installations:[{...row,version:'5.1.30'}]},false,10_000_000)).not.toBeNull();
  expect(rebaselineRow({...policy,lastInstalledVersion:null},entry,false,10_000_000)).toEqual(row);
  expect(rebaselineRow({...policy,catalogBinding:JSON.stringify(['owned','/app','/app/bin/omo'])},entry,false,10_000_000)).toBeNull();
  expect(rebaselineRow({...policy,lastRebaselineAt:10_000_000-1000},entry,false,10_000_000)).toBeNull();
  expect(rebaselineRow({...policy,lastRebaselineAt:10_000_000-3_600_000},entry,false,10_000_000)).toEqual(row);
});
