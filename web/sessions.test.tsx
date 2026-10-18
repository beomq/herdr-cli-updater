import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AppSnapshot, ExternalSession } from '../src/app/types';
import { Surface } from './app';

const external=(id:string,family='omo',fields:Partial<ExternalSession>={}):ExternalSession=>({id,family,pid:123,installationId:null,catalogId:'omo',executable:'/copies/'+id+'/omo',cwd:'/project/'+id,runningVersion:null,startedAt:'2026-01-01T00:00:00Z',control:'herdr-pane',herdrPane:{paneId:id,status:'idle',stateChangeSeq:1},conversation:{id:'conversation',title:null,path:'/conversation'},...fields});
const base:AppSnapshot={revision:1,service:'ready',failure:null,installations:[],managed:[],operations:[],policies:[],external:[]};
const render=(model:AppSnapshot)=>renderToStaticMarkup(<Surface snapshot={model} view="sessions" onView={()=>{}} act={async()=>{throw new Error('render must not send a command');}} disabled={false}/>);
const card=(html:string,id:string)=>html.match(new RegExp('<section class="panel"[^>]*data-session-id="'+id+'"[\\s\\S]*?</section>'))?.[0]??'';

test('catalog update for installation A never marks same-family B changed',()=>{
  const model:AppSnapshot={...base,external:[external('a'),external('b')],catalogUpdates:[{id:'job',requestId:'request',catalogId:'omo',revision:1,stage:'completed',target:{kind:'owned',target:'/copies/a',executable:'/copies/a/omo',fingerprint:'fp',preserve:[]},createdAt:0,updatedAt:Date.parse('2026-01-02'),beforeVersion:'1',installedVersion:'2',failure:null}]};
  const html=render(model);
  expect(card(html,'a')).toContain('data-installation-changed="true"');
  expect(card(html,'b')).toContain('data-installation-changed="false"');
});
test('unsupported restart contracts expose no restart controls',()=>{
  for(const family of ['pi','senpi','gjc','opencode']){
    const html=render({...base,external:[external(family,family)]});
    expect(card(html,family)).not.toBe('');
    expect(card(html,family)).not.toContain('<button');
  }
});
test('unknown activity ambiguous OmO and blocked panes cannot restart',()=>{
  for(const fields of [{omoActivity:'unknown' as const},{conversation:null},{herdrPane:{paneId:'a',status:'blocked' as const,stateChangeSeq:1}}]){
    const html=render({...base,external:[external('a','omo',fields)]});
    expect(card(html,'a').match(/<button[^>]*data-action="review-pane-restart"[^>]*>/)?.[0]).toContain('disabled');
  }
});
test('unknown OmO activity offers only the screen-based restart while herdr, the screen and the cpu are quiet',()=>{
  const quiet={paneId:'a',status:'idle' as const,stateChangeSeq:1,screenIdle:true,cpuQuiet:true};
  const html=card(render({...base,external:[external('a','omo',{omoActivity:'unknown',herdrPane:quiet})]}),'a');
  expect(html.match(/<button[^>]*data-action="review-pane-restart"[^>]*>/)?.[0]).toContain('disabled');
  const screen=html.match(/<button[^>]*data-action="review-screen-restart"[^>]*>/)?.[0];
  expect(screen).toBeDefined();expect(screen).not.toContain('disabled');
  for(const pane of [{...quiet,status:'working' as const},{...quiet,status:'unknown' as const},{...quiet,screenIdle:false},{...quiet,screenIdle:null},{...quiet,cpuQuiet:false}]){
    const button=card(render({...base,external:[external('a','omo',{omoActivity:'unknown',herdrPane:pane})]}),'a').match(/<button[^>]*data-action="review-screen-restart"[^>]*>/)?.[0];
    expect(button===undefined||button.includes('disabled')).toBe(true);
  }
});
test('one batch review button counts only outdated panes that can restart now, by either rule',()=>{
  const quiet={status:'idle' as const,stateChangeSeq:1,screenIdle:true,cpuQuiet:true};
  const outdated=(id:string,fields:Partial<ExternalSession>={})=>external(id,'omo',{processState:'observed',runningVersion:'1.0.0',runningVersionEvidence:'launch-environment',diskPackage:{name:'omo-ai',version:'2.0.0',installedAt:1},herdrPane:{paneId:id,...quiet},...fields});
  const html=render({...base,observedAt:10,external:[
    outdated('screen',{omoActivity:'unknown'}),
    outdated('engine-idle',{omoActivity:'idle',herdrPane:{paneId:'engine-idle',status:'idle',stateChangeSeq:1}}),
    outdated('current',{runningVersion:'2.0.0',omoActivity:'idle'}),
    outdated('working',{omoActivity:'working',herdrPane:{paneId:'working',status:'working',stateChangeSeq:1}}),
    outdated('unknown-no-hint',{omoActivity:'unknown',herdrPane:{paneId:'unknown-no-hint',status:'idle',stateChangeSeq:1}}),
    outdated('blocked',{omoActivity:'blocked'}),
    outdated('no-conversation',{omoActivity:'idle',conversation:null}),
  ]});
  const button=html.match(/<button[^>]*data-action="review-pane-restart-batch"[^>]*>/)?.[0];
  expect(button).toBeDefined();expect(button).toContain('data-count="2"');expect(button).not.toContain('disabled');
  expect(render({...base,observedAt:10,external:[outdated('current',{runningVersion:'2.0.0',omoActivity:'idle'})]})).not.toContain('review-pane-restart-batch');
});
test('running evidence stays independent of activity and engine details',()=>{
  const html=render({...base,external:[external('a','omo',{omoActivity:'working',runningVersion:'1.2.3',runningVersionEvidence:'started-after-install',runningEngineVersion:'internal-9.9'})]});
  expect(card(html,'a')).toContain('data-activity="working"');
  expect(card(html,'a')).toContain('data-version-evidence="started-after-install"');
  expect(card(html,'a').match(/data-evidence="running-version">([^<]+)/)?.[1]).toBe('1.2.3');
  expect(card(html,'a').split('<details>')[0]).not.toContain('internal-9.9');
});
