/** Resolve exactly once against an original source path, never a wrapper path. */
export function importedRelativePath(fromPath:string,target:string):string|undefined {
 let path:string;try{path=decodeURIComponent(target.split('#')[0]!.split('?')[0]!);}catch{return;}
 if(!path||path.startsWith('/')||/[\\\0%]/.test(path)||/^[A-Za-z][A-Za-z0-9+.-]*:/.test(path))return;
 const parts=fromPath.split('/').slice(0,-1);for(const part of path.split('/')){if(!part||part==='.')continue;if(part==='..'){if(!parts.length)return;parts.pop();}else parts.push(part);}return parts.join('/');
}
