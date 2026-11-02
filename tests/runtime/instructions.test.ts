import { expect,it } from 'vitest';
import { runCli } from '../../src/cli.js';
import { SessionInputSchema } from '../../src/api/schemas.js';
import { Value } from 'typebox/value';
it('accepts ordinary session requests and strictly refuses obsolete mode fields',()=>{expect(Value.Check(SessionInputSchema,{agentId:'piren'})).toBe(true);expect(Value.Check(SessionInputSchema,{agentId:'piren',mode:'read'})).toBe(false);});
it('rejects obsolete CLI mode as usage before opening state',async()=>{await expect(runCli(['session','create','--mode','read','--agent','piren','--request-id','obsolete'])).rejects.toMatchObject({code:'USAGE'});});
