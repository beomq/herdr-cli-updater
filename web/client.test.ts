import { afterEach, expect, test } from 'bun:test';
import { AccessError, exchangeFragment, newerSnapshot, readSnapshot, sendCommand } from './client';
import type { AppSnapshot } from '../src/app/types';
const original = globalThis.fetch;
afterEach(()=>{globalThis.fetch=original;});
const snapshot:AppSnapshot={revision:1,service:'ready',installations:[],managed:[],external:[],operations:[],policies:[],failure:null};
test('a lost mutation response sends the intent exactly once',async()=>{
  const requests:string[]=[];
  globalThis.fetch=Object.assign(async (_url:unknown,init?:RequestInit)=>{requests.push(String(init?.body));throw new Error('connection lost');}, {preconnect:original.preconnect});
  await expect(sendCommand({kind:'prepare',installationId:'owned'},'intent-1')).rejects.toThrow();
  expect(requests).toEqual([JSON.stringify({requestId:'intent-1',command:{kind:'prepare',installationId:'owned'}})]);
});
test('typed failure keeps its snapshot and does not resend',async()=>{
  let count=0;
  globalThis.fetch=Object.assign(async()=>{count++;return Response.json({ok:false,error:'conflict',snapshot},{status:409});},{preconnect:original.preconnect});
  expect(await sendCommand({kind:'cancel',operationId:'owned',revision:1},'intent-2')).toEqual({ok:false,error:'conflict',snapshot});
  expect(count).toBe(1);
});
test('snapshot uses cookie auth and never performs a mutation',async()=>{
  let url:unknown;let options:RequestInit|undefined;
  globalThis.fetch=Object.assign(async(input:unknown,init?:RequestInit)=>{url=input;options=init;return Response.json(snapshot);},{preconnect:original.preconnect});
  expect(await readSnapshot()).toEqual(snapshot);expect(url).toBe('/api/state');expect(options).toEqual({credentials:'same-origin',cache:'no-store'});
});
test('expired cookie is an access error',async()=>{
  globalThis.fetch=Object.assign(async()=>new Response(null,{status:401}),{preconnect:original.preconnect});
  await expect(readSnapshot()).rejects.toBeInstanceOf(AccessError);
});
test('a restarted server replaces a higher revision from the previous process',()=>{
  const old={...snapshot,revision:999,serverInstance:'previous'};
  const restarted={...snapshot,revision:1,serverInstance:'next'};
  expect(newerSnapshot(old,restarted)).toBe(restarted);
  expect(newerSnapshot(old,{...old,revision:2})).toBe(old);
});
test('an older command response cannot overwrite a newer event from the same server',()=>{
  const event={...snapshot,serverInstance:'same-server',revision:12};
  const response={...snapshot,serverInstance:'same-server',revision:11};
  expect(newerSnapshot(event,response)).toBe(event);
});
test.each([true,false])('an expired URL uses an existing browser grant only when authorized: %s',async authorized=>{
  const locationDescriptor=Object.getOwnPropertyDescriptor(globalThis,'location');
  const historyDescriptor=Object.getOwnPropertyDescriptor(globalThis,'history');
  const requests:string[]=[];let replaced=false;
  Object.defineProperty(globalThis,'location',{configurable:true,value:{hash:'#token='+'a'.repeat(64),pathname:'/',search:''}});
  Object.defineProperty(globalThis,'history',{configurable:true,value:{replaceState:()=>{replaced=true;}}});
  globalThis.fetch=Object.assign(async(input:unknown)=>{
    requests.push(String(input));
    return input==='/api/state'&&authorized?Response.json(snapshot):new Response(null,{status:401});
  },{preconnect:original.preconnect});
  try{
    if(authorized)await exchangeFragment();else await expect(exchangeFragment()).rejects.toBeInstanceOf(AccessError);
    expect(requests).toEqual(['/api/session','/api/state']);expect(replaced).toBe(true);
  }finally{
    if(locationDescriptor)Object.defineProperty(globalThis,'location',locationDescriptor);else Reflect.deleteProperty(globalThis,'location');
    if(historyDescriptor)Object.defineProperty(globalThis,'history',historyDescriptor);else Reflect.deleteProperty(globalThis,'history');
  }
});
