import { afterAll, beforeAll, expect, test } from 'bun:test';
import { chromium } from 'playwright-core';
import type { Browser, Page } from 'playwright-core';
import type { AppSnapshot } from '../src/app/types';
import { reviewSnapshot, serveReviewApp } from './app-review.fixture';

let browser:Browser;
let app:Awaited<ReturnType<typeof serveReviewApp>>;
const initial=():AppSnapshot=>{
  const model=reviewSnapshot();
  return {...model,operations:[],catalogUpdates:[],automationSettings:{paneSessions:'keep'},catalog:model.catalog?.map(entry=>({...entry,
    lastCheck:{status:'available',latestVersion:'2.0.0',checkedAt:1,failure:null},
    installations:['a','b'].map(id=>({id:'copy-'+id,catalogId:entry.id,manager:'npm',root:'/catalog/'+id,packageName:'@openai/codex',path:id==='a'?'/catalog/codex':'/catalog/b/codex',identityPath:id==='a'?'/catalog/codex':'/catalog/b/codex',version:'1.0.0',receiptId:null,isDefault:id==='a'})),
  }))??[]};
};
beforeAll(async()=>{
  app=await serveReviewApp(initial());
  const executablePath=process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH'];
  browser=await chromium.launch({headless:true,...(executablePath?{executablePath}:{channel:'chrome'})});
});
afterAll(async()=>{await browser?.close();await app?.close();});
async function open(model=initial()){
  app.reset(model);
  const page=await browser.newPage();await page.goto(app.url);
  await page.locator('[data-catalog-id="codex"]').waitFor();await app.connected();return page;
}
async function publish(page:Page,next:AppSnapshot,selector:string,attribute:string,value:string){
  await page.evaluate(({next,selector,attribute,value})=>new Promise<void>((resolve,reject)=>{
    const timer=setTimeout(()=>{observer.disconnect();reject(new Error('Snapshot not rendered'));},5000);
    const observer=new MutationObserver(()=>{
      if(document.querySelector(selector)?.getAttribute(attribute)===value){clearTimeout(timer);observer.disconnect();resolve();}
    });
    observer.observe(document,{subtree:true,childList:true,characterData:true,attributes:true});
    void fetch('/fixture/publish',{method:'POST',body:JSON.stringify(next)});
  }),{next,selector,attribute,value});
}

test('a whole-catalog plan opens its confirmation by itself even though planning refreshes the inventory first',async()=>{
  const model=initial();const page=await open(model);
  try{
    await page.locator('[data-action="catalog-update-all-plan"]').click();
    // The service re-scans installations before planning, so inventory statuses flip while the batch is planning.
    const planning:AppSnapshot={...model,revision:model.revision+1,catalog:model.catalog?.map(entry=>({...entry,inventoryStatus:'checking' as const})),catalogBulk:{id:'batch-1',revision:0,stage:'planning',items:[]}};
    await publish(page,planning,'[data-catalog-bulk]','data-bulk-stage','planning');
    const job={...reviewSnapshot().catalogUpdates![0]!,id:'bulk-codex',revision:1,stage:'ready' as const};
    const ready:AppSnapshot={...model,revision:model.revision+2,catalogUpdates:[job],catalogBulk:{id:'batch-1',revision:1,stage:'ready',items:[{catalogId:'codex',name:'Codex',beforeVersion:'1.0.0',latestVersion:'2.0.0',status:'ready',reason:null,jobId:job.id,jobRevision:job.revision}]}};
    await publish(page,ready,'[data-catalog-bulk]','data-bulk-stage','ready');
    // Then: the confirmation is open without another click, and the same button now re-opens it.
    await page.locator('.app-dialog[open] [data-action="catalog-update-all-confirm"]').waitFor({timeout:5000});
    expect(await page.locator('[data-action="catalog-bulk-review"]').count()).toBe(1);
    expect(app.commands).toEqual([{kind:'catalog-update-all-plan'}]);
  }finally{await page.close();}
});
test('card automation toggles directly without opening detail or session choices',async()=>{
  const page=await open();try{
    const row=page.locator('[data-catalog-id="codex"]');
    const response=page.waitForResponse(response=>response.url().endsWith('/api/command'));
    await row.getByRole('switch').click();await response;
    expect(app.commands).toEqual([{kind:'automation',installationId:'catalog:codex',enabled:true}]);
    expect(await row.locator('[role="tabpanel"]').count()).toBe(0);
    expect(await page.locator('input[name="automatic-pane-sessions"]').count()).toBe(0);
  }finally{await page.close();}
});

test('shared settings expose mixed legacy choices and save only the singleton command',async()=>{
  const model:AppSnapshot={...initial(),policies:[{installationId:'catalog:codex',mode:'off',intervalMinutes:60,lastCheckedAt:null,nextCheckAt:null,waitingReason:null,paneSessions:'restart-idle'}]};
  const page=await open(model);try{
    await page.locator('[data-action="automation-settings"]').click();
    expect(await page.locator('[data-automation-mixed="true"]').count()).toBe(1);
    expect(await page.locator('input[name="automatic-pane-sessions"]').count()).toBe(3);
    await page.locator('input[name="automatic-pane-sessions"]').nth(2).check();
    const response=page.waitForResponse(response=>response.url().endsWith('/api/command'));
    await page.locator('[data-action="automation-settings-save"]').click();await response;
    expect(app.commands).toEqual([{kind:'automation-settings',paneSessions:'restart-all'}]);
  }finally{await page.close();}
});

test('open shared settings rejects service drift without sending settings or restart',async()=>{
  const model=initial();const page=await open(model);try{
    await page.locator('[data-action="automation-settings"]').click();
    await publish(page,{...model,revision:2,serverInstance:'changed',catalog:model.catalog?.map(entry=>({...entry,lastCheck:{status:'checking',latestVersion:null,checkedAt:2,failure:null}}))??[]},'[data-catalog-id="codex"] [data-card-stage]','data-card-stage','checking');
    const save=page.locator('[data-action="automation-settings-save"]');
    expect(await save.isDisabled()).toBe(true);
    await save.evaluate((button:HTMLButtonElement)=>button.click());expect(app.commands).toEqual([]);
  }finally{await page.close();}
});

test('bulk SSE progress changes the existing family card without opening history or moving scroll',async()=>{
  const model=initial();const page=await open(model);try{
    await page.setViewportSize({width:900,height:600});
    const before=await page.evaluate(()=>{
      const card=document.querySelector('[data-catalog-id="codex"]');if(card)card.setAttribute('data-fixture-stable','yes');
      const main=document.querySelector('main');if(main)main.scrollTop=120;return main?.scrollTop??0;
    });
    const uncertain=reviewSnapshot().catalogUpdates?.find(job=>job.catalogId==='codex');if(!uncertain)throw new Error('Fixture missing');
    const updating:AppSnapshot={...model,revision:2,catalogUpdates:[{...uncertain,stage:'updating'}],catalogBulk:{id:'batch',revision:1,stage:'updating',items:[{catalogId:'codex',name:'Codex',beforeVersion:'1.0.0',latestVersion:'2.0.0',status:'updating',reason:null,jobId:uncertain.id,jobRevision:8}]}};
    await publish(page,updating,'[data-catalog-id="codex"] [data-card-stage]','data-card-stage','updating');
    expect(await page.locator('[data-fixture-stable="yes"]').count()).toBe(1);
    expect(await page.locator('[data-catalog-bulk] [data-bulk-catalog-id]').count()).toBe(0);
    expect(await page.locator('[role="tabpanel"]').count()).toBe(0);
    expect(await page.evaluate(()=>document.querySelector('main')?.scrollTop??0)).toBe(before);
    if(!updating.catalogBulk)throw new Error('Batch fixture missing');
    await publish(page,{...updating,revision:3,catalogUpdates:[{...uncertain,stage:'completed',installedVersion:'2.0.0'}],catalogBulk:{...updating.catalogBulk,revision:2,stage:'completed'},catalog:model.catalog?.map(entry=>({...entry,installed:entry.installed&&{...entry.installed,version:'2.0.0'}}))??[]},'[data-catalog-id="codex"] [data-card-stage]','data-card-stage','completed');
    expect(await page.locator('[data-verified-version]').textContent()).toBe('2.0.0');
    expect(await page.locator('[role="tabpanel"]').count()).toBe(0);
    expect(app.commands).toEqual([]);
  }finally{await page.close();}
});

test('organization opens retained installation choice rather than independent removal controls',async()=>{
  const page=await open();try{
    const row=page.locator('[data-catalog-id="codex"]');
    expect(await row.locator('[data-installation-count]').getAttribute('data-installation-count')).toBe('2');
    await row.locator('[data-action="organize-installations"]').click();
    expect(await row.locator('[data-catalog-cleanup="codex"] input[type="radio"]').count()).toBe(2);
    expect(await row.locator('[data-action="cleanup-review"]').count()).toBe(1);
    expect(await row.locator('[data-action="location-remove-plan"]').count()).toBe(0);
    expect(app.commands).toEqual([]);
  }finally{await page.close();}
});

test('inline uncertain recovery keeps current version separate and blocks another family active job',async()=>{
  const model:AppSnapshot={...initial(),catalogUpdates:reviewSnapshot().catalogUpdates??[]};
  const page=await open(model);try{
    const row=page.locator('[data-catalog-id="codex"]');
    expect(await row.locator('[data-current-installation-version]').textContent()).toBe('1.0.0');
    const recovery=row.locator('[data-action="catalog-update-reconcile"]');
    expect(await recovery.getAttribute('data-reason')).toBe('update_in_progress');
    expect(await recovery.isDisabled()).toBe(true);
    expect(await row.locator('[data-verified-version]').count()).toBe(0);
    expect(await row.locator('[data-action="catalog-update-archive-unverified"]').isDisabled()).toBe(true);
    expect(await row.locator('[role="tabpanel"]').count()).toBe(0);
  }finally{await page.close();}
});
test('card recovery exposes explicit archival then allows a fresh reviewed plan',async()=>{
  const job=reviewSnapshot().catalogUpdates?.find(job=>job.catalogId==='codex');if(!job)throw new Error('Fixture missing');
  const identity={root:{dev:1,ino:1},canonical:'/catalog/codex',file:{dev:1,ino:2,size:1,mtime:1,ctime:1},launcher:{dev:1,ino:2,size:1,mtime:1,ctime:1}};
  const reconciled={...job,revision:9,execution:'unknown' as const,identity:null,reconciliation:{checkedAt:2,version:'1.0.0',reason:'recovery_identity_missing',identity,fingerprint:'current'}};
  const model:AppSnapshot={...initial(),catalogUpdates:[reconciled]};
  const page=await open(model);try{
    const row=page.locator('[data-catalog-id="codex"]');
    await row.locator('[data-action="catalog-update-archive-unverified"]').click();
    const response=page.waitForResponse(response=>response.url().endsWith('/api/command'));
    await page.locator('[data-action="catalog-update-recover-confirm"]').click();await response;
    expect(app.commands).toEqual([{kind:'catalog-update-recover',jobId:job.id,revision:9,action:'archive-unverified'}]);
    await publish(page,{...model,revision:3,catalogUpdates:[{...reconciled,revision:10,stage:'archived-unverified',installedVersion:null}]},'[data-catalog-id="codex"] [data-card-stage]','data-card-stage','archived-unverified');
    expect(await row.locator('[data-action="catalog-update-archive-unverified"]').count()).toBe(0);
    expect(await row.locator('[data-verified-version]').count()).toBe(0);
    expect(await row.locator('[data-action="update"]').getAttribute('data-update-kind')).toBe('update');
    expect(await row.locator('[data-action="update"]').getAttribute('aria-disabled')).toBeNull();
  }finally{await page.close();}
});
