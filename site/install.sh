#!/bin/sh
set -eu

fail() { printf '\nInstallation stopped: %s\n' "$*" >&2; exit 1; }
case "$(uname -s)" in Darwin|Linux) ;; *) fail 'Use macOS or Linux. On Windows, run inside a WSL2 Linux terminal, not PowerShell or Git Bash.' ;; esac
case "$(uname -m)" in arm64|aarch64|x86_64) ;; *) fail 'Only x64 and arm64 architectures are supported.' ;; esac
[ -n "${HOME:-}" ] && [ -d "$HOME" ] || fail 'HOME must be an existing directory.'
command -v bun >/dev/null 2>&1 || fail 'Install Bun 1.4.2+ first: https://bun.sh/docs/installation'
command -v node >/dev/null 2>&1 || fail 'Install Node.js 24+ first: https://nodejs.org/en/download'
command -v curl >/dev/null 2>&1 || fail 'curl is required.'
bun -e 'const [a,b,c]=Bun.version.split(".").map(Number);process.exit(a>1||a===1&&(b>4||b===4&&c>=2)?0:1)' || fail 'Bun 1.4.2 or newer is required.'
node -e 'process.exit(Number(process.versions.node.split(".")[0])>=24?0:1)' || fail 'Node.js 24 or newer is required.'

root="$HOME/.local/share/cli-updater-app"
bin="$HOME/.local/bin"
launcher="$bin/cli-updater"
# Do not replace an unrelated executable or follow a redirected installation root.
[ ! -L "$root" ] || fail "$root is a symbolic link. Choose a normal application directory."
if [ -e "$launcher" ] || [ -L "$launcher" ]; then
  [ -L "$launcher" ] && [ "$(readlink "$launcher")" = "$root/current/node_modules/.bin/cli-updater" ] || fail "$launcher already exists and is not owned by this installer."
fi
mkdir -p "$root/releases" "$bin"
stage=$(mktemp -d "$root/releases/.install-XXXXXXXX")
cleanup() { [ -z "${stage:-}" ] || rm -rf "$stage"; }
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
printf 'Downloading herdr-cli-updater…\n'
curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 '@@ARCHIVE_URL@@' -o "$stage/app.tgz"
bun -e 'const file=process.argv[1];const expected=process.argv[2];const digest=new Bun.CryptoHasher("sha256").update(await Bun.file(file).arrayBuffer()).digest("hex");if(digest!==expected){console.error("Archive checksum mismatch");process.exit(1)}' "$stage/app.tgz" '@@SHA256@@'
printf 'Installing into %s\n' "$root"
bun add --cwd "$stage" --ignore-scripts "$stage/app.tgz"
"$stage/node_modules/.bin/cli-updater" --version
# Activate only a complete, runnable installation. Existing releases are preserved.
bun -e 'import {symlinkSync,renameSync,lstatSync} from "node:fs";const [root,stage,bin]=process.argv.slice(1);const current=root+"/current";const old=lstatSync(current,{throwIfNoEntry:false});if(old&&!old.isSymbolicLink())throw new Error("current is not an installer link");symlinkSync(stage,stage+"/activate");renameSync(stage+"/activate",current);const launcher=bin+"/cli-updater";const present=lstatSync(launcher,{throwIfNoEntry:false});if(!present)symlinkSync(current+"/node_modules/.bin/cli-updater",launcher);' "$root" "$stage" "$bin"
stage=''
printf '\nInstalled. Open your local workspace with:\n  %s\n' "$launcher"
case ":$PATH:" in
  *":$bin:"*) printf '\nOr run: cli-updater\n' ;;
  *) printf '\nFor the shorter command, add this to your shell configuration:\n  export PATH="$HOME/.local/bin:$PATH"\n' ;;
esac
printf '\nNo CLI updates were run. Automatic updates remain off by default.\n'
