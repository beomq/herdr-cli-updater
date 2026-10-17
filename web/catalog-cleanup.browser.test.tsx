import { afterAll, beforeAll, expect, test } from 'bun:test';
import { chromium } from 'playwright-core';
import type { Browser, Page } from 'playwright-core';
import type { AppSnapshot } from '../src/app/types';
import type { RemovalJob } from '../src/app/catalog-removal';
import { reviewSnapshot, serveReviewApp } from './app-review.fixture';

let browser:Browser;
let app:Awaited<ReturnType<typeof serveReviewApp>>;
const initial=():AppSnapshot=>{
  const model=reviewSnapshot();
  return {...model,operations:[],catalogUpdates:[],catalog:model.catalog?.map(entry=>({...entry,
    installations:['a','b'].map(id=>({id:'copy-'+id,catalogId:entry.id,manager:'npm' as const,root:'/catalog/'+id,packageName:'@openai/codex',path:id==='a'?'/catalog/codex':'/catalog/b/codex',identityPath:id==='a'?'/catalog/codex':'/catalog/b/codex',version:'1.0.0',receiptId:null,isDefault:id==='a'})),
  }))??[]};
};
const job:RemovalJob={id:'00000000-0000-4000-8000-000000000001',requestId:'r',catalogId:'codex',installationId:'copy-b',revision:3,stage:'ready',
  target:{kind:'npm',target:'/catalog/b',executable:'/catalog/b/codex',manager:'/fixture/npm',packageName:'@openai/codex',fingerprint:'a'.repeat(64),preserve:['/home/.codex']},
  createdAt:1,updatedAt:1,failure:null,references:[]};
beforeAll(async()=>{
  app=await serveReviewApp(initial());
  const executablePath=process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH'];
  browser=await chromium.launch({headless:true,...(executablePath?{executablePath}:{channel:'chrome'})});
});
afterAll(async()=>{await browser?.close();await app?.close();});
async function keepFirst(){
  app.reset(initial());
  const page=await browser.newPage();await page.goto(app.url);
  await page.locator('[data-catalog-id="codex"]').waitFor();await app.connected();
  await page.locator('[data-action="organize-installations"]').click();
  expect(await page.locator('.cleanup-advanced').getAttribute('open')).toBeNull();
  const planned=page.waitForResponse(response=>response.url().endsWith('/api/command')&&response.request().postData()?.includes('remove-plan')===true);
  await page.locator('[data-action="cleanup-review"]').click();await planned;
  return page;
}
async function publishJob(page:Page){
  await page.evaluate(next=>fetch('/fixture/publish',{method:'POST',body:JSON.stringify(next)}),{...initial(),revision:2,removalJobs:[job]});
  await page.locator('[data-cleanup-confirm="copy-b"]').waitFor();
}

test('keeping an installation switches once and prepares the next removal review without deleting',async()=>{
  const page=await keepFirst();try{
    expect(app.commands).toEqual([
      {kind:'catalog-select',catalogId:'codex',installationId:'copy-a',reviewed:{path:'/catalog/codex',identityPath:'/catalog/codex',version:'1.0.0',makeDefault:false}},
      {kind:'remove-plan',catalogId:'codex',installationId:'copy-b'},
    ]);
    await publishJob(page);
    expect(app.commands.some(command=>command.kind==='remove-confirm')).toBe(false);
    const confirmed=page.waitForResponse(response=>response.url().endsWith('/api/command'));
    await page.locator('[data-action="cleanup-remove"]').click();await confirmed;
    expect(app.commands.at(-1)).toEqual({kind:'remove-confirm',jobId:job.id,revision:3});
  }finally{await page.close();}
});

test('declining a prepared copy keeps it and sends no removal or further plan',async()=>{
  const page=await keepFirst();try{
    await publishJob(page);
    await page.locator('[data-action="cleanup-keep"]').click();
    expect(await page.locator('[data-cleanup-status="kept"]').count()).toBe(1);
    expect(await page.locator('[data-cleanup-confirm]').count()).toBe(0);
    expect(app.commands.map(command=>command.kind)).toEqual(['catalog-select','remove-plan']);
  }finally{await page.close();}
});
