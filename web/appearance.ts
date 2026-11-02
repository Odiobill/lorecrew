import { useEffect,useState } from 'react';
export type Appearance='system'|'light'|'dark';
const storageKey='lorecrew:appearance';
function readAppearance():Appearance {
  try {const saved=localStorage.getItem(storageKey);return saved==='light'||saved==='dark'?saved:'system';}catch{return 'system';}
}
export function useAppearance() {
  const [appearance,setAppearance]=useState<Appearance>(readAppearance);
  useEffect(()=>{
    const media=matchMedia('(prefers-color-scheme: dark)');
    const apply=()=>{document.documentElement.dataset.theme=appearance==='system'?(media.matches?'dark':'light'):appearance;};
    apply();media.addEventListener('change',apply);
    try{localStorage.setItem(storageKey,appearance);}catch{/* Appearance works when browser storage is unavailable. */}
    return()=>media.removeEventListener('change',apply);
  },[appearance]);
  return [appearance,setAppearance] as const;
}
