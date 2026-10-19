# Public landing

The English product site is separate from the localhost management application.
Production: https://herdr-cli-updater.vercel.app/

From the repository root:

```sh
bun run build
bun run build:site
vercel deploy site/dist --scope beomqs-projects --prod
```

Upload **site/dist only**, never the repository root or dist/web. The site build
copies an explicit list of HTML, CSS, branding assets and Vercel configuration.
It has no API, environment variables, analytics or connection to localhost.
The site build also packs the explicit package.json files allowlist into
`downloads/herdr-cli-updater-<version>.tgz`, writes its SHA-256 file, and fills the
download URL and digest in `/install.sh`. Build the local app before packing it.
The installer requires Bun 1.4.2+ and Node.js 24+, installs without sudo into
`~/.local/share/cli-updater-app/releases`, and activates a verified release via
`current`. The launcher is `~/.local/bin/cli-updater`. Existing releases and
unrelated launchers are not overwritten; shell configuration is not edited.

Routes: `/` introduction, `/features/` capabilities, `/clis/` generated catalog,
and `/guide/` installation and operating steps. Get started targets `/guide/#install`.
The CLI page is generated from `src/app/catalog-registry.ts`; its logos and the
homepage CLI marks use the existing `AgentMark` renderer at build time.
The homepage hero shows the one-line curl install command directly. The small
local clipboard script supports both entry
points; no third-party script or localhost API is used.
Copy feedback includes a manual-selection path when clipboard access is denied.

The archive is distributed by this site, not npm. CLI process/session data and
credentials must never be included in public assets or the packaged archive.
Verify with `bun test test/site/installer.test.ts` and an isolated HOME against the
public URL after deployment; never use the operator's HOME for installer QA.
