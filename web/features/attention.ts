import type {InboxItem} from '../../src/attention/types.js';
export type AttentionItem=InboxItem;
export type SeenMarker={id:string;revision:string};
/** Only exact result reads matter. Action resolution belongs to the canonical work. */
export function isAcknowledged(item:AttentionItem,markers:SeenMarker[]){return item.class==='result'&&markers.some(m=>m.id===item.id&&m.revision===item.revision);}
