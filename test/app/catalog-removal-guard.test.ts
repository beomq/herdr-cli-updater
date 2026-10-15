import { expect,test } from 'bun:test';
import { guardRemoval } from '../../src/app/catalog-removal-guard';
import type { AppSnapshot } from '../../src/app/types';
import type { RemovalTarget } from '../../src/app/catalog-removal-target';
const target:RemovalTarget={kind:'owned',target:'/tmp/owned',executable:'/tmp/owned/bin/maki',fingerprint:'x',preserve:[]};
const snapshot:AppSnapshot={revision:0,service:'ready',installations:[],managed:[],external:[],operations:[],policies:[],failure:null};
test('unlisted CLI process still blocks deletion by physical target',()=>{
  expect(()=>guardRemoval(target,snapshot,[{pid:1,parent:0,uid:process.getuid?.()??0,command:'/tmp/owned/bin/maki'}])).toThrow('running_sessions');
});
test('extension consumers block deletion even when runtime executable differs',()=>{
  expect(()=>guardRemoval(target,snapshot,[{pid:1,parent:0,uid:process.getuid?.()??0,command:'/usr/bin/node /tmp/engine.js --extension /tmp/owned/plugin.js'}])).toThrow('running_sessions');
});
test.each(['--max-old-space-size=8192','--loader ts-node/esm'])('runtime option %s cannot bypass physical path protection',(option)=>{
  for(const path of [target.executable,'/tmp/owned/plugin.js']){
    expect(()=>guardRemoval(target,snapshot,[{pid:1,parent:0,uid:process.getuid?.()??0,command:`/usr/bin/node ${option} ${path}`}])).toThrow('running_sessions');
  }
});
test('active automation is checked before any deletion',()=>{
  const installation={installationId:'i',resourcesFingerprint:'x',owner:{kind:'unknown' as const,reason:'unverified_owner' as const},installedVersion:{kind:'known' as const,version:'1.0.0'},family:'omo' as const,channel:'stable',executableRealpath:target.executable,resources:[],lastCheck:null};
  expect(()=>guardRemoval(target,{...snapshot,installations:[installation],policies:[{installationId:'i',mode:'check',intervalMinutes:60,lastCheckedAt:null,nextCheckAt:1,waitingReason:null}]},[])).toThrow('disable_automation_before_removal');
});
test('another package under the same manager prefix does not block removal',()=>{
  const npmTarget:RemovalTarget={kind:'npm',target:'/tmp/prefix/lib',executable:'/tmp/prefix/bin/maki',packageName:'maki',manager:'/tmp/npm',fingerprint:'a'.repeat(64),preserve:[]};
  expect(()=>guardRemoval(npmTarget,snapshot,[{pid:1,parent:0,uid:process.getuid?.()??0,command:'/usr/bin/node /tmp/prefix/lib/node_modules/other/cli.js'}])).not.toThrow();
});
test('update-only guard distinguishes an app-bundled CLI from a separate installation',()=>{
  const codex:RemovalTarget={...target,executable:'/tmp/owned/bin/codex'};
  const catalog:AppSnapshot['catalog']=[{id:'codex',name:'Codex',description:{ko:'',en:''},executable:'codex',
    method:'npm',sourceUrl:'https://example.com',availability:'installable',reason:null,
    installed:{path:codex.executable,version:'1.0.0',managed:true}}];
  const appProcess={pid:1,parent:0,uid:process.getuid?.()??0,command:'/Applications/ChatGPT.app/Contents/Resources/codex app-server'};
  expect(()=>guardRemoval(codex,{...snapshot,catalog},[appProcess],true)).not.toThrow();
  expect(()=>guardRemoval(codex,{...snapshot,catalog},[{...appProcess,command:codex.executable}],true)).toThrow('running_sessions');
  expect(()=>guardRemoval(codex,{...snapshot,catalog},[{...appProcess,command:'codex'}],true)).toThrow('running_sessions');
});
