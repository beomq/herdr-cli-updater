import { AssertionError, strict as assert } from "node:assert";
import { isDeepStrictEqual } from "node:util";
import { fixture, hash, PRIVATE_SENTINEL } from "./fixture";
import { createGrokAdapter } from "../../../../src/adapters/grok";

async function verify(): Promise<void> {
const f = await fixture(createGrokAdapter, "native", PRIVATE_SENTINEL);
try {
  const installation = await f.adapter.detect(f.alias);
  assert.equal(isDeepStrictEqual(installation, { ok: true, value: f.installation }), true, "installation_identity");
  assert.equal((await f.adapter.version(f.installation)).ok, true);
  assert.equal((await f.adapter.check(f.installation)).ok, true);
  const spec = f.adapter.exactResume(f.runtime);
  assert.equal(spec.ok, true);
  if (!spec.ok) throw new Error("verification_failed");
  assert.equal(isDeepStrictEqual(spec.value.command, {
    executable: f.binary, args: ["--resume", f.saved.fullId], cwd: f.cwd, shell: false,
  }), true, "exact_command");
  assert.equal(isDeepStrictEqual(spec.value.expectedBinding, f.runtime.binding), true, "exact_binding");
  assert.equal(spec.value.optionsRef === PRIVATE_SENTINEL, true, "exact_private_options");
  assert.equal(f.cwd.includes(PRIVATE_SENTINEL), true, "private_path_seeded");
  assert.deepEqual(f.adapter.updateSpec(f.installation, "update-only"), { ok: false, error: { code: "receipt_uncertain" } });
  assert.equal(f.adapter.bridge(f.runtime).ok, false);
  assert.equal(f.adapter.gracefulExit(f.runtime, "operation", "owner").ok, false);
  console.log(JSON.stringify({ manual: "PASS", identityVerified: true, bindingVerified: true,
    optionsVerified: true, uuidVerified: true, shellFalse: true, specSha256: hash(JSON.stringify(spec)),
    effects: 0, childPIDCount: 0 }));
} finally { await f.cleanup(); }

// In-memory guard mutation: no shared file is modified, no test command rerun.
// Each mutant must violate its intended behavioral assertion, not merely throw
// on import or fail unrelated setup. Original must satisfy the same assertion.
const production = (await import("node:fs/promises")).readFile;
const source = await production(new URL("../../../../src/adapters/grok.ts", import.meta.url), "utf8");
const guards = [
  { name: "saved-child-identity", guard: 'decoded["resolvedId"] !== binding.session.fullId',
    alter: (x: typeof f) => { x.config.decodeSavedSession = () => ({ ...x.saved, resolvedId: "aaaaaaaa-1234-4234-8234-123456789abc" }); } },
  { name: "unsafe-private-options", guard: 'stored["args"].length !== 0',
    alter: (x: typeof f) => {
      x.state.stored = { ...Object(x.state.stored), args: ["--fork-session"] };
      x.state.live = { ...Object(x.state.live), optionsSha256: hash(JSON.stringify(["--fork-session"])) };
    } },
  { name: "storage-path-hash", guard: 'binding.session.storagePathHash !== hash(path)',
    alter: (x: typeof f) => {
      x.runtime = { ...x.runtime, binding: { ...x.runtime.binding,
        session: { ...x.runtime.binding.session, storagePathHash: hash("wrong") } } };
      x.state.live = { ...Object(x.state.live), runtime: structuredClone(x.runtime) };
    } },
  { name: "release-mapping", guard: 'parser["sourceRef"] !== GROK_PUBLIC_SOURCE_REF',
    alter: (x: typeof f) => { x.state.parser = { ...Object(x.state.parser), sourceRef: "wrong-release" }; } },
];
const transpiler = new Bun.Transpiler({ loader: "ts", target: "bun" });
for (const mutation of guards) {
  assert.equal(source.split(mutation.guard).length, 2, "one exact guard");
  const modified = source.replace(mutation.guard, "false")
    .replaceAll('"../protocol"', JSON.stringify(new URL("../../../../src/protocol.ts", import.meta.url).pathname))
    .replaceAll('"./types"', JSON.stringify(new URL("../../../../src/adapters/types.ts", import.meta.url).pathname));
  const imported: { createGrokAdapter: typeof createGrokAdapter } = await import(
    `data:text/javascript;base64,${Buffer.from(transpiler.transformSync(modified)).toString("base64")}`);
  for (const [factory, expected] of [[createGrokAdapter, false], [imported.createGrokAdapter, true]] as const) {
    const owned = await fixture(factory);
    try {
      assert.equal((await owned.adapter.detect(owned.binary)).ok, true, "setup remains valid");
      mutation.alter(owned);
      const result = owned.adapter.exactResume(owned.runtime);
      assert.equal(result.ok, expected, mutation.name);
      let intendedAssertionFailed = false;
      try { assert.equal(result.ok, false, mutation.name); }
      catch (error) {
        if (!(error instanceof AssertionError)) throw error;
        intendedAssertionFailed = true;
      }
      assert.equal(intendedAssertionFailed, expected, "only mutant fails the intended rejection assertion");
    } finally { await owned.cleanup(); }
  }
  console.log(JSON.stringify({ mutation: mutation.name, originalRejected: true, intendedGuardRemovalAccepted: true, killed: true }));
}
console.log(JSON.stringify({ cleanup: "PASS", ownedRootsRemaining: 0, childPIDCount: 0, effects: 0 }));
}
// Even failed private assertions or IO must not print their payload or paths.
try { await verify(); } catch {
  console.log(JSON.stringify({ manual: "FAIL", effects: 0 }));
  process.exitCode = 1;
}
