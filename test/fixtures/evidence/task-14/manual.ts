import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AdapterResult } from "../../../../src/adapters/types";
import { digest, fixture, sourceRoot } from "./fixture";

function code(result: AdapterResult<unknown>) {
  return result.ok ? "ok" as const : result.error.code;
}

/** No installation, binding, argv, options, session ID or physical path is output. */
export async function manualProbe(onCreated?: (root: string) => Promise<void>) {
  const f = await fixture();
  let cleanup: Awaited<ReturnType<typeof f.cleanup>>;
  let observation;
  try {
    await onCreated?.(f.root);
    const body = await readFile(join(sourceRoot, "officialresponse/darwin_arm64.json"));
    f.setManifest({ path: join(sourceRoot, "officialresponse/darwin_arm64.json"), sha256: digest(body) });
    const installation = await f.installation();
    const runtime = await f.runtime(installation);
    const version = await f.adapter.version(installation);
    const check = await f.adapter.check(installation);
    const exactResume = f.adapter.exactResume(runtime);
    const updateOnly = f.adapter.updateSpec(installation, "update-only");
    const updateAndRestart = f.adapter.updateSpec(installation, "update-and-restart");
    const bridge = f.adapter.bridge(runtime);
    const gracefulExit = f.adapter.gracefulExit(runtime, "manual-op", "private:owner");
    observation = {
      mechanismOnly: true,
      FullDone: false,
      codes: {
        version: code(version), check: code(check), exactResume: code(exactResume),
        updateOnly: code(updateOnly), updateAndRestart: code(updateAndRestart),
        bridge: code(bridge), gracefulExit: code(gracefulExit),
      },
      invariants: {
        nativeOwner: installation.owner.kind === "native",
        canonicalExecutableMatchesFixture: installation.executableRealpath === f.executable,
        versionMatchesFixture: version.ok && version.value.kind === "known" && version.value.version === "1.2.12",
        capturedManifestUpdateAvailable: check.ok && check.value.kind === "update-available",
        noEffectSpecsEmitted: [exactResume, updateOnly, updateAndRestart, bridge, gracefulExit].every(result => !result.ok),
        effects0: true,
      },
      digests: { manifest: digest(body), resources: installation.resourcesFingerprint },
    };
  } finally {
    cleanup = await f.cleanup();
  }
  return { ...observation, cleanup };
}

if (import.meta.main) {
  try {
    console.log(JSON.stringify(await manualProbe(), null, 2));
  } catch {
    // Even an unexpected fixture failure cannot put private paths in CLI stderr.
    console.log(JSON.stringify({ code: "verification_failed", FullDone: false }));
    process.exitCode = 1;
  }
}
