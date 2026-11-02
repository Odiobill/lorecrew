export default function Changes({diff}:{diff:string}) {
  return <pre className="diff" data-testid="diff" tabIndex={0} aria-label="Workspace diff">{diff?diff.split('\n').map((line,index)=><span key={index} className={line.startsWith('+')?'addition':line.startsWith('-')?'deletion':''}>{line}{'\n'}</span>):'No changes in this workspace.'}</pre>;
}
