import {expect,it} from 'vitest';
import {isAcknowledged} from '../../web/features/attention.js';
const item={id:'task:work',revision:'r1',class:'result',kind:'completed',title:'Result',href:'#results/task%3Awork',source:{kind:'user_task',rootTaskId:'work'}};
it('read markers never hide outstanding actions',()=>{expect(isAcknowledged({...item,class:'action'} as any,[{id:item.id,revision:item.revision}])).toBe(false);});
it('read markers match the exact result revision',()=>{expect(isAcknowledged(item as any,[{id:item.id,revision:'r1'}])).toBe(true);expect(isAcknowledged({...item,revision:'r2'} as any,[{id:item.id,revision:'r1'}])).toBe(false);});
