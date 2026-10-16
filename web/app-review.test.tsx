import { afterAll, beforeAll, expect, test } from 'bun:test';
import { chromium } from 'playwright-core';
import type { Browser, Page } from 'playwright-core';
import type { AppSnapshot, PaneSessionPolicy } from '../src/app/types';
import { reviewSnapshot, serveReviewApp } from './app-review.fixture';

let browser:Browser;
let app:Awaited<ReturnType<typeof serveReviewApp>>;
beforeAll(async()=>{
  app=await serveReviewApp(reviewSnapshot());
  const executablePath=process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH'];
  browser=await chromium.launch({headless:true,...(executablePath?{executablePath}:{channel:'chrome'})});
});
afterAll(async()=>{await browser?.close();await app?.close();});
async function open(snapshot=reviewSnapshot()) {
  app.reset(snapshot);
  const page=await browser.newPage();await page.goto(app.url);
  await page.locator('[data-engine-installation="engine"]').waitFor();await app.connected();return page;
}
async function engineHistory(page:Page) {
  const row=page.locator('[data-engine-installation="engine"]');
  await row.getByRole('button',{name:'Details',exact:true}).click();
  await row.getByRole('tab',{name:'History',exact:true}).click();
  await row.getByRole('button',{name:'Review update impact',exact:true}).click();
  return page.locator('.app-dialog[open]');
}
async function publish(page:Page,next:AppSnapshot) {
  // Subscribe before sending SSE, then observe actual React output, not transport receipt.
  await page.evaluate(next=>new Promise<void>((resolve,reject)=>{
    const timer=setTimeout(()=>{observer.disconnect();reject(new Error('App did not render SSE snapshot'));},5000);
    const observer=new MutationObserver(()=>{if([...document.querySelectorAll('[data-evidence="installed"]')].some(node=>node.textContent==='9.0.0')){clearTimeout(timer);observer.disconnect();resolve();}});
    observer.observe(document,{subtree:true,childList:true,characterData:true,attributes:true});
    void fetch('/fixture/publish',{method:'POST',body:JSON.stringify(next)});
  }),next);
}
for(const policy of [undefined,'keep','restart-idle','restart-all'] as const)test('actual App engine policy and confirmation preserve '+(policy??'absent keep default'),async()=>{
  const page=await open(reviewSnapshot(policy));try{
    const row=page.locator('[data-engine-installation="engine"]');
    await row.getByRole('button',{name:'Details',exact:true}).click();await row.getByRole('tab',{name:'Automation',exact:true}).click();
    const choices:readonly PaneSessionPolicy[]=['keep','restart-idle','restart-all'];
    expect(await row.locator('input[name="pane-sessions"]').nth(choices.indexOf(policy??'keep')).isChecked()).toBe(true);
    await row.getByRole('tab',{name:'History',exact:true}).click();await row.getByRole('button',{name:'Review update impact',exact:true}).click();
    const response=page.waitForResponse(response=>response.url().endsWith('/api/command'));
    await page.getByRole('button',{name:'Approve update to this version',exact:true}).click();await response;
    expect(app.commands).toEqual([{kind:'confirm',operationId:'ready-engine',revision:1,sessions:[],restart:false,paneSessions:policy??'keep'}]);
  }finally{await page.close();}
});
for(const change of ['server-and-executable','server','executable','resources','operation-installation','revision','before-version','target-version','installed-version'] as const)test('actual App engine review rejects SSE '+change+' drift',async()=>{
  const initial=reviewSnapshot();const page=await open(initial);try{
    const dialog=await engineHistory(page);
    const next:AppSnapshot={...initial,revision:2,
      serverInstance:change.startsWith('server')?'server-b':'server-a',
      catalog:initial.catalog?.map(row=>({...row,installed:{path:'/catalog/codex',version:'9.0.0',managed:false}}))??[],
      installations:initial.installations.map(row=>({...row,installedVersion:change==='installed-version'?{kind:'known',version:'9.0.0'}:row.installedVersion,
        executableRealpath:change.includes('executable')?'/changed/omo':row.executableRealpath,
        resourcesFingerprint:change==='resources'?'resource-b':row.resourcesFingerprint})),
      operations:initial.operations.map(row=>({...row,installationId:change==='operation-installation'?'other':row.installationId,
        revision:change==='revision'?2:row.revision,beforeVersion:change==='before-version'?'9.0.0':row.beforeVersion,targetVersion:change==='target-version'?'3.0.0':row.targetVersion})),
    };
    await publish(page,next);
    const approve=dialog.getByRole('button',{name:'Approve update to this version',exact:true});expect(await approve.isDisabled()).toBe(true);
    await approve.evaluate((button:HTMLButtonElement)=>button.click());expect(app.commands).toEqual([]);
  }finally{await page.close();}
});
test('actual App CLI detail keeps OTHER active jobs outside displayed history',async()=>{
  const page=await open();try{
    const row=page.locator('[data-catalog-id="codex"]');await row.getByRole('button',{name:'Details',exact:true}).click();await row.getByRole('tab',{name:'History',exact:true}).click();
    expect(await row.locator('[data-update-job="active-omo"]').count()).toBe(0);
    const recover=row.locator('[data-action="catalog-update-reconcile"]');expect(await recover.isDisabled()).toBe(true);
    expect(await recover.getAttribute('data-reason')).toBe('update_in_progress');
    await recover.evaluate((button:HTMLButtonElement)=>button.click());expect(app.commands).toEqual([]);
  }finally{await page.close();}
});
test('actual App open detail recovery rejects another family starting over SSE',async()=>{
  const initial=reviewSnapshot();const idle={...initial,catalogUpdates:(initial.catalogUpdates??[]).filter(job=>job.id!=='active-omo')};
  const page=await open(idle);try{
    const row=page.locator('[data-catalog-id="codex"]');await row.getByRole('button',{name:'Details',exact:true}).click();await row.getByRole('tab',{name:'History',exact:true}).click();
    await row.locator('[data-action="catalog-update-reconcile"]').click();
    await publish(page,{...initial,revision:2,installations:initial.installations.map(row=>({...row,installedVersion:{kind:'known',version:'9.0.0'}}))});
    const confirm=page.locator('[data-action="catalog-update-recover-confirm"]');expect(await confirm.isDisabled()).toBe(true);
    await confirm.evaluate((button:HTMLButtonElement)=>button.click());expect(app.commands).toEqual([]);
  }finally{await page.close();}
});
test('actual App stored legacy missing pane policy remains restart-idle',async()=>{
  const initial=reviewSnapshot();const page=await open({...initial,policies:[{installationId:'engine',mode:'check',intervalMinutes:60,lastCheckedAt:null,nextCheckAt:null,waitingReason:null}]});try{
    const dialog=await engineHistory(page);
    expect(await dialog.locator('input[name="pane-sessions"]').nth(1).isChecked()).toBe(true);
    const response=page.waitForResponse(response=>response.url().endsWith('/api/command'));
    await dialog.getByRole('button',{name:'Approve update to this version',exact:true}).click();await response;
    expect(app.commands[0]).toMatchObject({kind:'confirm',paneSessions:'restart-idle'});
  }finally{await page.close();}
});
test('actual App explicit dialog choice overrides default keep',async()=>{
  const page=await open();try{
    const dialog=await engineHistory(page);await dialog.locator('input[name="pane-sessions"]').nth(2).check();
    const response=page.waitForResponse(response=>response.url().endsWith('/api/command'));
    await dialog.getByRole('button',{name:'Approve update to this version',exact:true}).click();await response;
    expect(app.commands).toEqual([{kind:'confirm',operationId:'ready-engine',revision:1,sessions:[],restart:false,paneSessions:'restart-all'}]);
  }finally{await page.close();}
});
