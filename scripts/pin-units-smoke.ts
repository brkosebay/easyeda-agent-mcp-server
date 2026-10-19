import assert from 'node:assert/strict';
// Fake board: components at mil origins with pins ±40 mil away, reported raw
// either in mil (EasyEDA 3.x) or 10-mil units (2.x).
function fakeEda(pinUnitDivisor: number, components: Array<{ id: string; x: number; y: number }>) {
 return {pcb_PrimitiveComponent:{
  getAll: async () => components.map(c => ({getState_PrimitiveId:()=>c.id,getState_X:()=>c.x,getState_Y:()=>c.y})),
  getAllPinsByPrimitiveId: async (id: string) => {
   const c = components.find(component => component.id === id)!;
   return [[-40,0],[40,0],[0,25]].map(([dx,dy]) => ({getState_X:()=>(c.x+dx)/pinUnitDivisor,getState_Y:()=>(c.y+dy)/pinUnitDivisor}));
  },
 }};
}
async function probe(eda: unknown) {
 (globalThis as any).eda = eda;
 const modulePath = require.resolve('../src/extension/handlers/pin-units');
 delete require.cache[modulePath]; // fresh session cache per scenario
 const {componentPinScale} = await import('../src/extension/handlers/pin-units');
 return componentPinScale();
}
async function main(){
 const board = [{id:'near-origin',x:3,y:-2},{id:'u1',x:400.6,y:-1321},{id:'j1',x:151.6,y:-980},{id:'f1',x:234.3,y:-1063}];
 assert.equal(await probe(fakeEda(1, board)), 1, 'EasyEDA 3.x: pins already mil');
 assert.equal(await probe(fakeEda(10, board)), 10, 'EasyEDA 2.x: pins in 10-mil units');
 assert.equal(await probe(fakeEda(10, [])), 1, 'empty board: nothing to convert');
 assert.equal(await probe(fakeEda(10, [{id:'only-origin',x:0,y:0}])), 1, 'no component far enough from origin to decide');
 console.log('Component-pin unit probe: 3.x mil, 2.x 10-mil, empty and undecidable boards: passed.');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
