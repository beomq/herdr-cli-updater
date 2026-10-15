import { createHash } from "node:crypto";

// Reviewed additive compatibility for this exact upstream and native baseline.
// Cancellation remains "cancelled"; this does not issue native qualification.
export const latestManagerResolution = Object.freeze({
  version: "5.1.17",
  commit: "091728d274f20d62504b0b5e1edbc3970671dd8b",
  relativePath: "packages/senpi-task/src/manager/manager.ts",
  upstreamSha256: "ece3e8bfcb68d59c56ddca99e213488616c74ad992142169db08f6287d10eb18",
  baselineSha256: "b2993fd14e921e64d2bf66e43d7b5f11338944ea46042ef164c940ec3df95029",
  hookedSha256: "80056dee25e3408e63a202ef56f71c15fda7550b618c9388dc2ccf12ee5f9de6",
});
export const latestTypesResolution = Object.freeze({
  version: "5.1.17",
  commit: "091728d274f20d62504b0b5e1edbc3970671dd8b",
  relativePath: "packages/senpi-task/src/manager/types.ts",
  upstreamSha256: "1bd23d83da0f1ec94223fc2a603936a60cfcd73e098e2322311f797a1a5a3af4",
  baselineSha256: "ef32045137f355b3c985c0819c3632dae925b77c95c0b5ccf6fea4027c0ef782",
  hookedSha256: "4086ef3f522586d7b19e536f4bd4ff4f5fd009e6e98a2d1053ed008e67f75059",
});
export const latestRpcResolution = Object.freeze({
  version: "5.1.17",
  commit: "091728d274f20d62504b0b5e1edbc3970671dd8b",
  relativePath: "packages/senpi-task/src/runners/rpc/protocol-client.ts",
  upstreamSha256: "ddf08fe9e7e38b07e632afd01206e21d2127bace2b1f04fabb6838c5512581e2",
  baselineSha256: "a2f981d30792684748cc9f65dc23102b7441d1742d1f7fa6cfb6dded3011a062",
  hookedSha256: "d10f758dc5e698a8ae0fa00bdf8ed1483a78ead019f64af443e830b670b8d3be",
});
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const callbackUpstream = "      stopSettlement: (taskId) => this.#stopsPending.settlement(taskId),\n";
const callbackHook = "      finishNative: (taskId, epoch, outcome, handle) => this.#finishNative(taskId, epoch, outcome, handle),\n";
const cancelUpstream = [
  "      // A cancelled task never runs again, so no epoch of it may keep a lane slot - including a run",
  "      // whose live handle this manager already let go of, or never had (still launching). Only a live",
  "      // handle whose abort was skipped keeps its slot until its settled outcome releases it.",
  '      if (options?.abort !== "skip" || !this.#live.has(outcome.task_id)) this.#concurrency.releaseTask(outcome.task_id)',
  "",
].join("\n");
const cancelHook = [
  "      const record = this.#tryLoad(outcome.task_id)",
  '      if (record && this.#nativeRuns.get(`${record.task_id}:${record.notification.run_epoch}`)?.phase === "queued") {',
  '        await this.#finishNative(record.task_id, record.notification.run_epoch, "cancelled")',
  "      }",
  "",
].join("\n");

export function assertReviewedManagerRevision(inputs, profile = latestManagerResolution) {
  for (const field of ["version", "commit", "relativePath", "upstreamSha256", "baselineSha256", "hookedSha256"]) {
    if (inputs[field] !== profile[field]) throw new Error("Unreviewed latest native source revision");
  }
}

export function resolveAdditiveManagerConflicts(conflicted) {
  let index = 0;
  const expected = [[callbackUpstream, callbackHook], [cancelUpstream, cancelHook]];
  const merged = conflicted.replace(/^<<<<<<< [^\n]+\n([\s\S]*?)^\|\|\|\|\|\|\| [^\n]+\n[\s\S]*?^=======\n([\s\S]*?)^>>>>>>> [^\n]+\n/gm,
    (_block, original, native) => {
      const pair = expected[index++];
      if (!pair || original !== pair[0] || native !== pair[1]) throw new Error("Unreviewed latest native conflict context");
      return original + native;
    });
  if (index !== expected.length || /^(?:<<<<<<<|=======|>>>>>>>|\|\|\|\|\|\|\|) /m.test(merged))
    throw new Error("Unexpected latest native conflict count");
  return merged;
}

export function resolveLatestManager({ version, commit, relativePath, upstream, baseline, hooked, conflicted }) {
  assertReviewedManagerRevision({ version, commit, relativePath, upstreamSha256: hash(upstream),
    baselineSha256: hash(baseline), hookedSha256: hash(hooked) });
  const merged = resolveAdditiveManagerConflicts(conflicted);
  return { merged, resolution: { ...latestManagerResolution, outputSha256: hash(merged) } };
}

export function resolveLatestTypes({ version, commit, relativePath, upstream, baseline, hooked, conflicted }) {
  assertReviewedManagerRevision({ version, commit, relativePath, upstreamSha256: hash(upstream),
    baselineSha256: hash(baseline), hookedSha256: hash(hooked) }, latestTypesResolution);
  let count = 0;
  const merged = conflicted.replace(/^<<<<<<< [^\n]+\n([\s\S]*?)^\|\|\|\|\|\|\| [^\n]+\n[\s\S]*?^=======\n([\s\S]*?)^>>>>>>> [^\n]+\n/gm,
    (_block, original, native) => {
      count++;
      if (original !== "  readonly onChildExtensionEvent?: (event: ChildExtensionEvent, owner: TaskRecord) => void\n"
        || native !== "  readonly nativeWork?: (parentSessionId: string) => NativeWorkGate | undefined\n")
        throw new Error("Unreviewed latest native type context");
      return original + native;
    });
  if (count !== 1 || /^(?:<<<<<<<|=======|>>>>>>>|\|\|\|\|\|\|\|)/m.test(merged)) throw new Error("Unexpected latest native type conflict count");
  return { merged, resolution: { ...latestTypesResolution, outputSha256: hash(merged) } };
}

export function resolveLatestRpc({ version, commit, relativePath, upstream, baseline, hooked, conflicted }) {
  assertReviewedManagerRevision({ version, commit, relativePath, upstreamSha256: hash(upstream),
    baselineSha256: hash(baseline), hookedSha256: hash(hooked) }, latestRpcResolution);
  let count = 0;
  const merged = conflicted.replace(/^<<<<<<< [^\n]+\n([\s\S]*?)^\|\|\|\|\|\|\| [^\n]+\n[\s\S]*?^=======\n([\s\S]*?)^>>>>>>> [^\n]+\n/gm,
    (_block, original, native) => {
      count++;
      if (original !== 'import type { ChildEventListener, RpcEntriesResult, RpcSwitchSessionResult } from "../types"\nimport { createChildExtensionEvents } from "../child-extension-events"\n'
        || native !== 'import type { ChildEventListener, RpcEntriesResult, RpcRunnerSpec, RpcSwitchSessionResult } from "../types"\n')
        throw new Error("Unreviewed latest native RPC context");
      return native + 'import { createChildExtensionEvents } from "../child-extension-events"\n';
    });
  if (count !== 1 || /^(?:<<<<<<<|=======|>>>>>>>|\|\|\|\|\|\|\|)/m.test(merged)) throw new Error("Unexpected latest native RPC conflict count");
  return { merged, resolution: { ...latestRpcResolution, outputSha256: hash(merged) } };
}

// Reviewed import/constructor unions in the exact paired 2026.10.8 engine.
export const latestEngineResolutions = Object.freeze([
  {
    version: "5.1.17", commit: "d56e6a260d9468418a39bc9120945cf98e06b840",
    relativePath: "packages/tui/src/terminal.ts",
    upstreamSha256: "a8bcdc09df81b64e745abb0d1fdfe51717c9ce0a2575c2d6a86612d465473177",
    baselineSha256: "7637ccafac425a4d892951f990a7f8f36db994ae870cf1d66cb6c93fe15d1899",
    hookedSha256: "8a44844cd7a168bf7a93c612f592787adb8a7e6f36b491dd89b8c959a4f99c68",
    original: "\t\tthis.stdinBuffer = new StdinBuffer({\n\t\t\tescapeTimeout: resolveEscapeTimeoutMs(),\n\t\t\tburstWindowMs: resolveBurstWindowMs(),\n\t\t});\n",
    native: "\t\tthis.stdinBuffer = new StdinBuffer({\n\t\t\tescapeTimeout: resolveEscapeTimeoutMs(),\n\t\t\tmanaged: this.managedInput !== undefined,\n\t\t});\n",
    replacement: "\t\tthis.stdinBuffer = new StdinBuffer({\n\t\t\tescapeTimeout: resolveEscapeTimeoutMs(),\n\t\t\tburstWindowMs: resolveBurstWindowMs(),\n\t\t\tmanaged: this.managedInput !== undefined,\n\t\t});\n",
  },
  {
    version: "5.1.17", commit: "d56e6a260d9468418a39bc9120945cf98e06b840",
    relativePath: "packages/coding-agent/src/modes/rpc/connection-handler.ts",
    upstreamSha256: "86339554d3aca75f7e37716d8ba8e6836e74facd0b00d9b7a1f2d74445ed2298",
    baselineSha256: "c375cdd45f4214eae9f15d160393845f4898d0c8dcaf1365e220c3bd994b4dfc",
    hookedSha256: "7d9ff50c3fff79e244afea08ab617fc2cfde4172770c9ec702de7be73f5a8233",
    original: "",
    native: 'import { UNKNOWN_COMMAND_CONFIRM_HINT, UnknownCommandError } from "../../core/unknown-command.ts";\nimport { NativeBridgeError, nativeEngineDigest, nativeRemoteScope } from "../../core/updater-native-bridge.ts";\n',
    replacement: 'import { NativeBridgeError, nativeEngineDigest, nativeRemoteScope } from "../../core/updater-native-bridge.ts";\n',
  },
  {
    version: "5.1.17", commit: "d56e6a260d9468418a39bc9120945cf98e06b840",
    relativePath: "packages/coding-agent/src/modes/rpc/rpc-types.ts",
    upstreamSha256: "d506e900ee2d5ab24070a4b3da738f60c1932c1ca744fee2d9cb3221b30fedcb",
    baselineSha256: "f3a4de7aa26ec2863b538640ec083fc0ecc83e99a458c35faa664f5fd1fc8c03",
    hookedSha256: "f575089e83f8daae12a2b8f560435f6fd3756765a2a619c53ea8339a9d985b58",
    original: 'import type { ClientMessageAdmission } from "./client-admission-record.ts";\n',
    native: 'import type { NativeRemoteBinding, NativeRemoteReceipt } from "../../core/updater-native-bridge.ts";\n',
    replacement: 'import type { NativeRemoteBinding, NativeRemoteReceipt } from "../../core/updater-native-bridge.ts";\nimport type { ClientMessageAdmission } from "./client-admission-record.ts";\n',
  },
  {
    version: "5.1.17", commit: "d56e6a260d9468418a39bc9120945cf98e06b840",
    relativePath: "packages/coding-agent/src/modes/rpc/session-command-router.ts",
    upstreamSha256: "c0980ce4928de956b369679cfdf231147fe6c9286f6dd3b3d4a12341f2d97d03",
    baselineSha256: "a0c257e1bfd1a6eb26f4dfcbd851aec287581f5a3a9d23ce75812c721f3825fe",
    hookedSha256: "42b18d76e52ef9167d7cdc9d0b08dbf568f84f21ee7da2ea7c6955af7c8689a7",
    original: 'import {\n\tACCEPT_EDITS_PERMISSION_PRESET_CAPABILITY,\n\tAUTO_PERMISSION_PRESET_CAPABILITY,\n} from "../../core/extensions/builtin/permission-system/config.ts";\nimport { DURABLE_CLIENT_MESSAGE_ID_CAPABILITY } from "./client-admission-record.ts";\n',
    native: 'import { ACCEPT_EDITS_PERMISSION_PRESET_CAPABILITY } from "../../core/extensions/builtin/permission-system/config.ts";\nimport { nativeEngineDigest, parseNativeRemoteBinding } from "../../core/updater-native-bridge.ts";\n',
    replacement: 'import {\n\tACCEPT_EDITS_PERMISSION_PRESET_CAPABILITY,\n\tAUTO_PERMISSION_PRESET_CAPABILITY,\n} from "../../core/extensions/builtin/permission-system/config.ts";\nimport { nativeEngineDigest, parseNativeRemoteBinding } from "../../core/updater-native-bridge.ts";\nimport { DURABLE_CLIENT_MESSAGE_ID_CAPABILITY } from "./client-admission-record.ts";\n',
  },
]);

export function resolveLatestEngineHook({ version, commit, relativePath, upstream, baseline, hooked, conflicted }) {
  const profile = latestEngineResolutions.find(row => row.relativePath === relativePath);
  if (!profile) throw new Error("Unreviewed latest engine hook");
  assertReviewedManagerRevision({ version, commit, relativePath, upstreamSha256: hash(upstream),
    baselineSha256: hash(baseline), hookedSha256: hash(hooked) }, profile);
  let count = 0;
  const merged = conflicted.replace(/^<<<<<<< [^\n]+\n([\s\S]*?)^\|\|\|\|\|\|\| [^\n]+\n[\s\S]*?^=======\n([\s\S]*?)^>>>>>>> [^\n]+\n/gm,
    (_block, original, native) => {
      count++;
      if (original !== profile.original || native !== profile.native) throw new Error("Unreviewed latest engine conflict context");
      return profile.replacement;
    });
  if (count !== 1 || /^(?:<<<<<<<|=======|>>>>>>>|\|\|\|\|\|\|\|)/m.test(merged)) throw new Error("Unexpected latest engine conflict count");
  const { original, native, replacement, ...pins } = profile;
  return { merged, resolution: { ...pins, outputSha256: hash(merged) } };
}

// Exact 5.1.19 / 2026.10.10 source review. Never match a version range or
// discard upstream behavior when transplanting native lifecycle hooks.
export const currentHookResolutions = Object.freeze([
  {
    "version": "5.1.19",
    "commit": "a8019016f47a9d814ebcc24bd921a561f065ee80",
    "relativePath": "packages/omo-native/bin/lib/launcher.js",
    "upstreamSha256": "a34d46e651048e4f3f65b44fdd869d020c7af683d5a743556be99802a32c5436",
    "baselineSha256": "2f469d8c8c6391fbf6d9ff6276b5798065921dcb8f5b97ddc2b1d68c6d513460",
    "hookedSha256": "e79cefceaae5876fd3f7702a255c39a5573e9ee181ea1f667ea3d3a718044288",
    "conflicts": [
      {
        "original": "import { isEngineCommand } from \"./engine-commands.js\"\n",
        "native": "import { pathToFileURL } from \"node:url\"\n",
        "replacement": "import { isEngineCommand } from \"./engine-commands.js\"\nimport { pathToFileURL } from \"node:url\"\n"
      }
    ]
  },
  {
    "version": "5.1.19",
    "commit": "a8019016f47a9d814ebcc24bd921a561f065ee80",
    "relativePath": "packages/omo-native/bin/omo.js",
    "upstreamSha256": "7d046be58ebe29c7a9a10c1a266f2b8e944b2f2597760774fe1de7abfbdcbc2b",
    "baselineSha256": "c3e26b5154fe283cf7d7e6d6e03a1ff7112467f3ef0094f89ea7a371523277fb",
    "hookedSha256": "10cd022a9bece54910f013601dded3e11f14b80c9e8f7c6c7796a1743c8bd9ac",
    "conflicts": [
      {
        "original": "  // A machine that has bun runs omo on bun, whichever package manager installed it. A `bun add -g`\n  // install is reached through a symlink in ~/.bun/bin, and node resolves the main module to its\n  // real path, so this URL already points inside the bun global tree. Every bun is held to the\n  // engine's floor (BUN_MIN_VERSION): a bun the user chose (that tree, or OMO_RUNTIME=bun) that is\n  // too old stops with an upgrade message, any other old bun leaves the launch on node (#9563).\n  // Only an explicit OMO_RUNTIME=node, or a machine without a usable bun, stays on node.\n  const scriptPath = fileURLToPath(import.meta.url)\n  // That same symlink makes node boot before every re-exec, so POSIX bun-global installs pay for\n  // node on every launch. This keeps the user-facing bin a tiny sh shim that execs bun directly;\n  // it is quiet and fail-open by contract, and Windows/npm installs never enter it. The shebang\n  // above and the bin mapping in package.json are all Windows shims ever read, and both stay.\n  ensureBunBinShim({ scriptPath })\n  const reexeced = await maybeReexecUnderBun({ scriptPath })\n  if (!reexeced) {\n    if (process.argv[2] === \"setup\") await runSetup(process.argv.slice(3))\n    else await runLauncher()\n",
        "native": "  if (nativeEnvironment) {\n    const { runLauncher } = await import(\"./lib/launcher.js\")\n    await runLauncher(process.argv.slice(2), nativeEnvironment)\n  } else {\n    const { ensureBunBinShim } = await import(\"./lib/bun-bin-shim.js\")\n    const { maybeReexecUnderBun } = await import(\"./lib/bun-runtime.js\")\n    // A machine that has bun runs omo on bun, whichever package manager installed it. A `bun add -g`\n    // install is reached through a symlink in ~/.bun/bin, and node resolves the main module to its\n    // real path, so this URL already points inside the bun global tree and that bun is trusted as-is;\n    // every other install probes the bun it found and hands over when it meets the engine's floor.\n    // Only an explicit OMO_RUNTIME=node, or a machine without a usable bun, stays on node.\n    const scriptPath = fileURLToPath(import.meta.url)\n    // That same symlink makes node boot before every re-exec, so POSIX bun-global installs pay for\n    // node on every launch. This keeps the user-facing bin a tiny sh shim that execs bun directly;\n    // it is quiet and fail-open by contract, and Windows/npm installs never enter it. The shebang\n    // above and the bin mapping in package.json are all Windows shims ever read, and both stay.\n    ensureBunBinShim({ scriptPath })\n    const reexeced = await maybeReexecUnderBun({ scriptPath })\n    if (!reexeced) {\n      if (process.argv[2] === \"setup\") {\n        const { runSetup } = await import(\"./lib/setup-import.js\")\n        await runSetup(process.argv.slice(3))\n      } else {\n        const { runLauncher } = await import(\"./lib/launcher.js\")\n        await runLauncher()\n      }\n    }\n",
        "replacement": "  if (nativeEnvironment) {\n    const { runLauncher } = await import(\"./lib/launcher.js\")\n    await runLauncher(process.argv.slice(2), nativeEnvironment)\n  } else {\n    const { ensureBunBinShim } = await import(\"./lib/bun-bin-shim.js\")\n    const { maybeReexecUnderBun } = await import(\"./lib/bun-runtime.js\")\n    // A machine that has bun runs omo on bun, whichever package manager installed it. A `bun add -g`\n    // install is reached through a symlink in ~/.bun/bin, and node resolves the main module to its\n    // real path, so this URL already points inside the bun global tree. Every bun is held to the\n    // engine's floor (BUN_MIN_VERSION): a bun the user chose (that tree, or OMO_RUNTIME=bun) that is\n    // too old stops with an upgrade message, any other old bun leaves the launch on node (#9563).\n    // Only an explicit OMO_RUNTIME=node, or a machine without a usable bun, stays on node.\n    const scriptPath = fileURLToPath(import.meta.url)\n    // That same symlink makes node boot before every re-exec, so POSIX bun-global installs pay for\n    // node on every launch. This keeps the user-facing bin a tiny sh shim that execs bun directly;\n    // it is quiet and fail-open by contract, and Windows/npm installs never enter it. The shebang\n    // above and the bin mapping in package.json are all Windows shims ever read, and both stay.\n    ensureBunBinShim({ scriptPath })\n    const reexeced = await maybeReexecUnderBun({ scriptPath })\n    if (!reexeced) {\n      if (process.argv[2] === \"setup\") {\n        const { runSetup } = await import(\"./lib/setup-import.js\")\n        await runSetup(process.argv.slice(3))\n      } else {\n        const { runLauncher } = await import(\"./lib/launcher.js\")\n        await runLauncher()\n      }\n    }\n"
      }
    ]
  },
  {
    "version": "5.1.19",
    "commit": "a8019016f47a9d814ebcc24bd921a561f065ee80",
    "relativePath": "packages/senpi-task/src/manager/manager.ts",
    "upstreamSha256": "ece3e8bfcb68d59c56ddca99e213488616c74ad992142169db08f6287d10eb18",
    "baselineSha256": "b2993fd14e921e64d2bf66e43d7b5f11338944ea46042ef164c940ec3df95029",
    "hookedSha256": "80056dee25e3408e63a202ef56f71c15fda7550b618c9388dc2ccf12ee5f9de6",
    "conflicts": [
      {
        "original": "      stopSettlement: (taskId) => this.#stopsPending.settlement(taskId),\n",
        "native": "      finishNative: (taskId, epoch, outcome, handle) => this.#finishNative(taskId, epoch, outcome, handle),\n",
        "replacement": "      stopSettlement: (taskId) => this.#stopsPending.settlement(taskId),\n      finishNative: (taskId, epoch, outcome, handle) => this.#finishNative(taskId, epoch, outcome, handle),\n"
      },
      {
        "original": "      // A cancelled task never runs again, so no epoch of it may keep a lane slot - including a run\n      // whose live handle this manager already let go of, or never had (still launching). Only a live\n      // handle whose abort was skipped keeps its slot until its settled outcome releases it.\n      if (options?.abort !== \"skip\" || !this.#live.has(outcome.task_id)) this.#concurrency.releaseTask(outcome.task_id)\n",
        "native": "      const record = this.#tryLoad(outcome.task_id)\n      if (record && this.#nativeRuns.get(`${record.task_id}:${record.notification.run_epoch}`)?.phase === \"queued\") {\n        await this.#finishNative(record.task_id, record.notification.run_epoch, \"cancelled\")\n      }\n",
        "replacement": "      // A cancelled task never runs again, so no epoch of it may keep a lane slot - including a run\n      // whose live handle this manager already let go of, or never had (still launching). Only a live\n      // handle whose abort was skipped keeps its slot until its settled outcome releases it.\n      if (options?.abort !== \"skip\" || !this.#live.has(outcome.task_id)) this.#concurrency.releaseTask(outcome.task_id)\n      const record = this.#tryLoad(outcome.task_id)\n      if (record && this.#nativeRuns.get(`${record.task_id}:${record.notification.run_epoch}`)?.phase === \"queued\") {\n        await this.#finishNative(record.task_id, record.notification.run_epoch, \"cancelled\")\n      }\n"
      }
    ]
  },
  {
    "version": "5.1.19",
    "commit": "a8019016f47a9d814ebcc24bd921a561f065ee80",
    "relativePath": "packages/senpi-task/src/manager/types.ts",
    "upstreamSha256": "1bd23d83da0f1ec94223fc2a603936a60cfcd73e098e2322311f797a1a5a3af4",
    "baselineSha256": "ef32045137f355b3c985c0819c3632dae925b77c95c0b5ccf6fea4027c0ef782",
    "hookedSha256": "4086ef3f522586d7b19e536f4bd4ff4f5fd009e6e98a2d1053ed008e67f75059",
    "conflicts": [
      {
        "original": "  readonly onChildExtensionEvent?: (event: ChildExtensionEvent, owner: TaskRecord) => void\n",
        "native": "  readonly nativeWork?: (parentSessionId: string) => NativeWorkGate | undefined\n",
        "replacement": "  readonly onChildExtensionEvent?: (event: ChildExtensionEvent, owner: TaskRecord) => void\n  readonly nativeWork?: (parentSessionId: string) => NativeWorkGate | undefined\n"
      }
    ]
  },
  {
    "version": "5.1.19",
    "commit": "a8019016f47a9d814ebcc24bd921a561f065ee80",
    "relativePath": "packages/senpi-task/src/runners/rpc-host/session-client.ts",
    "upstreamSha256": "4e96ae7c1a5debd847cb94e94aab6b130900ec9ef495c467171f81bdd5e4a69b",
    "baselineSha256": "3f4cd7abb0bc9aea1c2047a274275cf89d068b226b1dc6210870679bc2562e75",
    "hookedSha256": "83a35bcd3a8af0d29af517d830bc37c4162c2643974658185b014cd79847c75a",
    "conflicts": [
      {
        "original": "    // An older host would ignore the field and run the child on its own settings; leave it off there\n    // and report that the chain was not applied, so the caller can say so once.\n    const profileHonored = identity.capabilities.includes(RETRY_FALLBACK_PROFILE_CAPABILITY)\n    const retryFallbackDropped = !profileHonored && input.retryFallback !== undefined\n    const wire = toWireOpen(profileHonored ? input : withoutRetryFallback(input))\n    const opened = await client.openSession(wire).catch(async (error: unknown) => {\n",
        "native": "    if (input.nativeRemote) {\n      try {\n        if (!client.nativeEngineInfo || !client.nativeOwnerCommand) {\n          throw new Error(\"original_remote_client_missing\")\n        }\n        input.nativeRemote.verifyEngine(await client.nativeEngineInfo())\n      } catch (error) {\n        this.client = undefined\n        await client.stop()\n        throw error\n      }\n    }\n    const opened = await client.openSession(toWireOpen(input)).catch(async (error: unknown) => {\n",
        "replacement": "    if (input.nativeRemote) {\n      try {\n        if (!client.nativeEngineInfo || !client.nativeOwnerCommand) {\n          throw new Error(\"original_remote_client_missing\")\n        }\n        input.nativeRemote.verifyEngine(await client.nativeEngineInfo())\n      } catch (error) {\n        this.client = undefined\n        await client.stop()\n        throw error\n      }\n    }\n    // An older host would ignore the field and run the child on its own settings; leave it off there\n    // and report that the chain was not applied, so the caller can say so once.\n    const profileHonored = identity.capabilities.includes(RETRY_FALLBACK_PROFILE_CAPABILITY)\n    const retryFallbackDropped = !profileHonored && input.retryFallback !== undefined\n    const wire = toWireOpen(profileHonored ? input : withoutRetryFallback(input))\n    const opened = await client.openSession(wire).catch(async (error: unknown) => {\n"
      }
    ]
  },
  {
    "version": "5.1.19",
    "commit": "a8019016f47a9d814ebcc24bd921a561f065ee80",
    "relativePath": "packages/senpi-task/src/runners/rpc/protocol-client.ts",
    "upstreamSha256": "ddf08fe9e7e38b07e632afd01206e21d2127bace2b1f04fabb6838c5512581e2",
    "baselineSha256": "a2f981d30792684748cc9f65dc23102b7441d1742d1f7fa6cfb6dded3011a062",
    "hookedSha256": "d10f758dc5e698a8ae0fa00bdf8ed1483a78ead019f64af443e830b670b8d3be",
    "conflicts": [
      {
        "original": "import type { ChildEventListener, RpcEntriesResult, RpcSwitchSessionResult } from \"../types\"\nimport { createChildExtensionEvents } from \"../child-extension-events\"\n",
        "native": "import type { ChildEventListener, RpcEntriesResult, RpcRunnerSpec, RpcSwitchSessionResult } from \"../types\"\n",
        "replacement": "import type { ChildEventListener, RpcEntriesResult, RpcRunnerSpec, RpcSwitchSessionResult } from \"../types\"\nimport { createChildExtensionEvents } from \"../child-extension-events\"\n"
      }
    ]
  },
  {
    "version": "5.1.19",
    "commit": "b8bef123f8beec4394408529b7eef60e746255a6",
    "relativePath": "packages/coding-agent/src/modes/rpc/connection-handler.ts",
    "upstreamSha256": "0344c7b6dcf5e865be3bdb0696c52e19fcc72ba65b9398321915a723e505926c",
    "baselineSha256": "c375cdd45f4214eae9f15d160393845f4898d0c8dcaf1365e220c3bd994b4dfc",
    "hookedSha256": "7d9ff50c3fff79e244afea08ab617fc2cfde4172770c9ec702de7be73f5a8233",
    "conflicts": [
      {
        "original": "",
        "native": "import { UNKNOWN_COMMAND_CONFIRM_HINT, UnknownCommandError } from \"../../core/unknown-command.ts\";\nimport { NativeBridgeError, nativeEngineDigest, nativeRemoteScope } from \"../../core/updater-native-bridge.ts\";\n",
        "replacement": "import { NativeBridgeError, nativeEngineDigest, nativeRemoteScope } from \"../../core/updater-native-bridge.ts\";\n"
      }
    ]
  },
  {
    "version": "5.1.19",
    "commit": "b8bef123f8beec4394408529b7eef60e746255a6",
    "relativePath": "packages/coding-agent/src/modes/rpc/rpc-types.ts",
    "upstreamSha256": "ec58de8818f28f04557f89ccf960907ef36098c4b7bcf96ce89f52cfbdc5d9b1",
    "baselineSha256": "f3a4de7aa26ec2863b538640ec083fc0ecc83e99a458c35faa664f5fd1fc8c03",
    "hookedSha256": "f575089e83f8daae12a2b8f560435f6fd3756765a2a619c53ea8339a9d985b58",
    "conflicts": [
      {
        "original": "import type { ClientMessageAdmission } from \"./client-admission-record.ts\";\n",
        "native": "import type { NativeRemoteBinding, NativeRemoteReceipt } from \"../../core/updater-native-bridge.ts\";\n",
        "replacement": "import type { NativeRemoteBinding, NativeRemoteReceipt } from \"../../core/updater-native-bridge.ts\";\nimport type { ClientMessageAdmission } from \"./client-admission-record.ts\";\n"
      }
    ]
  },
  {
    "version": "5.1.19",
    "commit": "b8bef123f8beec4394408529b7eef60e746255a6",
    "relativePath": "packages/coding-agent/src/modes/rpc/session-command-router.ts",
    "upstreamSha256": "c0980ce4928de956b369679cfdf231147fe6c9286f6dd3b3d4a12341f2d97d03",
    "baselineSha256": "a0c257e1bfd1a6eb26f4dfcbd851aec287581f5a3a9d23ce75812c721f3825fe",
    "hookedSha256": "42b18d76e52ef9167d7cdc9d0b08dbf568f84f21ee7da2ea7c6955af7c8689a7",
    "conflicts": [
      {
        "original": "import {\n\tACCEPT_EDITS_PERMISSION_PRESET_CAPABILITY,\n\tAUTO_PERMISSION_PRESET_CAPABILITY,\n} from \"../../core/extensions/builtin/permission-system/config.ts\";\nimport { DURABLE_CLIENT_MESSAGE_ID_CAPABILITY } from \"./client-admission-record.ts\";\n",
        "native": "import { ACCEPT_EDITS_PERMISSION_PRESET_CAPABILITY } from \"../../core/extensions/builtin/permission-system/config.ts\";\nimport { nativeEngineDigest, parseNativeRemoteBinding } from \"../../core/updater-native-bridge.ts\";\n",
        "replacement": "import {\n\tACCEPT_EDITS_PERMISSION_PRESET_CAPABILITY,\n\tAUTO_PERMISSION_PRESET_CAPABILITY,\n} from \"../../core/extensions/builtin/permission-system/config.ts\";\nimport { nativeEngineDigest, parseNativeRemoteBinding } from \"../../core/updater-native-bridge.ts\";\nimport { DURABLE_CLIENT_MESSAGE_ID_CAPABILITY } from \"./client-admission-record.ts\";\n"
      }
    ]
  },
  {
    "version": "5.1.19",
    "commit": "b8bef123f8beec4394408529b7eef60e746255a6",
    "relativePath": "packages/tui/src/terminal.ts",
    "upstreamSha256": "a8bcdc09df81b64e745abb0d1fdfe51717c9ce0a2575c2d6a86612d465473177",
    "baselineSha256": "7637ccafac425a4d892951f990a7f8f36db994ae870cf1d66cb6c93fe15d1899",
    "hookedSha256": "8a44844cd7a168bf7a93c612f592787adb8a7e6f36b491dd89b8c959a4f99c68",
    "conflicts": [
      {
        "original": "\t\tthis.stdinBuffer = new StdinBuffer({\n\t\t\tescapeTimeout: resolveEscapeTimeoutMs(),\n\t\t\tburstWindowMs: resolveBurstWindowMs(),\n\t\t});\n",
        "native": "\t\tthis.stdinBuffer = new StdinBuffer({\n\t\t\tescapeTimeout: resolveEscapeTimeoutMs(),\n\t\t\tmanaged: this.managedInput !== undefined,\n\t\t});\n",
        "replacement": "\t\tthis.stdinBuffer = new StdinBuffer({\n\t\t\tescapeTimeout: resolveEscapeTimeoutMs(),\n\t\t\tburstWindowMs: resolveBurstWindowMs(),\n\t\t\tmanaged: this.managedInput !== undefined,\n\t\t});\n"
      }
    ]
  }
]);

// Exact 5.1.21 / 2026.10.10-3 review. Existing contexts are unchanged;
// agent-session keeps native ownership around the unchanged upstream preflight.
export const selectedHookResolutions = Object.freeze([
  {
    "version": "5.1.21",
    "commit": "071ea7e2038ae5fe46bd7b35778a8831a5fee953",
    "relativePath": "packages/omo-native/bin/lib/launcher.js",
    "upstreamSha256": "a34d46e651048e4f3f65b44fdd869d020c7af683d5a743556be99802a32c5436",
    "baselineSha256": "2f469d8c8c6391fbf6d9ff6276b5798065921dcb8f5b97ddc2b1d68c6d513460",
    "hookedSha256": "e79cefceaae5876fd3f7702a255c39a5573e9ee181ea1f667ea3d3a718044288",
    "conflicts": [
      {
        "original": "import { isEngineCommand } from \"./engine-commands.js\"\n",
        "native": "import { pathToFileURL } from \"node:url\"\n",
        "replacement": "import { isEngineCommand } from \"./engine-commands.js\"\nimport { pathToFileURL } from \"node:url\"\n"
      }
    ]
  },
  {
    "version": "5.1.21",
    "commit": "071ea7e2038ae5fe46bd7b35778a8831a5fee953",
    "relativePath": "packages/omo-native/bin/omo.js",
    "upstreamSha256": "7d046be58ebe29c7a9a10c1a266f2b8e944b2f2597760774fe1de7abfbdcbc2b",
    "baselineSha256": "c3e26b5154fe283cf7d7e6d6e03a1ff7112467f3ef0094f89ea7a371523277fb",
    "hookedSha256": "10cd022a9bece54910f013601dded3e11f14b80c9e8f7c6c7796a1743c8bd9ac",
    "conflicts": [
      {
        "original": "  // A machine that has bun runs omo on bun, whichever package manager installed it. A `bun add -g`\n  // install is reached through a symlink in ~/.bun/bin, and node resolves the main module to its\n  // real path, so this URL already points inside the bun global tree. Every bun is held to the\n  // engine's floor (BUN_MIN_VERSION): a bun the user chose (that tree, or OMO_RUNTIME=bun) that is\n  // too old stops with an upgrade message, any other old bun leaves the launch on node (#9563).\n  // Only an explicit OMO_RUNTIME=node, or a machine without a usable bun, stays on node.\n  const scriptPath = fileURLToPath(import.meta.url)\n  // That same symlink makes node boot before every re-exec, so POSIX bun-global installs pay for\n  // node on every launch. This keeps the user-facing bin a tiny sh shim that execs bun directly;\n  // it is quiet and fail-open by contract, and Windows/npm installs never enter it. The shebang\n  // above and the bin mapping in package.json are all Windows shims ever read, and both stay.\n  ensureBunBinShim({ scriptPath })\n  const reexeced = await maybeReexecUnderBun({ scriptPath })\n  if (!reexeced) {\n    if (process.argv[2] === \"setup\") await runSetup(process.argv.slice(3))\n    else await runLauncher()\n",
        "native": "  if (nativeEnvironment) {\n    const { runLauncher } = await import(\"./lib/launcher.js\")\n    await runLauncher(process.argv.slice(2), nativeEnvironment)\n  } else {\n    const { ensureBunBinShim } = await import(\"./lib/bun-bin-shim.js\")\n    const { maybeReexecUnderBun } = await import(\"./lib/bun-runtime.js\")\n    // A machine that has bun runs omo on bun, whichever package manager installed it. A `bun add -g`\n    // install is reached through a symlink in ~/.bun/bin, and node resolves the main module to its\n    // real path, so this URL already points inside the bun global tree and that bun is trusted as-is;\n    // every other install probes the bun it found and hands over when it meets the engine's floor.\n    // Only an explicit OMO_RUNTIME=node, or a machine without a usable bun, stays on node.\n    const scriptPath = fileURLToPath(import.meta.url)\n    // That same symlink makes node boot before every re-exec, so POSIX bun-global installs pay for\n    // node on every launch. This keeps the user-facing bin a tiny sh shim that execs bun directly;\n    // it is quiet and fail-open by contract, and Windows/npm installs never enter it. The shebang\n    // above and the bin mapping in package.json are all Windows shims ever read, and both stay.\n    ensureBunBinShim({ scriptPath })\n    const reexeced = await maybeReexecUnderBun({ scriptPath })\n    if (!reexeced) {\n      if (process.argv[2] === \"setup\") {\n        const { runSetup } = await import(\"./lib/setup-import.js\")\n        await runSetup(process.argv.slice(3))\n      } else {\n        const { runLauncher } = await import(\"./lib/launcher.js\")\n        await runLauncher()\n      }\n    }\n",
        "replacement": "  if (nativeEnvironment) {\n    const { runLauncher } = await import(\"./lib/launcher.js\")\n    await runLauncher(process.argv.slice(2), nativeEnvironment)\n  } else {\n    const { ensureBunBinShim } = await import(\"./lib/bun-bin-shim.js\")\n    const { maybeReexecUnderBun } = await import(\"./lib/bun-runtime.js\")\n    // A machine that has bun runs omo on bun, whichever package manager installed it. A `bun add -g`\n    // install is reached through a symlink in ~/.bun/bin, and node resolves the main module to its\n    // real path, so this URL already points inside the bun global tree. Every bun is held to the\n    // engine's floor (BUN_MIN_VERSION): a bun the user chose (that tree, or OMO_RUNTIME=bun) that is\n    // too old stops with an upgrade message, any other old bun leaves the launch on node (#9563).\n    // Only an explicit OMO_RUNTIME=node, or a machine without a usable bun, stays on node.\n    const scriptPath = fileURLToPath(import.meta.url)\n    // That same symlink makes node boot before every re-exec, so POSIX bun-global installs pay for\n    // node on every launch. This keeps the user-facing bin a tiny sh shim that execs bun directly;\n    // it is quiet and fail-open by contract, and Windows/npm installs never enter it. The shebang\n    // above and the bin mapping in package.json are all Windows shims ever read, and both stay.\n    ensureBunBinShim({ scriptPath })\n    const reexeced = await maybeReexecUnderBun({ scriptPath })\n    if (!reexeced) {\n      if (process.argv[2] === \"setup\") {\n        const { runSetup } = await import(\"./lib/setup-import.js\")\n        await runSetup(process.argv.slice(3))\n      } else {\n        const { runLauncher } = await import(\"./lib/launcher.js\")\n        await runLauncher()\n      }\n    }\n"
      }
    ]
  },
  {
    "version": "5.1.21",
    "commit": "071ea7e2038ae5fe46bd7b35778a8831a5fee953",
    "relativePath": "packages/senpi-task/src/manager/manager.ts",
    "upstreamSha256": "ece3e8bfcb68d59c56ddca99e213488616c74ad992142169db08f6287d10eb18",
    "baselineSha256": "b2993fd14e921e64d2bf66e43d7b5f11338944ea46042ef164c940ec3df95029",
    "hookedSha256": "80056dee25e3408e63a202ef56f71c15fda7550b618c9388dc2ccf12ee5f9de6",
    "conflicts": [
      {
        "original": "      stopSettlement: (taskId) => this.#stopsPending.settlement(taskId),\n",
        "native": "      finishNative: (taskId, epoch, outcome, handle) => this.#finishNative(taskId, epoch, outcome, handle),\n",
        "replacement": "      stopSettlement: (taskId) => this.#stopsPending.settlement(taskId),\n      finishNative: (taskId, epoch, outcome, handle) => this.#finishNative(taskId, epoch, outcome, handle),\n"
      },
      {
        "original": "      // A cancelled task never runs again, so no epoch of it may keep a lane slot - including a run\n      // whose live handle this manager already let go of, or never had (still launching). Only a live\n      // handle whose abort was skipped keeps its slot until its settled outcome releases it.\n      if (options?.abort !== \"skip\" || !this.#live.has(outcome.task_id)) this.#concurrency.releaseTask(outcome.task_id)\n",
        "native": "      const record = this.#tryLoad(outcome.task_id)\n      if (record && this.#nativeRuns.get(`${record.task_id}:${record.notification.run_epoch}`)?.phase === \"queued\") {\n        await this.#finishNative(record.task_id, record.notification.run_epoch, \"cancelled\")\n      }\n",
        "replacement": "      // A cancelled task never runs again, so no epoch of it may keep a lane slot - including a run\n      // whose live handle this manager already let go of, or never had (still launching). Only a live\n      // handle whose abort was skipped keeps its slot until its settled outcome releases it.\n      if (options?.abort !== \"skip\" || !this.#live.has(outcome.task_id)) this.#concurrency.releaseTask(outcome.task_id)\n      const record = this.#tryLoad(outcome.task_id)\n      if (record && this.#nativeRuns.get(`${record.task_id}:${record.notification.run_epoch}`)?.phase === \"queued\") {\n        await this.#finishNative(record.task_id, record.notification.run_epoch, \"cancelled\")\n      }\n"
      }
    ]
  },
  {
    "version": "5.1.21",
    "commit": "071ea7e2038ae5fe46bd7b35778a8831a5fee953",
    "relativePath": "packages/senpi-task/src/manager/types.ts",
    "upstreamSha256": "1bd23d83da0f1ec94223fc2a603936a60cfcd73e098e2322311f797a1a5a3af4",
    "baselineSha256": "ef32045137f355b3c985c0819c3632dae925b77c95c0b5ccf6fea4027c0ef782",
    "hookedSha256": "4086ef3f522586d7b19e536f4bd4ff4f5fd009e6e98a2d1053ed008e67f75059",
    "conflicts": [
      {
        "original": "  readonly onChildExtensionEvent?: (event: ChildExtensionEvent, owner: TaskRecord) => void\n",
        "native": "  readonly nativeWork?: (parentSessionId: string) => NativeWorkGate | undefined\n",
        "replacement": "  readonly onChildExtensionEvent?: (event: ChildExtensionEvent, owner: TaskRecord) => void\n  readonly nativeWork?: (parentSessionId: string) => NativeWorkGate | undefined\n"
      }
    ]
  },
  {
    "version": "5.1.21",
    "commit": "071ea7e2038ae5fe46bd7b35778a8831a5fee953",
    "relativePath": "packages/senpi-task/src/runners/rpc-host/session-client.ts",
    "upstreamSha256": "4e96ae7c1a5debd847cb94e94aab6b130900ec9ef495c467171f81bdd5e4a69b",
    "baselineSha256": "3f4cd7abb0bc9aea1c2047a274275cf89d068b226b1dc6210870679bc2562e75",
    "hookedSha256": "83a35bcd3a8af0d29af517d830bc37c4162c2643974658185b014cd79847c75a",
    "conflicts": [
      {
        "original": "    // An older host would ignore the field and run the child on its own settings; leave it off there\n    // and report that the chain was not applied, so the caller can say so once.\n    const profileHonored = identity.capabilities.includes(RETRY_FALLBACK_PROFILE_CAPABILITY)\n    const retryFallbackDropped = !profileHonored && input.retryFallback !== undefined\n    const wire = toWireOpen(profileHonored ? input : withoutRetryFallback(input))\n    const opened = await client.openSession(wire).catch(async (error: unknown) => {\n",
        "native": "    if (input.nativeRemote) {\n      try {\n        if (!client.nativeEngineInfo || !client.nativeOwnerCommand) {\n          throw new Error(\"original_remote_client_missing\")\n        }\n        input.nativeRemote.verifyEngine(await client.nativeEngineInfo())\n      } catch (error) {\n        this.client = undefined\n        await client.stop()\n        throw error\n      }\n    }\n    const opened = await client.openSession(toWireOpen(input)).catch(async (error: unknown) => {\n",
        "replacement": "    if (input.nativeRemote) {\n      try {\n        if (!client.nativeEngineInfo || !client.nativeOwnerCommand) {\n          throw new Error(\"original_remote_client_missing\")\n        }\n        input.nativeRemote.verifyEngine(await client.nativeEngineInfo())\n      } catch (error) {\n        this.client = undefined\n        await client.stop()\n        throw error\n      }\n    }\n    // An older host would ignore the field and run the child on its own settings; leave it off there\n    // and report that the chain was not applied, so the caller can say so once.\n    const profileHonored = identity.capabilities.includes(RETRY_FALLBACK_PROFILE_CAPABILITY)\n    const retryFallbackDropped = !profileHonored && input.retryFallback !== undefined\n    const wire = toWireOpen(profileHonored ? input : withoutRetryFallback(input))\n    const opened = await client.openSession(wire).catch(async (error: unknown) => {\n"
      }
    ]
  },
  {
    "version": "5.1.21",
    "commit": "071ea7e2038ae5fe46bd7b35778a8831a5fee953",
    "relativePath": "packages/senpi-task/src/runners/rpc/protocol-client.ts",
    "upstreamSha256": "ddf08fe9e7e38b07e632afd01206e21d2127bace2b1f04fabb6838c5512581e2",
    "baselineSha256": "a2f981d30792684748cc9f65dc23102b7441d1742d1f7fa6cfb6dded3011a062",
    "hookedSha256": "d10f758dc5e698a8ae0fa00bdf8ed1483a78ead019f64af443e830b670b8d3be",
    "conflicts": [
      {
        "original": "import type { ChildEventListener, RpcEntriesResult, RpcSwitchSessionResult } from \"../types\"\nimport { createChildExtensionEvents } from \"../child-extension-events\"\n",
        "native": "import type { ChildEventListener, RpcEntriesResult, RpcRunnerSpec, RpcSwitchSessionResult } from \"../types\"\n",
        "replacement": "import type { ChildEventListener, RpcEntriesResult, RpcRunnerSpec, RpcSwitchSessionResult } from \"../types\"\nimport { createChildExtensionEvents } from \"../child-extension-events\"\n"
      }
    ]
  },
  {
    "version": "5.1.21",
    "commit": "dca10b49c4f13526a79b77a192cfe2641b08d9a7",
    "relativePath": "packages/coding-agent/src/core/agent-session.ts",
    "upstreamSha256": "ab2479f5e239949051c41b0bb78b49576705e600503427b09e2c3f12e607fd34",
    "baselineSha256": "6b4754a6a4196f873ebe492628b68322e8589b3ce5433e8b0decb299c9ea31f0",
    "hookedSha256": "90ec0534f41035314a8ed11426a410dcba1ae9010f61ce0807d10da7d7fbadc1",
    "conflicts": [
      {
        "original": "\t\tif (options.waitForEventQueue !== false) {\n\t\t\tawait this._agentEventQueue;\n\t\t}\n\n\t\tconst runner = this._extensionRunner;\n\t\tif (!runner.hasHandlers(\"tool_call\")) {\n\t\t\treturn undefined;\n",
        "native": "\t\tif (\n\t\t\tthis.updaterNative &&\n\t\t\toptions.parentToolCallId !== undefined &&\n\t\t\t!this._nativeTools.has(options.parentToolCallId)\n\t\t) {\n\t\t\tthrow new NativeBridgeError(\"unknown_nested_tool_owner\");\n",
        "replacement": "\t\tif (\n\t\t\tthis.updaterNative &&\n\t\t\toptions.parentToolCallId !== undefined &&\n\t\t\t!this._nativeTools.has(options.parentToolCallId)\n\t\t) {\n\t\t\tthrow new NativeBridgeError(\"unknown_nested_tool_owner\");\n"
      },
      {
        "original": "\n\t\ttry {\n\t\t\treturn await runner.emitToolCall({\n\t\t\t\ttype: \"tool_call\",\n\t\t\t\ttoolName: toolCall.name,\n\t\t\t\ttoolCallId: toolCall.id,\n\t\t\t\t...(options.parentToolCallId ? { parentToolCallId: options.parentToolCallId } : {}),\n\t\t\t\tinput: args as Record<string, unknown>,\n\t\t\t});\n\t\t} catch (err) {\n\t\t\tif (err instanceof Error) {\n\t\t\t\tthrow err;\n\t\t\t}\n\t\t\tthrow new Error(`Extension failed, blocking execution: ${String(err)}`);\n",
        "native": "\t\tconst nativeLease = this.updaterNative?.begin(\n\t\t\t\"tool\",\n\t\t\toptions.parentToolCallId === undefined ? undefined : this._nativeTools.get(options.parentToolCallId)?.id,\n\t\t);\n\t\tif (nativeLease) this._nativeTools.set(toolCall.id, nativeLease);\n\t\ttry {\n\t\t\tif (options.waitForEventQueue !== false) {\n\t\t\t\tawait this._agentEventQueue;\n\t\t\t}\n\n\t\t\tconst runner = this._extensionRunner;\n\t\t\tif (!runner.hasHandlers(\"tool_call\")) {\n\t\t\t\treturn undefined;\n\t\t\t}\n\n\t\t\ttry {\n\t\t\t\tconst result = await runner.emitToolCall({\n\t\t\t\t\ttype: \"tool_call\",\n\t\t\t\t\ttoolName: toolCall.name,\n\t\t\t\t\ttoolCallId: toolCall.id,\n\t\t\t\t\t...(options.parentToolCallId ? { parentToolCallId: options.parentToolCallId } : {}),\n\t\t\t\t\tinput: args as Record<string, unknown>,\n\t\t\t\t});\n\t\t\t\tif (result?.block) this._finishNativeTool(toolCall.id, true);\n\t\t\t\treturn result;\n\t\t\t} catch (err) {\n\t\t\t\tif (err instanceof Error) {\n\t\t\t\t\tthrow err;\n\t\t\t\t}\n\t\t\t\tthrow new Error(`Extension failed, blocking execution: ${String(err)}`);\n\t\t\t}\n\t\t} catch (error) {\n\t\t\tthis._finishNativeTool(toolCall.id, true);\n\t\t\tthrow error;\n",
        "replacement": "\t\tconst nativeLease = this.updaterNative?.begin(\n\t\t\t\"tool\",\n\t\t\toptions.parentToolCallId === undefined ? undefined : this._nativeTools.get(options.parentToolCallId)?.id,\n\t\t);\n\t\tif (nativeLease) this._nativeTools.set(toolCall.id, nativeLease);\n\t\ttry {\n\t\t\tif (options.waitForEventQueue !== false) {\n\t\t\t\tawait this._agentEventQueue;\n\t\t\t}\n\n\t\t\tconst runner = this._extensionRunner;\n\t\t\tif (!runner.hasHandlers(\"tool_call\")) {\n\t\t\t\treturn undefined;\n\t\t\t}\n\n\t\t\ttry {\n\t\t\t\tconst result = await runner.emitToolCall({\n\t\t\t\t\ttype: \"tool_call\",\n\t\t\t\t\ttoolName: toolCall.name,\n\t\t\t\t\ttoolCallId: toolCall.id,\n\t\t\t\t\t...(options.parentToolCallId ? { parentToolCallId: options.parentToolCallId } : {}),\n\t\t\t\t\tinput: args as Record<string, unknown>,\n\t\t\t\t});\n\t\t\t\tif (result?.block) this._finishNativeTool(toolCall.id, true);\n\t\t\t\treturn result;\n\t\t\t} catch (err) {\n\t\t\t\tif (err instanceof Error) {\n\t\t\t\t\tthrow err;\n\t\t\t\t}\n\t\t\t\tthrow new Error(`Extension failed, blocking execution: ${String(err)}`);\n\t\t\t}\n\t\t} catch (error) {\n\t\t\tthis._finishNativeTool(toolCall.id, true);\n\t\t\tthrow error;\n"
      }
    ]
  },
  {
    "version": "5.1.21",
    "commit": "dca10b49c4f13526a79b77a192cfe2641b08d9a7",
    "relativePath": "packages/coding-agent/src/modes/rpc/connection-handler.ts",
    "upstreamSha256": "9c791264f20a9aab06a27580cf2313cb641a4e5c12a79ef049a9c4dc20dcc084",
    "baselineSha256": "c375cdd45f4214eae9f15d160393845f4898d0c8dcaf1365e220c3bd994b4dfc",
    "hookedSha256": "7d9ff50c3fff79e244afea08ab617fc2cfde4172770c9ec702de7be73f5a8233",
    "conflicts": [
      {
        "original": "",
        "native": "import { UNKNOWN_COMMAND_CONFIRM_HINT, UnknownCommandError } from \"../../core/unknown-command.ts\";\nimport { NativeBridgeError, nativeEngineDigest, nativeRemoteScope } from \"../../core/updater-native-bridge.ts\";\n",
        "replacement": "import { NativeBridgeError, nativeEngineDigest, nativeRemoteScope } from \"../../core/updater-native-bridge.ts\";\n"
      }
    ]
  },
  {
    "version": "5.1.21",
    "commit": "dca10b49c4f13526a79b77a192cfe2641b08d9a7",
    "relativePath": "packages/coding-agent/src/modes/rpc/rpc-types.ts",
    "upstreamSha256": "ec58de8818f28f04557f89ccf960907ef36098c4b7bcf96ce89f52cfbdc5d9b1",
    "baselineSha256": "f3a4de7aa26ec2863b538640ec083fc0ecc83e99a458c35faa664f5fd1fc8c03",
    "hookedSha256": "f575089e83f8daae12a2b8f560435f6fd3756765a2a619c53ea8339a9d985b58",
    "conflicts": [
      {
        "original": "import type { ClientMessageAdmission } from \"./client-admission-record.ts\";\n",
        "native": "import type { NativeRemoteBinding, NativeRemoteReceipt } from \"../../core/updater-native-bridge.ts\";\n",
        "replacement": "import type { NativeRemoteBinding, NativeRemoteReceipt } from \"../../core/updater-native-bridge.ts\";\nimport type { ClientMessageAdmission } from \"./client-admission-record.ts\";\n"
      }
    ]
  },
  {
    "version": "5.1.21",
    "commit": "dca10b49c4f13526a79b77a192cfe2641b08d9a7",
    "relativePath": "packages/coding-agent/src/modes/rpc/session-command-router.ts",
    "upstreamSha256": "c0980ce4928de956b369679cfdf231147fe6c9286f6dd3b3d4a12341f2d97d03",
    "baselineSha256": "a0c257e1bfd1a6eb26f4dfcbd851aec287581f5a3a9d23ce75812c721f3825fe",
    "hookedSha256": "42b18d76e52ef9167d7cdc9d0b08dbf568f84f21ee7da2ea7c6955af7c8689a7",
    "conflicts": [
      {
        "original": "import {\n\tACCEPT_EDITS_PERMISSION_PRESET_CAPABILITY,\n\tAUTO_PERMISSION_PRESET_CAPABILITY,\n} from \"../../core/extensions/builtin/permission-system/config.ts\";\nimport { DURABLE_CLIENT_MESSAGE_ID_CAPABILITY } from \"./client-admission-record.ts\";\n",
        "native": "import { ACCEPT_EDITS_PERMISSION_PRESET_CAPABILITY } from \"../../core/extensions/builtin/permission-system/config.ts\";\nimport { nativeEngineDigest, parseNativeRemoteBinding } from \"../../core/updater-native-bridge.ts\";\n",
        "replacement": "import {\n\tACCEPT_EDITS_PERMISSION_PRESET_CAPABILITY,\n\tAUTO_PERMISSION_PRESET_CAPABILITY,\n} from \"../../core/extensions/builtin/permission-system/config.ts\";\nimport { nativeEngineDigest, parseNativeRemoteBinding } from \"../../core/updater-native-bridge.ts\";\nimport { DURABLE_CLIENT_MESSAGE_ID_CAPABILITY } from \"./client-admission-record.ts\";\n"
      }
    ]
  },
  {
    "version": "5.1.21",
    "commit": "dca10b49c4f13526a79b77a192cfe2641b08d9a7",
    "relativePath": "packages/tui/src/terminal.ts",
    "upstreamSha256": "a8bcdc09df81b64e745abb0d1fdfe51717c9ce0a2575c2d6a86612d465473177",
    "baselineSha256": "7637ccafac425a4d892951f990a7f8f36db994ae870cf1d66cb6c93fe15d1899",
    "hookedSha256": "8a44844cd7a168bf7a93c612f592787adb8a7e6f36b491dd89b8c959a4f99c68",
    "conflicts": [
      {
        "original": "\t\tthis.stdinBuffer = new StdinBuffer({\n\t\t\tescapeTimeout: resolveEscapeTimeoutMs(),\n\t\t\tburstWindowMs: resolveBurstWindowMs(),\n\t\t});\n",
        "native": "\t\tthis.stdinBuffer = new StdinBuffer({\n\t\t\tescapeTimeout: resolveEscapeTimeoutMs(),\n\t\t\tmanaged: this.managedInput !== undefined,\n\t\t});\n",
        "replacement": "\t\tthis.stdinBuffer = new StdinBuffer({\n\t\t\tescapeTimeout: resolveEscapeTimeoutMs(),\n\t\t\tburstWindowMs: resolveBurstWindowMs(),\n\t\t\tmanaged: this.managedInput !== undefined,\n\t\t});\n"
      }
    ]
  }
]);

export function resolveCurrentHook({ version, commit, relativePath, upstream, baseline, hooked, conflicted }) {
  const profiles = version === "5.1.21" ? selectedHookResolutions : currentHookResolutions;
  const profile = profiles.find(row => row.relativePath === relativePath);
  if (!profile) throw new Error("Unreviewed current native hook");
  assertReviewedManagerRevision({ version, commit, relativePath, upstreamSha256: hash(upstream),
    baselineSha256: hash(baseline), hookedSha256: hash(hooked) }, profile);
  let count = 0;
  const merged = conflicted.replace(/^<<<<<<< [^\n]+\n([\s\S]*?)^\|\|\|\|\|\|\| [^\n]+\n[\s\S]*?^=======\n([\s\S]*?)^>>>>>>> [^\n]+\n/gm,
    (_block, original, native) => {
      const context = profile.conflicts[count++];
      if (!context || original !== context.original || native !== context.native)
        throw new Error("Unreviewed current native conflict context");
      return context.replacement;
    });
  if (count !== profile.conflicts.length || /^(?:<<<<<<<|=======|>>>>>>>|\|\|\|\|\|\|\|)/m.test(merged))
    throw new Error("Unexpected current native conflict count");
  const { conflicts, ...pins } = profile;
  return { merged, resolution: { ...pins, outputSha256: hash(merged) } };
}

