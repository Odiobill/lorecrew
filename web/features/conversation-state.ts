export interface ConversationViewState {draft:string;scrollTop:number;following:boolean}
/** Owned by the app, not browser storage. Authentication repair can reuse it; disconnect clears it. */
export class ConversationState {
  private views=new Map<string,ConversationViewState>();
  get(id:string):ConversationViewState {
    let view=this.views.get(id);
    if(!view){view={draft:'',scrollTop:0,following:true};this.views.set(id,view);}
    return view;
  }
  clear(){this.views.clear();}
  hasUnsentDrafts(){return [...this.views.values()].some(view=>view.draft.length>0);}
}
