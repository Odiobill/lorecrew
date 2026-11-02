# Installation

Lorecrew is a developer preview. Build from the public source or install a trusted built archive. Node.js 24, npm 11, Git and local filesystem storage are prerequisites. The installer does not download or replace prerequisites.

## Platforms

| Host | Current position |
| --- | --- |
| Linux x64 | Current verified execution platform. Process supervision uses Linux `/proc`. |
| Linux ARM64 / Raspberry Pi | Intended target; actual device validation is still needed. |
| WSL2 | Requires native validation; use the Linux filesystem for state and repositories. |
| macOS | Bootstrap may be usable, but the process probe is Linux-specific. Quiescence-dependent execution/handoff must remain blocked until the required host capability is available. |

Desktop/mobile browser layouts are supported by the UI. Physical-device installation, native zoom and OS-specific behavior require their own checks. Installation alone does not certify all execution capabilities.

## Build from source

Follow the [quick start](getting-started.md). Keep `package-lock.json` and `npm-shrinkwrap.json` synchronized; dependency versions are pinned. npm 11 is required by the current consumer-shrinkwrap installation pipeline.

## Install a built archive

Build first, then pack without another implicit build:

```sh
npm run build
npm pack --ignore-scripts --json
```

Use the actual filename reported by npm. Obtain its SHA-256 from a trusted release or calculate it locally for your own build. A checksum detects changed bytes; it does not authenticate an untrusted publisher.

```sh
sh packaging/install.sh \
  --tarball /absolute/path/to/lorecrew-package.tgz \
  --sha256 YOUR_VERIFIED_SHA256 \
  --offline --cache /absolute/path/to/copied-npm-cache
```

The offline cache must contain the pinned production dependencies. A cache miss remains an error; do not silently switch to an online install or enable lifecycle scripts. The installer prints the managed command path. Its defaults are `$HOME/.local/bin/lorecrew` and `$HOME/.local/share/lorecrew/app`.

The managed command pins an immutable compiled installation and Node executable. It does not initialize user state, start the service, open credentials, edit shell profiles or install an OS service. Keep your selected [credential environment](configuration.md#credentials) when launching the managed command.

## Updating

Stop the running instance, make a complete [paired backup](backup-and-recovery.md), and check the new version's compatibility guidance. Installer `--replace` changes only a recognized managed command/application installation. It is not a state migration or cleanup operation. Prior immutable installs and failed diagnostics are retained.

General arbitrary-version upgrade/downgrade and active workspace relocation are not guaranteed. Do not run an older executable against newer state simply because the old application files are available.

## Background services

`lorecrew service print --platform systemd` or `--platform launchd` prints a template for review. Replace all placeholders and provide concrete Node/Git paths, HOME, dedicated auth and public origin. Services do not inherit interactive shell profiles. Installing a template does not establish platform supervision support. See [configuration](configuration.md).
