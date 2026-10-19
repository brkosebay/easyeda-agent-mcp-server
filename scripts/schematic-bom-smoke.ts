import assert from 'node:assert/strict';
import {schExtractHandlers} from '../src/extension/handlers/sch-extract';
import {buildBom} from '../src/mcp-server/analyzers/bom';
(globalThis as any).ESYS_NetlistType={JLCEDA_PRO:'test'};
(globalThis as any).eda={
 dmt_Project:{getCurrentProjectInfo:async()=>({uuid:'test',name:'Fixture'})},
 dmt_SelectControl:{getCurrentDocumentInfo:async()=>({uuid:'page'})},
 dmt_Schematic:{getCurrentSchematicPageInfo:async()=>({uuid:'page'})},
 sch_PrimitiveComponent:{getAll:async()=>[{uniqueId:'c1',primitiveId:'p1',getState_Footprint:()=>({name:'',uuid:''})}],getAllPinsByPrimitiveId:async()=>[]},
 sch_Netlist:{getNetlist:async()=>({
   c1:{props:{Designator:'C1','Manufacturer Part':'CL31B106KBHNNNE',FootprintName:'C1206'},pins:{}},
   c13:{props:{Designator:'C13','Manufacturer Part':'CC0805JRNPO9BN100',Value:'CC0805JRNPO9BN100',FootprintName:'C0805'},pins:{}}
 })}
};
(async()=>{
 const snapshot=await schExtractHandlers['sch.extract.design']({allPages:true});
 const bom=buildBom(snapshot);
 assert.equal(bom.componentCount,2);
 assert.equal(snapshot.components.C1.footprint,'C1206');
 assert.equal(snapshot.components.C13.footprint,'C0805');
 assert.equal(snapshot.components.C13.value,undefined);
 assert.ok(bom.rows.every(row=>row.value==='' && !row.gaps.includes('footprint')));
 console.log('Schematic-to-BOM fixture: C1 footprint preserved; C13 MPN never becomes 100F.');
})().catch(error=>{console.error(error);process.exitCode=1;});
