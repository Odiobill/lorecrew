export const repository='https://github.com/Odiobill/lorecrew';
export const docs=[
 ['getting-started','Getting started','From source checkout to your first agent.','Start here'],
 ['installation','Installation','Prerequisites, platform notes and built archives.','Start here'],
 ['configuration','Configuration','Paths, providers, networking and service setup.','Start here'],
 ['agents','Agents and thinking','Give your crew a purpose, model and supported thinking preference.','Use Lorecrew'],
 ['projects','Projects','Create, add and clone repositories with deliberate ownership.','Use Lorecrew'],
 ['knowledge-and-skills','Knowledge and skills','Keep useful lessons, inspect evidence and reuse instructions.','Use Lorecrew'],
 ['routines','Routines and Inbox','Schedule local work and keep attention actionable.','Use Lorecrew'],
 ['multi-device','Multiple machines','Independent hosts, Git sharing and stopped handoff.','Operate'],
 ['backup-and-recovery','Backup and recovery','Preserve state and recover one identity safely.','Operate'],
 ['security','Security and trust','Understand host permissions, providers and browser access.','Operate'],
 ['troubleshooting','Troubleshooting','Diagnose blockers without losing recovery information.','Operate'],
 ['architecture','How Lorecrew fits together','The vault, local state and durable execution.','Understand'],
 ['api-and-cli','API and CLI','Entry points for local tools and future integrations.','Understand'],
].map(([slug,title,description,group])=>({slug,title,description,group,file:slug+'.md'}));
export const faqs=[
 ['Can I use Lorecrew for more than coding?','Yes. Ordinary conversations support planning, research, drafting, knowledge retrieval and host files/tools without a coding project. Team delegation currently belongs to an owned project.'],
 ['Does every model run locally?','You choose. Lorecrew uses the provider/model catalog from Pi AI, including supported local endpoints. A remote provider receives the model request you send to it. Self-hosting the service and running a local model are separate choices.'],
 ['What stays in my vault?','Agent definitions, knowledge, memories, skills, lessons and readable history live in Git-backed Markdown. Private databases keep local execution and recovery records; credentials stay private to the host. Back up those separately.'],
 ['How do multiple machines work?','Each instance runs independently and shares accepted knowledge through Git. Different hosts can work on different projects. A project has one confirmed owner, and a deliberate stopped handoff moves future execution.'],
 ['What should I know before trying it?','This is a developer preview for a trusted single owner. Agents use the host account’s file and shell permissions. Linux x64 is the currently verified execution platform; other hosts need additional validation. Start with disposable work and read the security guide.'],
 ['What about MCP and other integrations?','MCP, email/calendar connectors, push notifications and other extensions are future work. The current preview focuses on local agents, coding teamwork, useful knowledge, routines and deliberate sharing.'],
];
