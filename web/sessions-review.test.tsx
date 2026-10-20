import { afterAll, beforeAll, expect, test } from 'bun:test';
import { chromium } from 'playwright-core';
import type { Browser, Page } from 'playwright-core';

let browser:Browser;
let server:ReturnType<typeof Bun.serve>;
beforeAll(async()=>{
  const bundle=await Bun.build({entrypoints:[import.meta.dir+'/sessions-review.fixture.tsx'],target:'browser',define:{'process.env.NODE_ENV':'"production"'}});
  if(!bundle.success)throw new Error('fixture bundle failed: '+bundle.logs.join('\n'));
  const assets=new Map(bundle.outputs.map(asset=>[asset.kind==='entry-point'?'/fixture.js':'/fixture.css',asset]));
  server=Bun.serve({hostname:'127.0.0.1',port:0,fetch(request){const path=new URL(request.url).pathname;
    if(path==='/')return new Response('<!doctype html><html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script type="module" src="/fixture.js"></script></html>',{headers:{'content-type':'text/html'}});
    const asset=assets.get(path);return asset?new Response(asset):new Response(null,{status:410});
  }});
  const executablePath=process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH'];
  browser=await chromium.launch({headless:true,...(executablePath?{executablePath}:{channel:'chrome'})});
});
afterAll(async()=>{await browser?.close();server?.stop(true);});
async function open(page:Page,kind:'pane'|'native'|'managed'|'history',disabled=false){
  await page.goto('http://127.0.0.1:'+server.port+'/?'+(kind==='history'?'history&':'')+(disabled?'disabled':''));
  await page.evaluate(()=>new Promise<void>(resolve=>{if(window.reviewReady)resolve();else window.addEventListener('review-render',()=>resolve(),{once:true});}));
  const button=kind==='pane'?page.locator('[data-action="review-pane-restart"]'):kind==='history'?page.locator('[data-action="catalog-update-reconcile"]'):page.getByRole('button',{name:'Restart session',exact:true}).nth(kind==='native'?0:1);
  return button;
}
for(const kind of ['pane','native','managed'] as const)for(const change of (kind==='managed'?['server','conversation','activity','both'] as const:['server'] as const))test(kind+' review rejects '+change+' drift',async()=>{
  const page=await browser.newPage({locale:'en-US'});try{
    await (await open(page,kind)).click();
    await page.evaluate(change=>new Promise<void>(resolve=>{window.addEventListener('review-render',()=>resolve(),{once:true});window.reviewChange(change);}),change);
    const dialog=page.locator('.app-dialog[open]');
    expect(await dialog.locator('.dialog-body button').last().isDisabled()).toBe(true);
    expect(await dialog.textContent()).toContain('conversation-A');
    expect(await dialog.textContent()).not.toContain('conversation-B');
    await dialog.locator('.dialog-body button').last().evaluate((button:HTMLButtonElement)=>button.click());
    expect(await page.evaluate(()=>window.reviewCommands)).toEqual([]);
  }finally{await page.close();}
});
test('batch review sends one pane-restart-batch command for the listed panes and rejects server drift',async()=>{
  const page=await browser.newPage({locale:'en-US'});try{
    await page.goto('http://127.0.0.1:'+server.port+'/');
    await page.evaluate(()=>new Promise<void>(resolve=>{if(window.reviewReady)resolve();else window.addEventListener('review-render',()=>resolve(),{once:true});}));
    const button=page.locator('[data-action="review-pane-restart-batch"]');expect(await button.getAttribute('data-count')).toBe('1');
    await button.click();
    const dialog=page.locator('.app-dialog[open]');expect(await dialog.locator('[data-batch-session="pane"]').getAttribute('data-batch-mode')).toBe('idle');
    // Every listed pane starts selected; an unselected list cannot be confirmed.
    const box=dialog.locator('[data-batch-session="pane"] input[type="checkbox"]');expect(await box.isChecked()).toBe(true);
    await box.uncheck();expect(await dialog.locator('[data-action="confirm-pane-restart-batch"]').isDisabled()).toBe(true);
    await box.check();
    await dialog.locator('[data-action="confirm-pane-restart-batch"]').click();
    expect(await page.evaluate(()=>window.reviewCommands)).toEqual([{kind:'pane-restart-batch',trustScreen:true,items:[{sessionId:'pane',paneId:'pane-A'}]}]);
    await page.evaluate(()=>new Promise<void>(resolve=>{window.addEventListener('review-render',()=>resolve(),{once:true});window.reviewChange('server');}));
    expect(await dialog.locator('[data-action="confirm-pane-restart-batch"]').isDisabled()).toBe(true);
    await dialog.locator('[data-action="confirm-pane-restart-batch"]').evaluate((button:HTMLButtonElement)=>button.click());
    expect(await page.evaluate(()=>window.reviewCommands.length)).toBe(1);
  }finally{await page.close();}
});
test('disabled History cannot open recovery or send transport',async()=>{
  const page=await browser.newPage({locale:'en-US'});try{const button=await open(page,'history',true);expect(await button.isDisabled()).toBe(true);await button.evaluate((button:HTMLButtonElement)=>button.click());expect(await page.locator('.app-dialog[open]').count()).toBe(0);expect(await page.evaluate(()=>window.reviewCommands)).toEqual([]);}finally{await page.close();}
});
test('History becoming disabled invalidates its open recovery confirmation',async()=>{
  const page=await browser.newPage({locale:'en-US'});try{await (await open(page,'history')).click();await page.evaluate(()=>new Promise<void>(resolve=>{window.addEventListener('review-render',()=>resolve(),{once:true});window.reviewChange('disabled');}));const button=page.locator('.app-dialog[open] .dialog-body button').last();expect(await button.isDisabled()).toBe(true);await button.evaluate((button:HTMLButtonElement)=>button.click());expect(await page.evaluate(()=>window.reviewCommands)).toEqual([]);}finally{await page.close();}
});
for(const kind of ['pane','native','managed','history'] as const)test(kind+' unchanged review sends exactly its command',async()=>{
  const page=await browser.newPage({locale:'en-US'});try{await (await open(page,kind)).click();expect(await page.evaluate(()=>window.reviewCommands)).toEqual([]);await page.locator('.app-dialog[open] .dialog-body button').last().click();const commands=await page.evaluate(()=>window.reviewCommands);expect(commands).toHaveLength(1);expect(commands[0]?.kind).toBe(kind==='pane'?'pane-restart':kind==='native'?'native-restart':kind==='managed'?'restart':'catalog-update-recover');}finally{await page.close();}
});
