import assert from 'node:assert/strict';
import {createHash,createHmac,randomBytes} from 'node:crypto';
import {hmacSha256,sha256} from '../src/shared/hmac-sha256';
import {nativeMac} from '../src/shared/native-auth';
const hex=(bytes:Uint8Array)=>Buffer.from(bytes).toString('hex');
async function main(){
 for(const length of [0,1,55,56,57,63,64,65,119,120,127,128,129,1000,100_000]){
  const data=randomBytes(length);
  assert.equal(hex(sha256(data)),createHash('sha256').update(data).digest('hex'),`sha256 length ${length}`);
  for(const keyLength of [0,16,64,65,200]){
   const key=randomBytes(keyLength);
   assert.equal(hex(hmacSha256(key,data)),createHmac('sha256',key).update(data).digest('hex'),`hmac key ${keyLength} data ${length}`);
  }
 }
 // nativeMac must match with and without WebCrypto, so a subtle-less extension agrees with the Node daemon.
 const secret='ab'.repeat(32),parts=['daemon-challenge','instance','e'.repeat(48),'n'.repeat(48)];
 const withSubtle=await nativeMac(secret,parts);
 const original=Object.getOwnPropertyDescriptor(globalThis,'crypto');
 Object.defineProperty(globalThis,'crypto',{value:{getRandomValues:(a:Uint8Array)=>a},configurable:true});
 try{assert.equal(await nativeMac(secret,parts),withSubtle);}
 finally{if(original)Object.defineProperty(globalThis,'crypto',original);}
 console.log('Pure-JS SHA-256/HMAC matches node:crypto; nativeMac agrees with and without crypto.subtle: passed.');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
