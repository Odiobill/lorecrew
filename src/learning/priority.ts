/** Permits are operation boundaries, not recovery state. The supplied wait must persist in Pi. */
export class PriorityGate {
 private runnable=false;
 constructor(private readonly readiness:()=>Promise<boolean>,private readonly wait:()=>Promise<void>){}
 foregroundRunnable(){return this.runnable;}
 async refresh(){this.runnable=await this.readiness();return this.runnable;}
 async enter(kind:'foreground'|'background'):Promise<{release():void}>{
  if(kind==='background')while(await this.refresh())await this.wait();
  return {release(){}};
 }
}
