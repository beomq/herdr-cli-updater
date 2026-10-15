import { expect, test } from 'bun:test';
import { chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { browserSessions, browserSessionSeconds } from '../../src/app/browser-auth';

test('browser grants survive reload but are unique and bound to their state directory',()=>{
  const root=mkdtempSync('/tmp/browser-auth-');
  try{
    const first=browserSessions(root,()=>1000),grant=first.issue();
    expect(first.issue()).not.toBe(grant);
    const restarted=browserSessions(root,()=>2000);
    expect(restarted.accepts(grant)).toBe(true);
    const other=join(root,'other');mkdirSync(other,{mode:0o700});
    expect(browserSessions(other,()=>2000).accepts(grant)).toBe(false);
    expect(statSync(join(root,'browser-auth.json')).mode&0o777).toBe(0o600);
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('expired, modified and unsigned browser grants are rejected',()=>{
  const root=mkdtempSync('/tmp/browser-auth-');
  let now=1000;
  try{
    const sessions=browserSessions(root,()=>now),grant=sessions.issue();
    const [expiry,nonce,signature]=grant.split('.');
    expect(sessions.accepts(`${Number(expiry)+1000}.${nonce}.${signature}`)).toBe(false);
    expect(sessions.accepts(`${expiry}.${'0'.repeat(32)}.${signature}`)).toBe(false);
    expect(sessions.accepts(`${expiry}.${nonce}.${'0'.repeat(64)}`)).toBe(false);
    expect(sessions.accepts('0'.repeat(64))).toBe(false);
    now+=browserSessionSeconds*1000-1;expect(sessions.accepts(grant)).toBe(true);
    now++;expect(sessions.accepts(grant)).toBe(false);
  }finally{rmSync(root,{recursive:true,force:true});}
});

test.each(['permissions','symlink','hardlink','malformed'] as const)('unsafe auth storage %s fails closed without rotating the key',kind=>{
  const root=mkdtempSync('/tmp/browser-auth-'),path=join(root,'browser-auth.json');
  try{
    browserSessions(root);
    if(kind==='permissions')chmodSync(path,0o644);
    if(kind==='symlink'){const other=join(root,'other');writeFileSync(other,readFileSync(path),{mode:0o600});rmSync(path);symlinkSync(other,path);}
    if(kind==='hardlink')linkSync(path,join(root,'alias'));
    if(kind==='malformed')writeFileSync(path,'invalid');
    const before=readFileSync(path);
    expect(()=>browserSessions(root)).toThrow();
    expect(readFileSync(path)).toEqual(before);
  }finally{rmSync(root,{recursive:true,force:true});}
});
