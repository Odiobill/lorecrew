# How Lorecrew fits together

Lorecrew runs an independent service on each host. A browser/PWA talks to that host's API. Models are selected through Pi AI; durable execution is built on Pi Durable and CodeMode.

## Three different kinds of state

| Place | What belongs there |
| --- | --- |
| Git-backed Markdown vault | Agent/group definitions, shared knowledge, skills, lessons and readable history |
| Private local state | SQLite execution records, identities, requests, receipts, indexes, artifacts and recovery data |
| Host project checkouts | Source code, Git branches/worktrees and project-local files |

Credentials remain private to the host. Vault and code repositories are distinct: sharing knowledge never implicitly pushes or merges project code. The knowledge index is rebuildable; it does not replace the vault.

## From a request to useful experience

A deliberate user request enters a durable local conversation or project task. Named agents can use available tools, retrieve knowledge and, for owned project teamwork, delegate with recorded dependencies and identities. Human questions and results remain inspectable.

Learning captures can lead to tentative lessons. A configured curator can refine knowledge and propose skill changes. Evidence-linked checks distinguish observed improvements from unverified claims. Later work searches and loads exact relevant revisions; existing task/skill pins do not silently change.

## Across machines

Instances share accepted knowledge and readable status through Git. They can work on different projects independently. A project has one confirmed execution owner, with deliberate stopped transfer to another host. A remote view is a synchronized observation, not a live remote command channel.

## Browser and API

The Hono service serves the built React/Vite PWA and versioned HTTP/JSON API. Server-sent events carry local updates; reconnect uses cursors and fresh snapshots. Mutations use request identities so a lost response can reconcile the original operation.

The browser caches allowlisted static assets, not private transcripts or API responses. It does not queue offline mutations. UI update activation and draft recovery are deliberate. Closing the browser does not stop host execution.

No mandatory central Lorecrew coordinator, external SQL server, vector server or separate queue service is required. Optional deployment and future connectors are separate concerns. Read [configuration](configuration.md), [multiple machines](multi-device.md) and [security](security.md) before production use.

## Foundations and inspiration

### WikiSkill

[WikiSkill: Compiling Agent Experience into Persistent Knowledge for Skill Evolution](https://arxiv.org/abs/2608.27454), by Tang et al. (2026), is a research inspiration for Lorecrew's learning design. The paper separates raw experience, accumulated knowledge and reusable skills, with a persistent wiki supporting later skill evolution.

Lorecrew adapts this separation to durable conversations and project teamwork through source-linked lessons, context-specific evidence and deliberate skill activation. These are Lorecrew-specific adaptations; their behavior and validation are defined by Lorecrew's own implementation and recorded checks.

### Open Knowledge Format

The vault uses [Open Knowledge Format (OKF) v0.2](https://github.com/GoogleCloudPlatform/open-knowledge-format/blob/main/SPEC.md) conventions for Markdown concepts with YAML frontmatter, provenance and verification metadata, and linked indexes. The root index declares `okf_version: "0.2"`.

Lorecrew extends these conventions with its own entity IDs, skill scopes and evidence semantics. Its `lorecrew` metadata namespace carries application-specific details. Private execution records and credentials remain separate from the portable vault.
