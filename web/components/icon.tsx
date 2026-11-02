const paths:Record<string,string>={
  projects:'M3 7V4h6l2 3h10v13H3V7Z',folder:'M3 7V4h6l2 3h10v13H3V7Z',save:'M4 3h13l4 4v14H3V3h1Zm3 0v6h10V3M7 21v-8h10v8',monitor:'M3 4h18v13H3V4Zm5 17h8m-4-4v4',sun:'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm0-6v2m0 16v2M2 12h2m16 0h2M5 5l1 1m12 12 1 1M5 19l1-1M18 6l1-1',moon:'M20 15A9 9 0 0 1 9 4a9 9 0 1 0 11 11Z',
  inbox:'M4 4h16v16H4V4Zm0 10h5l2 3h2l2-3h5',
  routines:'M12 8v4l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
  conversations:'M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5Z',
  agents:'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM4 21v-2a8 8 0 0 1 16 0v2',
  groups:'M16 21v-2a6 6 0 0 0-12 0v2M10 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM20 8a3 3 0 0 1 0 6m0 2a4 4 0 0 1 3 4',
  tasks:'m8 6 2 2 4-4M8 13l2 2 4-4M8 20l2 2 4-4M17 6h4M17 13h4M3 6h.01M3 13h.01M3 20h.01',
  knowledge:'M4 3h6a4 4 0 0 1 4 4v14a4 4 0 0 0-4-3H4V3Zm16 0h-2a4 4 0 0 0-4 4m0 14a4 4 0 0 1 4-3h2V3Z',
  skills:'m12 3 2.8 5.7L21 10l-4.5 4.4 1.1 6.2L12 17.7l-5.6 2.9 1.1-6.2L3 10l6.2-1.3L12 3Z',
  learning:'M12 20v-7m0 0C4 14 3 8 3 4c7 0 9 4 9 9Zm0 0c0-6 3-8 9-8 0 6-2 9-9 8Z',
  schedules:'M12 8v4l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
  settings:'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm0-5v2m0 14v2M3 12h2m14 0h2M5.6 5.6 7 7m10 10 1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4',
  sync:'M20 7h-5l2-2a7 7 0 0 0-11 3M4 17h5l-2 2a7 7 0 0 0 11-3M20 3v4M4 21v-4',
  'remote-status':'M3 4h18v12H3V4Zm5 16h8m-4-4v4',
  more:'M5 12h.01M12 12h.01M19 12h.01',
  arrow:'m9 5 7 7-7 7',back:'m15 5-7 7 7 7',plus:'M12 5v14M5 12h14',
  close:'m6 6 12 12M6 18 18 6',logout:'M9 5H4v14h5m5-14 7 7-7 7m-5-7h12',
};
export function Icon({name,className=''}:{name:string;className?:string}) {
  return <svg className={'icon '+className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]??paths.conversations}/></svg>;
}
export function BrandMark(){return <svg viewBox="0 0 32 32" fill="none" aria-hidden="true" className="brand-mark"><path d="M8 8h7v9h9v7H8V8Z" fill="currentColor"/><path d="M19 8h5v5h-5V8Z" fill="currentColor" opacity=".5"/></svg>;}
