import { useEffect,useRef,useState,type ReactNode } from 'react';
import { pageNames,routeHash,type Page,type Route } from '../navigation.js';
import {PwaStatus} from './pwa-status.js';
import { BrandMark,Icon } from './icon.js';

const sections:Array<{label:string;pages:Page[]}>= [
  {label:'Workspace',pages:['inbox','conversations','tasks','projects']},
  {label:'Team',pages:['agents','groups']},
  {label:'Library',pages:['knowledge','skills','learning']},
  {label:'Manage',pages:['routines','settings','remote-status']},
];
export function AppShell({route,name,connection,authenticated,disconnect,disabled,children,linkFor,inboxCount}: {
  inboxCount:number;route:Route;name:string;connection:string;authenticated:boolean;
  disconnect:()=>void;disabled:boolean;children:ReactNode;linkFor:(page:Page)=>string;
}) {
  const [more,setMore]=useState(false);const moreButton=useRef<HTMLButtonElement>(null);const morePanel=useRef<HTMLDivElement>(null);
  const content=useRef<HTMLDivElement>(null);const previous=useRef(route.page);
  useEffect(()=>{
    setMore(false);
    if(previous.current!==route.page){content.current?.focus();previous.current=route.page;}
  },[route.page,route.entity]);
  useEffect(()=>{
    if(!more)return;
    morePanel.current?.querySelector('a')?.focus();
    function escape(event:KeyboardEvent){if(event.key==='Escape'){setMore(false);moreButton.current?.focus();}}
    window.addEventListener('keydown',escape);return()=>window.removeEventListener('keydown',escape);
  },[more]);
  const link=(page:Page)=><a key={page} aria-label={pageNames[page]} href={linkFor(page)} onClick={()=>setMore(false)} aria-current={route.page===page?'page':undefined}><Icon name={page}/><span>{pageNames[page]}</span>{page==='inbox'&&inboxCount>0&&<span className="inbox-count" aria-label={inboxCount+' awaiting review'}>{inboxCount}</span>}{route.page===page&&<span className="nav-active-dot"/>}</a>;
  return <div className={'app-shell'+(!authenticated?' signed-out':'')}>
    <a className="skip-link" href="#workspace-content" onClick={e=>{e.preventDefault();content.current?.focus();}}>Skip to content</a>
    <aside className="sidebar" aria-label="Workspace sidebar">
      <a href={routeHash({page:'conversations'})} className="wordmark"><BrandMark/><span>lorecrew<span className="wordmark-period">.</span></span></a>
      <div className="instance-card"><span className="instance-avatar">{name.slice(0,1).toUpperCase()}</span><div><strong data-testid="instance-name">{name}</strong><span>Your local workspace</span></div><span className="instance-dot"/></div>
      {authenticated&&<nav className="desktop-nav" aria-label="Main">{sections.map(section=><div className="nav-section" key={section.label}><p>{section.label}</p>{section.pages.map(link)}</div>)}</nav>}
      <div className="sidebar-bottom"><div className="local-note"><Icon name="learning"/><span>Independent agents.<br/>Knowledge that grows.</span></div>{authenticated&&<button className="text-button disconnect" disabled={disabled} onClick={disconnect}><Icon name="logout"/>Disconnect</button>}</div>
    </aside>
    <div className="app-body">
      <header className="topbar"><div className="breadcrumb"><span>Workspace</span><Icon name="arrow"/><strong>{authenticated?pageNames[route.page]:'Welcome'}</strong></div><div className="topbar-tools"><span className="mobile-instance" data-testid="mobile-instance-name">{name}</span></div></header>
      <div className="connection" role="status"><span className={connection.startsWith('Connected')?'connection-live':''}><i/>{connection}</span>{authenticated&&<span className="connection-note">Work continues while this instance is running.</span>}</div>
      <PwaStatus/><div id="workspace-content" className="app-content" ref={content} tabIndex={-1}>{children}</div>
      <footer>Made for your work. Built to remember.</footer>
    </div>
    {authenticated&&<>
      {more&&<div className="more-panel" ref={morePanel} id="more-navigation"><div className="more-heading"><strong>Explore your workspace</strong><button className="text-button" aria-label="Close navigation" onClick={()=>{setMore(false);moreButton.current?.focus();}}><Icon name="close"/></button></div><nav aria-label="More destinations">{link('projects')}{sections.slice(1).flatMap(section=>section.pages.map(link))}</nav><button className="text-button" disabled={disabled} onClick={disconnect}><Icon name="logout"/>Disconnect</button></div>}
      <nav className="mobile-nav" aria-label="Mobile navigation">{link('conversations')}{link('tasks')}{link('inbox')}<button ref={moreButton} className={more?'selected':''} aria-expanded={more} aria-controls="more-navigation" onClick={()=>setMore(!more)}><Icon name="more"/><span>More</span></button></nav>
    </>}
  </div>;
}
