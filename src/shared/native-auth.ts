/** Authenticates local native peers and fences messages to one socket generation. */
import {hmacSha256} from './hmac-sha256';
const encoder = new TextEncoder();
const MAX_BODY = 96 * 1024 * 1024;
export const randomNonce = () => Array.from(crypto.getRandomValues(new Uint8Array(24)), b => b.toString(16).padStart(2,'0')).join('');
export async function nativeMac(secret: string, parts: readonly (string | number)[]): Promise<string> {
 if (!/^[a-f0-9]{64}$/.test(secret)) throw new Error('Invalid native peer credential.');
 const keyBytes = encoder.encode(secret), message = encoder.encode(JSON.stringify(['easyeda-native-v1',...parts]));
 // EasyEDA Pro 3.x extensions get crypto.getRandomValues but no crypto.subtle.
 const subtle = (globalThis as {crypto?: Crypto}).crypto?.subtle;
 let bytes: Uint8Array;
 if (subtle) {
  const key = await subtle.importKey('raw', keyBytes, {name:'HMAC',hash:'SHA-256'}, false, ['sign']);
  bytes = new Uint8Array(await subtle.sign('HMAC',key,message));
 } else bytes = hmacSha256(keyBytes, message);
 return Array.from(bytes, b=>b.toString(16).padStart(2,'0')).join('');
}
export function sameMac(a:unknown,b:string) {
 if(typeof a!=='string' || a.length!==b.length)return false;
 let difference=0;
 for(let i=0;i<a.length;i++)difference|=a.charCodeAt(i)^b.charCodeAt(i);
 return difference===0;
}
export interface NativeChallenge {type:'native-auth-challenge';instanceId:string;epoch:string;nonce:string;mac:string}
export async function createNativeChallenge(secret:string,instanceId:string):Promise<NativeChallenge> {
 const epoch=randomNonce(),nonce=randomNonce();
 return {type:'native-auth-challenge',instanceId,epoch,nonce,mac:await nativeMac(secret,['daemon-challenge',instanceId,epoch,nonce])};
}
export async function answerNativeChallenge(secret:string,instanceId:string,value:NativeChallenge) {
 if(value.instanceId!==instanceId || !/^[a-f0-9]{48}$/.test(value.epoch) || !/^[a-f0-9]{48}$/.test(value.nonce) || !sameMac(value.mac,await nativeMac(secret,['daemon-challenge',instanceId,value.epoch,value.nonce]))) throw new Error('Native daemon authentication failed.');
 return {type:'native-auth-response',mac:await nativeMac(secret,['extension-response',instanceId,value.epoch,value.nonce])};
}
export class NativeAuthenticatedChannel {
 private tx=0;
 private rx=0;
 private sends:Promise<unknown>=Promise.resolve();
 private receives:Promise<unknown>=Promise.resolve();
 constructor(private secret:string,private epoch:string,private side:'daemon'|'extension') {}
 encode(body:unknown):Promise<string> {
  const result=this.sends.then(async()=>{
   const payload=JSON.stringify(body);
   if(payload.length>MAX_BODY)throw new Error('Native message exceeds transport limit.');
   const sequence=++this.tx;
   return JSON.stringify({type:'native-authenticated',sequence,body:payload,mac:await nativeMac(this.secret,[`${this.side}-message`,this.epoch,sequence,payload])});
  });
  this.sends=result.catch(()=>undefined);return result;
 }
 decode(frame:unknown):Promise<unknown> {
  const result=this.receives.then(async()=>{
   if(!frame || typeof frame!=='object')throw new Error('Unauthenticated native message.');
   const value=frame as Record<string,unknown>;
   if(value.type!=='native-authenticated' || value.sequence!==this.rx+1 || typeof value.body!=='string' || value.body.length>MAX_BODY)throw new Error('Unauthenticated or replayed native message.');
   const peer=this.side==='daemon'?'extension':'daemon';
   if(!sameMac(value.mac,await nativeMac(this.secret,[`${peer}-message`,this.epoch,this.rx+1,value.body])))throw new Error('Native message authentication failed.');
   const body:unknown=JSON.parse(value.body);
   this.rx++;return body;
  });
  this.receives=result.catch(()=>undefined);return result;
 }
}
