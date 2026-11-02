import { useState } from 'react';
export function Login({connect,busy,offline}:{connect:(secret:string)=>Promise<void>;busy:boolean;offline:boolean}) {
  const [secret,setSecret]=useState('');
  return <main className="login"><p className="eyebrow">LORECREW / LOCAL TEAM</p><h1>Connect to your instance</h1><p>Enter the one-use login secret shown in your local terminal.</p><form onSubmit={event=>{event.preventDefault();void connect(secret);}}><label>Login secret<input type="password" autoComplete="off" value={secret} onChange={event=>setSecret(event.target.value)} required autoFocus disabled={busy||offline}/></label><button disabled={busy||offline}>Connect to instance</button></form><p className="muted">Your team keeps working when you close this browser.</p></main>;
}
