import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseJlcedaNetlist} from '../src/extension/handlers/sch-netlist-utils';
// EasyEDA Pro 2.x shape: bare component map with flat pins.
const v2 = parseJlcedaNetlist(JSON.stringify({gge1:{props:{Designator:'R1'},pins:{'1':'VCC','2':'GND'}}}));
assert.deepEqual(v2.gge1.pins, {'1':'VCC','2':'GND'});
assert.equal(v2.gge1.props.Designator, 'R1');
// EasyEDA Pro 3.x shape ("version": "2.0.0"): {version, components} with pinInfoMap.
const v3 = parseJlcedaNetlist(JSON.stringify({version:'2.0.0',components:{gge105:{props:{Designator:'U10'},pinInfoMap:{
 '1':{name:'OUT',number:'1',net:'+3.3V',props:{}}, '3':{name:'GND',number:'3',net:'GND',props:{}},
}}}}));
assert.deepEqual(v3.gge105.pins, {'1':'+3.3V','3':'GND'});
assert.equal(Object.keys(v3).length, 1, 'version/components keys must not leak in as components');
// Optional: a real 3.x export (NETLIST_SAMPLE=path) — U10's OUT pin must be +3.3V.
if (process.env.NETLIST_SAMPLE) {
 const real = parseJlcedaNetlist(readFileSync(process.env.NETLIST_SAMPLE, 'utf8'));
 const u10 = Object.values(real).find(c => c.props.Designator === 'U10');
 assert.ok(u10, 'U10 present in sample');
 assert.equal(u10!.pins['1'], '+3.3V');
 const withNets = Object.values(real).filter(c => Object.values(c.pins).some(Boolean)).length;
 console.log(`Real 3.x sample: ${Object.keys(real).length} components, ${withNets} with pin nets; U10 pins ${JSON.stringify(u10!.pins)}`);
}
console.log('JLCEDA netlist parser: 2.x flat pins and 3.x pinInfoMap formats: passed.');
