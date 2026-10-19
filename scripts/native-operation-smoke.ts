import assert from 'node:assert/strict';
import { callWithTimeout, withTimeout, didTimeOut } from '../src/extension/handlers/_utils';
import { createNativeOperationState, createNativeOperationGate, boundedNativeOperation, nativeOperationStatus, acknowledgeNativeOperation, nativeOperationState } from '../src/extension/native-operation-gate';
async function main() {
 for(const failLate of [false,true]) {
  const state=createNativeOperationState(),gate=createNativeOperationGate(state),reconnected=createNativeOperationGate(state);
  let finish!:()=>void;
  let nextRan=false;
  const native=new Promise<void>((resolve,reject)=>{finish=()=>failLate?reject(new Error('late')):resolve();});
  const first=gate(true,()=>boundedNativeOperation('test mutation',()=>native,5,state));
  const firstCheck=assert.rejects(first,/native operation may still be running/);
  const queuedCheck=assert.rejects(gate(false,async()=>{nextRan=true;}),/requires reconciliation/);
  await Promise.all([firstCheck,queuedCheck]);
  assert.equal(nativeOperationStatus(state).uncertain?.outcome,'pending');
  assert.throws(()=>acknowledgeNativeOperation(state.uncertain!.id,state),/still pending/);
  await assert.rejects(reconnected(false,async()=>{nextRan=true;}),/requires reconciliation/);
  finish();await Promise.resolve();await Promise.resolve();
  assert.equal(nativeOperationStatus(state).uncertain?.outcome,failLate?'rejected':'fulfilled');
  await assert.rejects(gate(true,async()=>{nextRan=true;}),/requires reconciliation/);
  assert.equal(nextRan,false);
  assert.throws(()=>acknowledgeNativeOperation(-1,state),/stale/);
  acknowledgeNativeOperation(state.uncertain!.id,state);
  assert.equal(await gate(false,async()=>42),42);
 }
 const state=createNativeOperationState(),gate=createNativeOperationGate(state),order:number[]=[];
 await Promise.all([gate(false,async()=>{order.push(1);await Promise.resolve();order.push(2);}),gate(false,async()=>{order.push(3);})]);
 assert.deepEqual(order,[1,2,3]);
 await assert.rejects(gate(true,async()=>{throw new Error('ordinary failure');}));
 assert.equal(await gate(false,async()=>42),42);
 // Legacy helper sentinels must not reopen the document gate.
 for (const helper of [withTimeout, (p: Promise<void>, ms: number) => callWithTimeout(() => p, ms)]) {
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  assert.equal(didTimeOut(await helper(pending, 2)), true);
  let called = false;
  await assert.rejects(callWithTimeout(async () => { called = true; }, 5), /requires reconciliation/);
  assert.equal(called, false);
  finish(); await Promise.resolve(); await Promise.resolve();
  acknowledgeNativeOperation(nativeOperationState.uncertain!.id);
 }
 // An overlapping nested deadline cannot hide another still-running operation.
 const nested = createNativeOperationState();
 let finishA!: () => void, finishB!: () => void;
 const a = boundedNativeOperation('a', () => new Promise<void>(r => { finishA = r; }), 2, nested);
 const b = boundedNativeOperation('b', () => new Promise<void>(r => { finishB = r; }), 4, nested);
 await Promise.all([assert.rejects(a), assert.rejects(b)]);
 const uncertainId = nested.uncertain!.id;
 finishA(); await Promise.resolve(); await Promise.resolve();
 assert.throws(() => acknowledgeNativeOperation(uncertainId, nested), /still pending/);
 finishB(); await Promise.resolve(); await Promise.resolve();
 acknowledgeNativeOperation(uncertainId, nested);
 console.log('Native deadline quarantine, shared reconnect state and context serialization: passed.');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
