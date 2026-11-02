# Agents and thinking

An agent is a named definition: personality, responsibilities, model and group memberships. The same definition can be used by multiple independent conversations. Give each agent a clear purpose; model choice and skills can vary by agent.

## Create and edit

Open **Agents** and choose **New agent**, or select an existing agent. Choose a model from the provider catalog. Models without configured credentials remain inspectable; credential availability does not prove a successful model response. Groups organize shared context and skill discovery.

Saving a definition does not start work or call a model. Imported unavailable models and thinking values remain visible for deliberate repair.

## Thinking level

**Default** leaves the runtime preference unset. **Off** is an explicit choice. Supported levels come from the selected model's installed SDK metadata; unavailable choices are never silently clamped. Higher thinking can increase response time and token use, and support varies by model. An Off-only model has no adjustable thinking levels.

Switching models retains an explicit preference in the draft. If it becomes unsupported, choose a supported level or Default before saving. Adding credentials does not repair a thinking mismatch.

## Existing conversations keep their definition

An agent edit applies to new sessions and newly admitted work. Existing sessions keep their pinned definition, model descriptor and thinking preference. Inspect the pinned configuration in conversation details or related conversations.

To apply the current saved definition to an existing ordinary conversation, choose **Reload session definition** at an idle boundary. Queued messages, unsettled effects, cancelled/finished sessions and workload identities retain their native restrictions. Repeating the same acknowledged reload does not create a second configuration change.

An unsupported historical interrupted reload remains readable and fenced. Repair the agent, then explicitly request a supported reload when eligible. The rejected original request cannot undo that repair.

## Coding and personal assistance

Ordinary conversations can plan, draft, research, retrieve knowledge and use host files/tools without a coding project. Coding team tasks require a ready, owned [project](projects.md). A lead can delegate project work to named agents or task-scoped helpers, ask human questions and report results.

Host tools are supervised with the permissions of the service user. Agent and group scopes do not provide isolation. Read [security](security.md) before giving agents access to important files.
