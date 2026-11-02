const thinkingLabels:Record<string,string>={off:'Off',minimal:'Minimal',low:'Low',medium:'Medium',high:'High',xhigh:'Extra high',max:'Maximum'};
export const thinkingLabel=(preference?:{kind:'default'}|{kind:'explicit';level:string})=>preference?.kind==='explicit'?(Object.hasOwn(thinkingLabels,preference.level)?thinkingLabels[preference.level]!:preference.level):'Default';
