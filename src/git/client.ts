import { AppError } from '../contracts/base.js';
import { spawn } from 'node:child_process';

export interface GitRunOptions {signal?:AbortSignal;timeoutMs?:number;privateIndex?:string;commitDate?:string;input?:string|Buffer;binary?:boolean;processToken?:string;onSpawn?:(pid:number)=>Promise<void>}
export interface GitResult { stdout: string; stderr: string; exitCode: number;stdoutBytes?:Buffer }
/** Git arguments go directly to the executable; no command shell is involved. */
export class GitClient {
  run(cwd: string, args: string[], options:GitRunOptions={}): Promise<GitResult> {
    return new Promise((resolve, reject) => {
      const env:NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
      // A parent Git hook or shell must not redirect the isolated control repository.
      for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) delete env[key as keyof typeof env];
      if(options.processToken)env.LORECREW_PROCESS_TOKEN=options.processToken;
      env.GIT_NO_LAZY_FETCH='1';
      if(options.privateIndex)env.GIT_INDEX_FILE=options.privateIndex;
      if(options.commitDate){env.GIT_AUTHOR_DATE=options.commitDate;env.GIT_COMMITTER_DATE=options.commitDate;}
      if(options.signal?.aborted){reject(new AppError('GIT_CANCELLED','Git operation interrupted; remote outcome requires fresh confirmation'));return;}
      const child = spawn('git', args, { cwd, shell: false, env, detached:process.platform!=='win32', stdio: ['pipe', 'pipe', 'pipe'] });
      const launched=child.pid&&options.onSpawn?options.onSpawn(child.pid):Promise.resolve();
      child.stdin.on('error',()=>{});child.stdin.end(options.input);
      let interrupted=false;const cancel=()=>{interrupted=true;try{if(process.platform!=='win32'&&child.pid)process.kill(-child.pid,'SIGKILL');else child.kill('SIGKILL');}catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')child.kill('SIGKILL');}};const timeout=setTimeout(cancel,options.timeoutMs??(args.some(arg=>['fetch','push','ls-remote'].includes(arg))?30_000:120_000));timeout.unref();options.signal?.addEventListener('abort',cancel,{once:true});if(options.signal?.aborted)cancel();
      if(!options.binary)child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
      let stdout = ''; let stderr = '';const chunks:Buffer[]=[];
      child.stdout.on('data', chunk => { if(options.binary)chunks.push(chunk);else stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.on('error', reject);
      child.on('close', async code => {try{await launched;}catch(error){reject(error);return;}clearTimeout(timeout);options.signal?.removeEventListener('abort',cancel);if(options.signal?.aborted)reject(new AppError('GIT_CANCELLED','Git operation interrupted; remote outcome requires fresh confirmation'));else if(interrupted)reject(new AppError('GIT_TIMEOUT','Git deadline expired; remote outcome requires fresh confirmation'));else resolve({ stdout, stderr, exitCode: code ?? 1,...options.binary?{stdoutBytes:Buffer.concat(chunks)}:{} });});
    });
  }
}
