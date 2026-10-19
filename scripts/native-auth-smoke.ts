import assert from 'node:assert/strict';
import {createNativeChallenge,answerNativeChallenge,NativeAuthenticatedChannel,nativeMac} from '../src/shared/native-auth';
async function main(){
 const secret='ab'.repeat(32),challenge=await createNativeChallenge(secret,'instance');
 const answer=await answerNativeChallenge(secret,'instance',challenge);
 assert.equal(answer.mac,await nativeMac(secret,['extension-response','instance',challenge.epoch,challenge.nonce]));
 await assert.rejects(answerNativeChallenge('cd'.repeat(32),'instance',challenge));
 await assert.rejects(answerNativeChallenge(secret,'other',challenge));
 const daemon=new NativeAuthenticatedChannel(secret,challenge.epoch,'daemon');
 const extension=new NativeAuthenticatedChannel(secret,challenge.epoch,'extension');
 const frames=await Promise.all([daemon.encode({id:1}),daemon.encode({id:2})]);
 assert.deepEqual(await extension.decode(JSON.parse(frames[0])),{id:1});
 await assert.rejects(extension.decode(JSON.parse(frames[0])),/replayed/);
 const changed=JSON.parse(frames[1]);changed.body='{"id":3}';
 await assert.rejects(extension.decode(changed),/authentication/);
 assert.deepEqual(await extension.decode(JSON.parse(frames[1])),{id:2});
 const old=new NativeAuthenticatedChannel(secret,'another-epoch','extension');
 await assert.rejects(old.decode(JSON.parse(frames[0])));
 await assert.rejects(daemon.decode(JSON.parse(frames[0])));
 await assert.rejects(extension.decode({id:3}));
 console.log('Native mutual authentication, role separation, tamper/replay and reconnect fencing: passed.');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
