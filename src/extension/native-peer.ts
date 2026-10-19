import {answerNativeChallenge,NativeAuthenticatedChannel,type NativeChallenge} from '../shared/native-auth';
declare const __NATIVE_DAEMON_TOKEN_PATH__: string;
const peers = new Map<number, NativeAuthenticatedChannel>();
export const NATIVE_TOKEN_PATH_KEY='nativeDaemonCredentialPath';
const TOKEN_RE=/^[a-f0-9]{64}$/;
const ABSOLUTE_PATH_RE=/^(\/|[A-Za-z]:[\\/])/;
export function nativePeerAuthenticated(port:number) {return peers.has(port);}
export function forgetNativePeer(port:number) {peers.delete(port);}

/** Error carrying the handshake stage, so failures can be reported to the user and the daemon. */
export class NativeHandshakeError extends Error {
 constructor(public stage:string,message:string) {super(message);this.name='NativeHandshakeError';}
}

function configuredTokenPath():string|undefined {
 try {
  const configured=eda.sys_Storage.getExtensionUserConfig(NATIVE_TOKEN_PATH_KEY);
  return typeof configured==='string'&&configured.trim() ? configured.trim() : undefined;
 } catch { return undefined; }
}
function embeddedTokenPath():string|undefined {
 return typeof __NATIVE_DAEMON_TOKEN_PATH__==='string'&&__NATIVE_DAEMON_TOKEN_PATH__ ? __NATIVE_DAEMON_TOKEN_PATH__ : undefined;
}

export function getNativeTokenPath(): string {
 return configuredTokenPath() ?? embeddedTokenPath() ?? '';
}

/**
 * EasyEDA Pro 2.2.x (pro-api 0.2.29) asks the Electron main process for
 * `{path, encoding:'base64'}` but the main-process handler only honours
 * `options.encoding`, so it returns the file as plain UTF-8 text — which the
 * renderer then base64-decodes. A 64-hex token is valid base64, so the File
 * we get holds 48 garbage bytes. Re-encoding those bytes with btoa() restores
 * the original text exactly. Accept either form so a fixed runtime also works.
 */
async function fileToToken(file:Blob):Promise<string|undefined> {
 const bytes=new Uint8Array(await file.arrayBuffer());
 let asText='';
 for (const b of bytes) asText+=String.fromCharCode(b);
 if (TOKEN_RE.test(asText.trim())) return asText.trim();
 try {
  const reencoded=btoa(asText).trim();
  if (TOKEN_RE.test(reencoded)) return reencoded;
 } catch {/* not recoverable */}
 return undefined;
}

/** Reads and validates a daemon token file through EasyEDA's client file API. */
export async function readNativeToken(path:string):Promise<string> {
 if(!ABSOLUTE_PATH_RE.test(path))throw new NativeHandshakeError('credential-path',`Credential path is not absolute: ${path}`);
 let file:Blob|undefined;
 try { file=await eda.sys_FileSystem.readFileFromFileSystem(path); }
 catch(error){throw new NativeHandshakeError('credential-read',`Cannot read ${path}: ${error instanceof Error?error.message:String(error)} (enable "External Interactions" for this extension in Extension Manager)`);}
 if(!file)throw new NativeHandshakeError('credential-read',`Cannot read ${path} (file missing or unreadable).`);
 if(file.size>1024)throw new NativeHandshakeError('credential-format',`${path} is too large to be a daemon token.`);
 const token=await fileToToken(file);
 if(!token)throw new NativeHandshakeError('credential-format',`${path} does not contain a 64-hex daemon token.`);
 return token;
}

/**
 * Release builds embed no path (it would be the builder's home). Derive the
 * daemon's default ~/.easyeda-mcp/token from the OS Documents folder, whose
 * parent is the home directory on standard macOS/Windows/Linux setups. Needs
 * "External Interactions", like the token read itself.
 */
async function derivedTokenPath():Promise<string|undefined> {
 try {
  const docs=await (eda.sys_FileSystem as any).getDocumentsPath?.();
  if(typeof docs!=='string'||!ABSOLUTE_PATH_RE.test(docs))return undefined;
  const sep=docs.includes('\\')&&!docs.includes('/')?'\\':'/';
  const home=docs.replace(/[\\/]+$/,'').replace(/[\\/][^\\/]+$/,'');
  return home&&ABSOLUTE_PATH_RE.test(home+sep)?`${home}${sep}.easyeda-mcp${sep}token`:undefined;
 } catch { return undefined; }
}

async function loadSecret():Promise<string> {
 const candidates=[configuredTokenPath(),embeddedTokenPath(),await derivedTokenPath()].filter((p,i,a):p is string=>!!p&&a.indexOf(p)===i);
 if(!candidates.length)throw new NativeHandshakeError('credential-path','No daemon credential path configured. Use Claude → "Configure protected bridge..." and enter ~/.easyeda-mcp/token as an absolute path.');
 let last:unknown;
 for(const path of candidates){
  try{return await readNativeToken(path);}catch(error){last=error;}
 }
 throw last instanceof Error ? last : new NativeHandshakeError('credential-read',String(last));
}

export async function decodeNativeMessage(port:number,instanceId:string,frame:unknown,reply:(message:string)=>void):Promise<unknown|undefined> {
 if(frame && typeof frame==='object' && (frame as {type?:unknown}).type==='native-auth-challenge') {
  if(peers.has(port))throw new NativeHandshakeError('challenge','Native peer attempted to replace an authenticated generation.');
  const secret=await loadSecret();
  const challenge=frame as NativeChallenge;
  let response;
  try{response=await answerNativeChallenge(secret,instanceId,challenge);}
  catch(error){
   const message=error instanceof Error?error.message:String(error);
   // Only a MAC mismatch means the tokens differ; anything else is a runtime fault.
   const hint=message==='Native daemon authentication failed.'?` (the daemon on port ${port} uses a different token than the file this extension reads)`:'';
   throw new NativeHandshakeError('challenge',`${message}${hint}`);
  }
  peers.set(port,new NativeAuthenticatedChannel(secret,challenge.epoch,'extension'));
  reply(JSON.stringify(response));return undefined;
 }
 const peer=peers.get(port);
 return peer ? peer.decode(frame) : frame;
}
export async function encodeNativeMessage(port:number,value:unknown):Promise<string> {
 const peer=peers.get(port);
 return peer ? peer.encode(value) : JSON.stringify(value);
}
