# Multiple machines

Each Lorecrew instance runs independently, with its own service, identity, local databases, checkouts and credentials. Instances can share accepted knowledge and readable history through a Git-backed vault. There is no mandatory central Lorecrew execution server.

## Share knowledge

Use the normal repository/sharing workflow to confirm the intended remote and authority domain. Configure appropriate hosting permissions and branch protection yourself. Local test remotes do not certify a hosted Git service's guarantees.

A model or agent can use accepted shared lessons on another machine. Credentials and machine-local paths stay private; cloning a vault does not copy runtime identity or grant authority. Synchronizing the vault never implicitly pushes or merges project code.

## One active owner per project

Different hosts can work on different projects. One project has one confirmed execution owner at a time. An established owner can continue while disconnected, if its other dependencies are reachable. A disconnected peer cannot claim, expire or force-take over that ownership.

A recorded project can be cloned onto another host without becoming executable there. Checkout availability and ownership are separate observations.

## Move future work deliberately

For handoff, settle or cancel unfinished work and prove its processes/effects stopped. Select and review the intended project checkpoint and context. The source publishes the required project data and handoff context through the shared native workflow. The designated target explicitly preflights and accepts that exact transfer before admitting fresh work.

The repository agent tools and CLI expose `project handoff`, `handoff-status`, `preflight` and `accept`; reviewed JSON inputs and stable request IDs are required. Use [API and CLI](api-and-cli.md) for the entry points and retain the actual operation's diagnostics if interrupted.

Live Pi conversations, arbitrary in-flight task execution, automatic failover, remote command delivery and fleet-wide live chat are not migrated. If an old host is lost, an operator must positively fence it before supported recovery; a timeout or network disconnection is insufficient.

## Remote observations

A remote status/report reflects last synchronized data. Connect to the executing host for live local updates. Seeing a project marked elsewhere depends on confirmed local transfer evidence; refresh authority through the explicit workflow when needed.
