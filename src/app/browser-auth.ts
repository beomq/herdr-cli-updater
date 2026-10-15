import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { AppError } from './types';

const keySchema=z.object({version:z.literal(1),key:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export const browserSessionSeconds=30*24*60*60;

/** Private per-workspace signing key; browser grants outlive the server process. */
export function browserSessions(directory:string,now:()=>number=Date.now){
  const path=join(directory,'browser-auth.json');
  let fd:number,created=false;
  try{fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);}
  catch(error){
    if(!(error instanceof Error&&'code' in error&&error.code==='ENOENT'))throw new AppError('unauthorized','browser_auth_file_unsafe');
    fd=openSync(path,'wx+',0o600);created=true;
  }
  let key:string;
  try{
    const stat=fstatSync(fd);
    if(!stat.isFile()||stat.uid!==process.getuid?.()||(stat.mode&0o777)!==0o600||stat.nlink!==1)
      throw new AppError('unauthorized','browser_auth_file_unsafe');
    if(created){
      key=randomBytes(32).toString('hex');
      writeFileSync(fd,JSON.stringify({version:1,key}));fsyncSync(fd);
    }else{
      const parsed=keySchema.safeParse(JSON.parse(readFileSync(fd,'utf8')));
      if(!parsed.success)throw new AppError('unauthorized','browser_auth_file_invalid');
      key=parsed.data.key;
    }
  }catch(error){
    if(error instanceof SyntaxError)throw new AppError('unauthorized','browser_auth_file_invalid');
    throw error;
  }finally{closeSync(fd);}
  const sign=(body:string)=>createHmac('sha256',key).update(body).digest('hex');
  return {
    issue():string{
      const body=`${now()+browserSessionSeconds*1000}.${randomBytes(16).toString('hex')}`;
      return `${body}.${sign(body)}`;
    },
    accepts(value:string):boolean{
      const match=/^(\d{1,16})\.([a-f0-9]{32})\.([a-f0-9]{64})$/.exec(value);
      if(!match)return false;
      const [,expiry,nonce,signature]=match;
      if(!expiry||!nonce||!signature||!Number.isSafeInteger(Number(expiry))||Number(expiry)<=now())return false;
      return timingSafeEqual(Buffer.from(signature),Buffer.from(sign(`${expiry}.${nonce}`)));
    },
  };
}
