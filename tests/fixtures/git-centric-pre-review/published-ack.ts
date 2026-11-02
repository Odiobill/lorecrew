// Historical acknowledgement producer frozen from 7fee606. It deliberately retains
// the pre-review crash gap; application code never imports this fixture.
import type {InstanceContext} from '../../../src/instance/open.js';
import type {GitClient} from '../../../src/git/client.js';
import type {Exporter,PublicationIntent} from '../../../src/export/types.js';
import type {PublicationReceipt} from '../../../src/repositories/types.js';
import type {LocalCommit} from '../../../src/sync/local-commits.js';
import type {CapturedBatch} from '../../../src/sync/watch.js';
export function preReviewPublishedAcknowledgement(ctx:InstanceContext,git:GitClient,exporter:Exporter){
 async function confirmPublished(receipt:PublicationReceipt){if(!receipt.confirmed)return;for(const local of await ctx.store.list<LocalCommit>('sync-local-commit')){
  if(local.published||!receipt.refs.some(ref=>ref.commit===local.checkpoint.commit)){
   if(local.published)continue;let found=false;for(const ref of receipt.refs)if((await git.run(ctx.vaultDir,['merge-base','--is-ancestor',local.checkpoint.commit,ref.commit])).exitCode===0)found=true;if(!found)continue;
  }
  await ctx.store.transact(tx=>tx.put('sync-local-commit',local.batchId,{...local,published:true}));if(await ctx.store.read<PublicationIntent>('export-batch',local.batchId))await exporter.acknowledge(local.batchId);else await ctx.store.transact(tx=>{const old=tx.get<CapturedBatch>('sync-captured',local.batchId);if(old)tx.put('sync-captured',local.batchId,{...old,acknowledged:true});});
 }}
 return confirmPublished;
}
