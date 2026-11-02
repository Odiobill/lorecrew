# Getting started

Run your own AI crew for coding, research, planning and everyday work. Start with one agent and a local vault; add a coding project or more machines when you need them.

## What you need

Use Node.js **24**, npm **11** and Git on the service host. The currently verified execution target is Linux x64. A phone or another computer can use the browser interface while that host stays running. See [installation](installation.md#platforms) for other platform limits.

## Build from source

```sh
git clone https://github.com/Odiobill/lorecrew.git
cd lorecrew
npm ci --ignore-scripts --no-audit --no-fund
npm run build
```

This produces the compiled service and browser UI. Public registry installation is not required.

## Keep credentials separate

Choose a private, dedicated Lorecrew credential store before the first start:

```sh
export LORECREW_AUTH_FILE="$HOME/.local/share/lorecrew/auth/auth.json"
install -d -m 700 "$HOME/.local/share/lorecrew/auth"
if [ ! -e "$LORECREW_AUTH_FILE" ]; then
  (set -C; umask 077; printf '{}\n' > "$LORECREW_AUTH_FILE")
fi
```

Keep this variable in the environment used to start Lorecrew. An existing file is preserved. Never overwrite credentials to follow a quick start. Read [configuration](configuration.md#credentials) before sharing another application's credential store.

## Start and pair

```sh
node dist/cli.js serve --host 127.0.0.1 --port 4317
```

Open the URL printed in the terminal and pair using its one-use login secret. Treat that secret as private. Select an existing Git vault, create one at a folder you choose, or deliberately clone one. Folder paths refer to the service host, which may be different from your browser device. Nothing is preselected.

Use a separate vault folder outside this source checkout, state directory and coding projects. Existing populated vaults open directly; a new vault offers starter setup. You can reopen optional setup in Settings.

## Meet your first agent

Name an agent, describe its responsibilities and choose a provider/model. Configure credentials in Settings when you decide to use it. Set a supported thinking preference or leave **Default**. Creating or saving an agent does not itself make a model request.

Try a deliberate first conversation: ask for a plan, a draft or help interpreting a local document. Agents have the host user's file and shell access. Review the [security model](security.md) and start with disposable work while learning the application.

For coding, use [Projects](projects.md) to create a repository or connect a checkout, confirm local execution ownership and explicitly assign work. Ordinary conversation does not require a coding project; project-free team delegation is not included in this preview.

## Stop normally

Press **Ctrl+C** in the service terminal and wait for shutdown. Closing the browser leaves the host service running. Agents and routines can continue only while the service host runs and remains awake.

For another instance, use a separate `--state-dir` and port. Never start two services against one state directory. Continue with [agents](agents.md), [knowledge and skills](knowledge-and-skills.md), or [routines](routines.md).
