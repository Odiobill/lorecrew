import ReactMarkdown from 'react-markdown';
import type { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

function safeUrl(value:string):string {
  // URL parsing handles case, whitespace and control-character normalization before the scheme check.
  try {const url=new URL(value,location.href);return ['http:','https:'].includes(url.protocol)?value:'';}catch{return '';}
}
const components:Components={
    a:({href,children})=>href?<a href={href} target={href.startsWith('#')?undefined:'_blank'} rel="noopener noreferrer">{children}</a>:<span>{children}</span>,
    img:({src,alt})=>typeof src==='string'&&safeUrl(src)?<a href={src} target="_blank" rel="noopener noreferrer">Image: {alt||'Open image'}</a>:<span>{alt}</span>,
    table:({children})=><div className="table-scroll" tabIndex={0} role="region" aria-label="Response table"><table>{children}</table></div>,
};
export function Markdown({text,onLocalLink}:{text:string;onLocalLink?:(href:string)=>void}) {
  return <div className="message-markdown"><ReactMarkdown skipHtml remarkPlugins={[remarkGfm]} urlTransform={safeUrl} components={onLocalLink?{...components,a:({href,children})=>href&&!/^https?:\/\//i.test(href)?<a href={href} onClick={e=>{e.preventDefault();if(href.startsWith('#')){let anchor='';try{anchor=decodeURIComponent(href.slice(1));}catch{}const root=e.currentTarget.closest('.message-markdown');const heading=Array.from(root?.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6')??[]).find(node=>node.id===anchor||(node.textContent??'').toLowerCase().trim().replace(/[^\p{L}\p{N} _-]/gu,'').replace(/\s+/g,'-')===anchor);if(heading){heading.tabIndex=-1;heading.scrollIntoView();heading.focus({preventScroll:true});}}else onLocalLink(href);}}>{children}</a>:<a href={href} target="_blank" rel="noopener noreferrer">{children}</a>}:components}>{text}</ReactMarkdown></div>;
}
