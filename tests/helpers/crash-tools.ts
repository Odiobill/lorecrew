import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Type } from '@earendil-works/pi-ai';
import { defineExtension, defineTool } from '@earendil-works/pi-durable';
export function crashTools(root:string,stage:string,crash:boolean) {
  return defineExtension({name:'crash-fixture',tools:[
    defineTool({name:'effect',description:'A journaled external effect',parameters:Type.Object({}),replay:'unsafe',async execute(){
      await appendFile(join(root,'effects.log'),'effect\n');
      if(crash && stage==='uncertain')process.kill(process.pid,'SIGKILL');
      return {output:[{type:'text',text:'completed effect'}]};
    }}),
    defineTool({name:'resume',description:'A safe continuation',parameters:Type.Object({}),replay:'safe',async execute(){
      if(crash)process.kill(process.pid,'SIGKILL');
      return {output:[{type:'text',text:'resumed journal'}]};
    }}),
  ]});
}
