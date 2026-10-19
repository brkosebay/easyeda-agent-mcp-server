import type { WebSocket } from 'ws';
import {createNativeChallenge,NativeAuthenticatedChannel,nativeMac,sameMac} from '../shared/native-auth';

/** Peer identity is established before it can replace an existing instance. */
export async function authenticateNativeSocket(ws:WebSocket,secret:string,instanceId:string):Promise<NativeAuthenticatedChannel> {
 const challenge=await createNativeChallenge(secret,instanceId);
 return new Promise((resolve,reject)=>{
  const fail=(error:Error)=>{cleanup();reject(error);};
  const onClose=(code?:number,reason?:unknown)=>fail(new Error(`Native peer closed before authentication (code ${code ?? '?'}${reason && String(reason) ? `, ${String(reason)}` : ''}). An extension that closes without answering could not read or use its credential — older builds send no reason.`));
  const onMessage=async(data:unknown)=>{
   try{
    const text=String(data);
    if(text.length>4096)throw new Error('Invalid native authentication response.');
    const message=JSON.parse(text);
    if(message && message.type==='native-auth-error') {
     const stage=typeof message.stage==='string'?message.stage.slice(0,40):'unknown';
     const detail=typeof message.message==='string'?message.message.slice(0,500):'(no detail)';
     throw new Error(`Extension rejected the handshake at stage "${stage}": ${detail}`);
    }
    if(message.type!=='native-auth-response' || !sameMac(message.mac,await nativeMac(secret,['extension-response',instanceId,challenge.epoch,challenge.nonce])))throw new Error('Native peer authentication failed.');
    cleanup();resolve(new NativeAuthenticatedChannel(secret,challenge.epoch,'daemon'));
   }catch(error){fail(error instanceof Error?error:new Error(String(error)));}
  };
  const timer=setTimeout(()=>fail(new Error('Native peer authentication timed out.')),9000);
  const cleanup=()=>{clearTimeout(timer);ws.off('message',onMessage);ws.off('close',onClose);};
  ws.on('message',onMessage);ws.once('close',onClose);
  try{ws.send(JSON.stringify(challenge));}catch(error){fail(error instanceof Error?error:new Error(String(error)));}
 });
}
