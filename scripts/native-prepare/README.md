# OmO native preparation

`omo.mjs` acquires an exact selected wrapper and its unchanged, exact-pinned
Senpi engine. It obtains original sources at the wrapper's npm `gitHead` and the
engine's `v<version>` tag, including public GitHub submodules pinned by gitlinks.
It transplants the existing production native hooks using the hook checkouts'
actual `HEAD` baselines. Overlapping upstream edits fail rather than being
silently replaced. `latest-hook-resolution.mjs` admits only the reviewed
`5.1.17` manager source at commit
`091728d274f20d62504b0b5e1edbc3970671dd8b`, with exact upstream, baseline and
native-hook hashes. It keeps both settlement callbacks and both cancellation
cleanups, preserving `abort: "skip"` and the `"cancelled"` outcome.
It uses original locked installs, the original Senpi build
and publish staging, and the original OmO native builder.

```sh
bun scripts/native-prepare/omo.mjs \
  --version 5.1.17 \
  --output /private/tmp/unique-native-preparation \
  --wrapper-hooks /absolute/native-omo-checkout \
  --engine-hooks /absolute/native-senpi-checkout \
  --bun /absolute/tools/bin/bun \
  --npm /absolute/tools/bin/npm \
  --node /absolute/tools/bin/node \
  --apply-patch /absolute/path/to/apply_patch
```

The output parent must already exist and be canonical (`/private/tmp`, not
`/tmp`, on macOS). The output directory must not exist. All inputs are private
producer-owned local paths; evidence directories are rejected. The command
does not inherit credential environment variables or the user's HOME. It does
not install an operating CLI, start a CLI session, update, restart, deploy,
write Git state, or issue qualification.

Source archives are extracted by `tar`. Source changes are serialized as
Codex-format patch artifacts and applied only by an explicitly supplied actual
`apply_patch` executable. Source contents are never rewritten through `writeFile`
or copied from the hook checkout. Without that executable, preparation stops
with the pending patch path before applying source edits or invoking builds.

When `apply_patch` is an agent tool rather than an executable, use
`--source-patches-only true` instead of `--apply-patch`. The command returns
`SOURCE_PATCHES_REQUIRED` with pinned `hooks.wrapper.applicationPatch` and
`hooks.engine.applicationPatch`; it has not built or qualified anything.
Read and apply those complete artifacts with the actual `apply_patch` tool,
then run the same command with `--resume true`, omitting
`--source-patches-only`. Resume requires that every planned source output match
its pinned digest exactly before it runs original builds. It never bypasses a
source conflict or accepts a modified acquisition/patch artifact.

Overlay source pins point to the actual packed staging copies. A later original
source check may rebuild emitter outputs without changing those pinned copies.
To deliberately repack a completed preparation, use `--resume true` again. It
retains the earlier receipt as `preparation.previous-<attempt>.json` and writes
new build logs, staging files and archives under a new `attempts/<attempt>/`.
Use the new receipt and source binding together; do not replace a digest in an
older runtime configuration. Preserve older receipts until their jobs finish.

## Parent integration contract

Call `prepareOmo({version, outputDir, wrapperHooksSource, engineHooksSource,
bunPath, npmPath, nodePath, applyPatchPath})`. Successful `preparation.json` contains:

- `target`: exact `omo-ai` version and exact paired engine version.
- `artifacts`: candidate-compatible `OmoArtifact` records. `archive` and
  `metadata` always pin acquired vendor bytes. `overlay.archive` pins the
  separately packed variant. Vendor metadata and both original package
  manifests remain unchanged.
- `overlayGrants`: `OmoLocalOverlayGrant` records for the parent's existing
  private qualifier. These are explicit local overlays, not vendor releases.
- `sourceBinding`, `sourcePins`, `provenance`, `originalBuildCommands`: local
  source archives, hook diffs and outputs, tool pins, and successful original
  commands with pinned logs. Hook transport is not native qualification.
- `acquiredReplies`: independently fetched exact-version registry response
  bodies. Channel/dist-tag observations are the parent's separate responsibility.
- `targetFiles`: `{installName, relativePath, source: {path, sha256}}` for each
  packed target member. The parent must map these actual byte digests to its
  verified physical installation paths when constructing `independentTargetPins`.
  These records are not an installed after-image, global manifest, Bun lock,
  executable shim, or postinstall observation.

Only wrapper, engine, changed agent/TUI workspaces and source-only codemode
overlays are produced. The parent must independently acquire the remaining
dependency closure, preserve aliases and nested slots, validate postinstall
after-images, create its original qualifier receipt, and inspect the actual
native binding. Installation/profile/source-manifest information stays private
with that parent; this module neither chooses nor fabricates it.

## Remaining original Bun closure

Resolve the unchanged original vendor wrapper in a NEW, producer-owned global
prefix with the same pinned Bun executable. Create the owned `home`, `bun`,
`cache` and working directories first; none may be the operating install.

```sh
env -i \
  HOME="$OWNED/home" \
  BUN_INSTALL="$OWNED/bun" \
  BUN_INSTALL_CACHE_DIR="$OWNED/cache" \
  PATH="$PINNED_TOOLS_BIN:/usr/bin:/bin" \
  npm_config_userconfig=/dev/null \
  "$PINNED_TOOLS_BIN/bun" add --global --ignore-scripts --exact omo-ai@5.1.17
```

This is an acquisition/resolution install of original vendor packages, NOT
the independent native target installation or a lifecycle check. Let original
Bun resolve aliases and nested versions; do not hand-author a closure or force
a different linker. Pin its generated `install/global/package.json` and
`bun.lock`. For every resolver-visible slot under
`$OWNED/bun/install/global/node_modules`, read the installed package manifest's
real `name` and `version`, independently fetch that exact npm version metadata
and original tarball, and verify the original registry integrity. Extracted
Bun cache contents or an `npm pack` of installed files are NOT vendor archives.

Candidate `installName` is the logical physical slot relative to that
`node_modules`, for example `@earendil-works/pi-tui` or
`htmlparser2/node_modules/entities`; `name` remains the registry identity, for
example `@code-yeongyu/senpi-tui`. Follow original resolution and record every
actual selected slot. Never rename aliases to registry names, flatten nested
versions, or treat Bun's private `.bun` cache/store paths as install slots.
Repeated `(name, version)` slots must use identical original archive, metadata,
and applicable overlay pins. Map prepared overlays onto ALL matching actual
slots, rather than assuming this module's default top-level `installName`.

Only after complete overlays and the closure exist should the parent perform
its independent original-manager install against those explicit overlay
artifacts and the complete acquired closure. Observe the real generated
manifest, lock, shims and postinstall bytes there; map `targetFiles` to that
install's verified paths for `independentTargetPins`. A vendor-only closure
install must never be substituted for that native target after-image.

Success is `LOCAL_SOURCE_OVERLAY_PACKED_NOT_INSTALL_QUALIFIED`, always with
`nativeFlowQualified: false`. A failed source acquisition, merge, install, build
or pack writes `BLOCKED` and the exact command/HTTP failure to the new output
directory and exits nonzero. Inspect `preparation.json`, then the named pinned
command log. Keep earlier outputs; retry in a new directory.

## Deterministic checks

```sh
bun test test/native-prepare
```

Tests use generated packages and real `npm pack`, not historical evidence or
the installed CLI. They cover exact pairing, vendor integrity and identity,
source merges and conflicts, immutable output pins, manifest preservation,
pack allowlists, and exclusive output reservation.
