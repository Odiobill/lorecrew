# Lorecrew

### Your own AI crew. Knowledge that stays.

Self-hosted AI teams for coding and personal assistance, with durable conversations and shared knowledge in a Git-backed Markdown vault.

[Website](https://lorecrew.dev/) · [Get started](docs/getting-started.md) · [User guides](https://lorecrew.dev/docs/getting-started/) · [Contribute](CONTRIBUTING.md)

## A crew you can make your own

Give agents names, responsibilities, models and skills. Work directly with an assistant or let a lead coordinate a coding task with other agents. Keep useful lessons, decisions and procedures in a vault you can read and edit independently of Lorecrew.

- **Code with a team.** Connect a Git project, assign a lead and review delegated work, questions and results.
- **Get personal assistance.** Research, plan, draft and work with local files in ordinary conversations, without creating a coding project.
- **Keep useful experience.** Search knowledge, reuse scoped skills and inspect the evidence behind learned lessons. Configure a background curator when you want one.
- **Choose your models.** Use the provider catalog from Pi AI, including supported local endpoints, with explicit model-specific thinking preferences.
- **Work across your machines.** Independent instances share accepted knowledge through Git. Explicit ownership and stopped handoffs coordinate project execution.
- **Stay in the loop.** A browser/PWA, attention Inbox, routines, readable history and recovery tools keep local work inspectable.

## Get running

Developer preview: `0.1.0-preview.3`. Install Node.js **24**, npm **11** and Git first. Linux x64 is the currently verified execution platform; read [platform notes](docs/installation.md#platforms) before using another host.

```sh
git clone https://github.com/Odiobill/lorecrew.git
cd lorecrew
npm ci --ignore-scripts --no-audit --no-fund
npm run build
```

Follow the [quick start](docs/getting-started.md) to create a dedicated private credential store, start `node dist/cli.js serve`, pair your browser and choose a vault. The browser asks for provider credentials when you deliberately use an agent.

Registry publication is not required: start from source or use the [standalone archive installer](docs/installation.md#install-a-built-archive).

## Your knowledge remains yours

The vault holds Markdown definitions, knowledge, skills and readable history. Local SQLite databases retain execution state and recovery records. Back up both: Git history alone does not replace an [instance backup](docs/backup-and-recovery.md).

Lorecrew is a trusted, single-owner application. Agents run with the host user's file and shell permissions. Choose providers and imported instructions carefully; model requests go to the provider you configure. [Read the security model](docs/security.md).

## Explore

| Guide | What it covers |
| --- | --- |
| [Agents and thinking](docs/agents.md) | Definitions, model choice, skills and explicit session reload |
| [Projects](docs/projects.md) | Create, add, recorded clone, checkout readiness and ownership |
| [Knowledge and skills](docs/knowledge-and-skills.md) | Lessons, provenance, import and reviewed activation |
| [Routines and Inbox](docs/routines.md) | Scheduled local work and actionable attention |
| [Multiple machines](docs/multi-device.md) | Independent hosts, Git sharing and deliberate handoff |
| [Configuration](docs/configuration.md) | State, credentials, networking and service environment |
| [Architecture](docs/architecture.md) | Pi Durable, the vault, local state and public API |
| [Troubleshooting](docs/troubleshooting.md) | Practical recovery and diagnostic guidance |

## Development

See [CONTRIBUTING](CONTRIBUTING.md) for development, tests and the static website. Please [report vulnerabilities privately](SECURITY.md) and keep credentials, transcripts and private vault content out of public issues.

Licensed under [MIT](LICENSE).
