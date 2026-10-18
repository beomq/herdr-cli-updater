import { expect, test } from "bun:test";
import { connect } from "node:net";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { socketChild, malformedChild, quietChild } from "../../scripts/qa/fixtures";
import { copyPrivateBinary, dispatchRegistry, fileDigest, hashBytes, produceArchive, produceBuild, QaError, RunFailure, withIsolation } from "../../scripts/qa/runner";
import { registry } from "../../scripts/qa/registry";
import type { CleanupReceipt, QaContext } from "../../scripts/qa/runner";
import { homedir } from "node:os";

const childArgs = (script: string): readonly [string, ...string[]] => [process.execPath, "-e", script];

test.each([
  { scope: undefined, total: 24 },
  { scope: "plugin-only" as const, total: 22 },
])("plugin dispatch selects $total after full admission with scope $scope", async ({ scope, total }) => {
  // Given: an empty owned project has no runners or native prerequisites.
  const result = await withIsolation(async (context) => {
    const path = join(context.paths.tmp, "registry.json");
    await writeFile(path, JSON.stringify(registry));
    const evidence = join(context.paths.root, ".omo/evidence/herdr-cli-updater/task8/plugin-only-dispatch-r1");
    // When
    return await dispatchRegistry(path, evidence, context.paths.root, scope);
  });
  // Then: selection is not native success, and excluded rows are never dispatched.
  expect(result.value.admittedTotal).toBe(24);
  expect(result.value.total).toBe(total);
  expect(result.value.outcomes.map(entry => entry.id)).toEqual(registry.scenarios
    .filter(entry => scope === undefined || !["web-desktop-mobile", "web-existing-regression"].includes(entry.id))
    .map(entry => entry.id));
  expect(result.value.deferred).toEqual(scope === undefined ? [] : [
    { id: "web-desktop-mobile", status: "DEFERRED_USER_SCOPE", effects: 0, qualified: 0 },
    { id: "web-existing-regression", status: "DEFERRED_USER_SCOPE", effects: 0, qualified: 0 },
  ]);
  expect(result.value).toMatchObject({ status: "FAIL", qualified: 0, effects: 0, FullDone: false });
  expect(result.value.outcomes.every(entry => entry.status === "BLOCKED" && entry.exitCode === null)).toBe(true);
  expect(result.executions).toHaveLength(0);
  await clean(result.cleanup);
});

test.each([
  { name: "missing excluded row", value: { ...registry, scenarios: registry.scenarios.filter(entry => entry.id !== "web-desktop-mobile") } },
  { name: "duplicate row", value: { ...registry, scenarios: [...registry.scenarios, registry.scenarios[0]] } },
  { name: "changed excluded row", value: { ...registry, scenarios: registry.scenarios.map(entry =>
    entry.id === "web-existing-regression" ? { ...entry, cwd: "P" } : entry) } },
  { name: "malformed shape", value: { version: 1, scenarios: [] } },
])("plugin dispatch rejects $name before evidence effects", async ({ value }) => {
  // Given
  const result = await withIsolation(async (context) => {
    const path = join(context.paths.tmp, "registry.json");
    await writeFile(path, JSON.stringify(value));
    const evidence = join(context.paths.root, ".omo/evidence/herdr-cli-updater/task8/plugin-only-dispatch-r1");
    // When / Then: scope cannot rescue an invalid full registry.
    await expect(dispatchRegistry(path, evidence, context.paths.root, "plugin-only"))
      .rejects.toHaveProperty("code", "registry-mismatch");
    await expect(stat(join(context.paths.root, ".omo"))).rejects.toHaveProperty("code", "ENOENT");
  });
  expect(result.executions).toHaveLength(0);
  await clean(result.cleanup);
});

test.each([
  { name: "unknown scope", args: ["--scope", "web"] },
  { name: "duplicate scope", args: ["--scope", "plugin-only", "--scope", "plugin-only"] },
  { name: "missing scope value", args: ["--scope"] },
  { name: "unknown option", args: ["--unknown"] },
  { name: "duplicate all", args: ["--all"] },
  { name: "duplicate registry", args: ["--registry", "/missing"] },
  { name: "duplicate evidence", args: ["--evidence-dir", "/missing"] },
  { name: "positional value", args: ["plugin-only"] },
])("plugin dispatch CLI rejects $name before registry or evidence effects", async ({ args }) => {
  // Given: a nonexistent registry distinguishes argument admission from file IO.
  const runner = fileURLToPath(new URL("../../scripts/qa/runner.ts", import.meta.url));
  const result = await withIsolation(async (context) => {
    const evidence = join(context.paths.tmp, "not-created");
    // When
    const execution = await context.invoke([process.execPath, runner,
      "--registry", join(context.paths.tmp, "missing.json"), "--all", "--evidence-dir", evidence, ...args]);
    // Then
    expect(execution.exitCode).toBe(2);
    expect(JSON.parse(execution.stdout)).toMatchObject({
      status: "BLOCKED", blockedField: "runner.arguments", code: "invalid-arguments", effects: 0,
    });
    await expect(stat(evidence)).rejects.toHaveProperty("code", "ENOENT");
  });
  await clean(result.cleanup);
});

test.each([
  { name: "missing all", args: ["--registry", "/missing", "--evidence-dir", "/missing"] },
  { name: "missing registry", args: ["--all", "--evidence-dir", "/missing"] },
  { name: "missing evidence", args: ["--registry", "/missing", "--all"] },
  { name: "missing path value", args: ["--registry"] },
  { name: "relative path", args: ["--registry", "relative.json", "--all", "--evidence-dir", "/missing"] },
])("plugin dispatch CLI rejects $name with effects zero", async ({ args }) => {
  // Given
  const runner = fileURLToPath(new URL("../../scripts/qa/runner.ts", import.meta.url));
  const result = await withIsolation(async (context) => {
    // When
    return await context.invoke([process.execPath, runner, ...args]);
  });
  // Then
  expect(result.value.exitCode).toBe(2);
  expect(JSON.parse(result.value.stdout)).toMatchObject({ code: "invalid-arguments", effects: 0 });
  await clean(result.cleanup);
});

test.each([
  { scopeArgs: [], total: 24 },
  { scopeArgs: ["--scope", "plugin-only"], total: 22 },
])("plugin dispatch actual CLI records $total blocked rows without launches", async ({ scopeArgs, total }) => {
  // Given: exact source bytes, not a mock dispatcher, in an empty owned project.
  const result = await withIsolation(async (context) => {
    const qa = join(context.paths.root, "scripts/qa");
    await mkdir(qa, { recursive: true });
    for (const name of ["runner.ts", "registry.ts"]) {
      await writeFile(join(qa, name), await readFile(new URL(`../../scripts/qa/${name}`, import.meta.url)));
    }
    const path = join(context.paths.tmp, "registry.json");
    await writeFile(path, JSON.stringify(registry));
    const evidence = join(context.paths.root, ".omo/evidence/herdr-cli-updater/task8/plugin-only-dispatch-r1");
    // When
    const execution = await context.invoke([process.execPath, join(qa, "runner.ts"),
      "--registry", path, "--all", ...scopeArgs, "--evidence-dir", evidence]);
    // Then
    expect(execution.exitCode).toBe(1);
    const machine = JSON.parse(execution.stdout);
    expect(machine).toMatchObject({ total, admittedTotal: 24, qualified: 0, effects: 0, FullDone: false });
    expect(machine.deferred).toHaveLength(24 - total);
    const rows = await readdir(machine.runDir);
    expect(rows.filter(name => name !== "registry.json" && name !== "result.json")).toHaveLength(total);
    for (const outcome of machine.outcomes) {
      expect(outcome).toMatchObject({ status: "BLOCKED", exitCode: null, effects: 0 });
      expect(JSON.parse(await readFile(join(machine.runDir, outcome.id, "actions.jsonl"), "utf8")).execution).toBeNull();
      expect(JSON.parse(await readFile(join(machine.runDir, outcome.id, "cleanup.json"), "utf8")))
        .toMatchObject({ resourcesRemaining: 0, processes: [] });
    }
  });
  await clean(result.cleanup);
});

async function clean(receipt: CleanupReceipt): Promise<void> {
  expect(receipt.resourcesRemaining).toBe(0);
  expect(receipt.rootRemoved).toBe(true);
  expect(await Bun.file(receipt.root).exists()).toBe(false);
  // Directory existence is checked independently from Bun.file's regular-file API.
  await expect(stat(receipt.root)).rejects.toHaveProperty("code", "ENOENT");
  for (const entry of receipt.processes) {
    expect(() => process.kill(entry.pid, 0)).toThrow();
  }
}

async function failed(action: (context: QaContext) => Promise<unknown>, options: { readonly timeoutMs?: number; readonly signal?: AbortSignal } = {}): Promise<RunFailure> {
  try { await withIsolation(action, options); }
  catch (error) {
    if (!(error instanceof RunFailure)) throw error;
    await clean(error.cleanup);
    return error;
  }
  throw new QaError("test", "expected run failure");
}

test("observes real ready barrier and Unix socket reply in private directories", async () => {
  // Given: real child and task-owned socket, with ready subscription armed at spawn.
  const result = await withIsolation(async (context) => {
    const child = await context.spawn({ argv: childArgs(socketChild), readyEvent: "ready" });
    // When: observed listen event gates the actual socket connection.
    const ready = await child.ready;
    expect(ready?.event).toBe("ready");
    const response = await new Promise<string>((resolve, reject) => {
      const socket = connect(join(context.paths.sockets, "core.sock"));
      const deadline = setTimeout(() => { socket.destroy(); reject(new QaError("deadline", "socket response timeout")); }, 2000);
      let text = "";
      socket.on("error", (error) => { clearTimeout(deadline); reject(error); });
      socket.on("data", (bytes) => { text += bytes.toString(); });
      socket.on("end", () => { clearTimeout(deadline); resolve(text); });
      socket.on("connect", () => socket.write("ping"));
    });
    // Then: transport really answered and isolation is not operating HOME.
    expect(response).toBe("pong");
    expect(context.paths.root.length).toBeLessThan(50);
    for (const path of Object.values(context.paths)) expect((await stat(path)).mode & 0o777).toBe(0o700);
    expect((await stat(join(context.paths.sockets, "core.sock"))).mode & 0o777).toBe(0o600);
    return context.paths;
  });
  await clean(result.cleanup);
  expect(result.executions[0]?.env["HOME"]).toBe(result.value.home);
  expect(result.executions[0]?.env["QA_PTYS"]).toBe(result.value.ptys);
  expect(result.executions[0]?.env["OPENAI_API_KEY"]).toBeUndefined();
});

test("subscribes to event and exit before writing real child command", async () => {
  // Given
  const result = await withIsolation(async (context) => {
    const child = await context.spawn({ argv: childArgs(socketChild), readyEvent: "ready" });
    await child.ready;
    const ack = child.waitFor("ack");
    // When
    child.write("emit\n");
    // Then
    expect((await ack).event).toBe("ack");
    const exit = child.exited;
    child.write("exit\n");
    expect(await exit).toBe(0);
  });
  await clean(result.cleanup);
  expect(result.executions[0]?.exitCode).toBe(0);
});

test("observes actual SIGTERM event before owned process exit", async () => {
  // Given
  const result = await withIsolation(async (context) => {
    const child = await context.spawn({ argv: childArgs(socketChild), readyEvent: "ready" });
    await child.ready;
    const terminated = child.waitFor("terminated");
    const exit = child.exited;
    // When
    child.signal("SIGTERM");
    // Then
    expect((await terminated).event).toBe("terminated");
    expect(await exit).toBe(0);
  });
  await clean(result.cleanup);
});

test("rejects missing executable and removes private root", async () => {
  // Given / When
  const failure = await failed(async (context) => context.invoke([join(context.paths.prefix, "missing")]));
  // Then
  expect(failure.executions).toHaveLength(0);
  expect(failure.original).toHaveProperty("code", "ENOENT");
});

test("malformed real stdout never becomes readiness and child is cleaned", async () => {
  // Given / When
  const failure = await failed(async (context) => {
    const child = await context.spawn({ argv: childArgs(malformedChild), readyEvent: "ready" });
    await child.ready;
  });
  // Then
  expect(failure.original).toHaveProperty("code", "malformed-event");
  expect(failure.executions).toHaveLength(1);
});

test("finally cleans real child socket when scenario throws after readiness", async () => {
  // Given / When
  const failure = await failed(async (context) => {
    const child = await context.spawn({ argv: childArgs(socketChild), readyEvent: "ready" });
    await child.ready;
    throw new QaError("scenario", "deliberate action failure");
  });
  // Then
  expect(failure.original).toHaveProperty("code", "scenario");
  expect(failure.executions[0]?.stdout).toContain('"event":"ready"');
});

test("cancellation after observed ready removes owned socket and process", async () => {
  // Given
  const controller = new AbortController();
  // When
  const failure = await failed(async (context) => {
    const child = await context.spawn({ argv: childArgs(socketChild), readyEvent: "ready" });
    await child.ready;
    const pending = child.waitFor("never", 2000, controller.signal);
    controller.abort();
    await pending;
  }, { signal: controller.signal });
  // Then
  expect(failure.original).toHaveProperty("code", "cancelled");
  expect(failure.executions).toHaveLength(1);
});

test("bounded readiness deadline fails without polling and tears down child", async () => {
  // Given / When: timer expiration itself is the behavior under test.
  const failure = await failed(async (context) => {
    const child = await context.spawn({ argv: childArgs(quietChild), readyEvent: "ready", eventTimeoutMs: 25 });
    await child.ready;
  });
  // Then
  expect(failure.original).toHaveProperty("code", "deadline");
  expect(failure.executions).toHaveLength(1);
});

test("captures nonzero real execution and output hashes independent of claims", async () => {
  // Given
  const script = 'process.stdout.write("actual-output"); process.stderr.write("actual-error"); process.exit(7)';
  const result = await withIsolation(async (context) => {
    // When
    return await context.invoke(childArgs(script));
  });
  // Then
  expect(result.value.exitCode).toBe(7);
  expect(result.value.stdout).toBe("actual-output");
  expect(result.value.stderr).toBe("actual-error");
  expect(result.value.stdoutSha256).toBe(hashBytes("actual-output"));
  expect(result.value.stderrSha256).toBe(hashBytes("actual-error"));
  expect(result.value.executableSha256).toBe(await fileDigest(process.execPath));
  await clean(result.cleanup);
});

test("private binary copy rejects stale bytes rather than trusting receipt string", async () => {
  // Given / When
  const failure = await failed(async (context) => {
    const source = join(context.paths.tmp, "binary");
    await writeFile(source, "actual-binary");
    return await copyPrivateBinary(context, source, hashBytes("claimed-binary"));
  });
  // Then
  expect(failure.original).toHaveProperty("code", "stale-binary");
});

test("archive producer rejects dirty source before build or qualification", async () => {
  // Given
  const failure = await failed(async (context) => {
    const init = await context.invoke(["/usr/bin/git", "init", context.paths.core]);
    expect(init.exitCode).toBe(0);
    await writeFile(join(context.paths.core, "untracked.rs"), "dirty");
    // When
    return await produceArchive(context, context.paths.core, "0".repeat(40));
  });
  // Then
  expect(failure.original).toHaveProperty("code", "dirty-source");
  expect(failure.executions.some((entry) => entry.argv.includes("archive"))).toBe(false);
});

test("receipt-only copied binary is never promoted by successful execution", async () => {
  // Given
  const result = await withIsolation(async (context) => {
    const binary = await copyPrivateBinary(context, process.execPath);
    // When
    const execution = await context.invoke([binary.path, "--version"]);
    // Then
    expect(execution.exitCode).toBe(0);
    expect(binary.qualification).toBe("receipt-only");
    expect(execution.state).toBe("observed");
    return execution;
  });
  await clean(result.cleanup);
});

test("real child exit without ready cannot be adopted as readiness", async () => {
  // Given / When
  const failure = await failed(async (context) => {
    const child = await context.spawn({ argv: childArgs("process.exit(3)"), readyEvent: "ready" });
    await child.ready;
  });
  // Then
  expect(failure.original).toHaveProperty("code", "exited");
  expect(failure.executions[0]?.exitCode).toBe(3);
});

test("invocation deadline cleans a real child while its exit is still pending", async () => {
  // Given / When: elapsed deadline is itself under test.
  const failure = await failed(async (context) => context.invoke(childArgs(quietChild), 25));
  // Then
  expect(failure.original).toHaveProperty("code", "deadline");
  expect(failure.executions).toHaveLength(1);
});

test("rejects a non-string real event field and removes owned resources", async () => {
  // Given / When
  const failure = await failed(async (context) => {
    const child = await context.spawn({ argv: childArgs('console.log(JSON.stringify({event: 1})); process.stdin.resume()'), readyEvent: "ready" });
    await child.ready;
  });
  // Then
  expect(failure.original).toHaveProperty("code", "malformed-event");
});

test("pre-cancelled run cannot create a real child", async () => {
  // Given
  const controller = new AbortController();
  controller.abort();
  // When
  const failure = await failed(async (context) => context.invoke(childArgs(quietChild)), { signal: controller.signal });
  // Then
  expect(failure.original).toHaveProperty("code", "cancelled");
  expect(failure.executions).toHaveLength(0);
});

test("caller-created matching archive receipt cannot become observed build input", async () => {
  // Given: a real execution receipt, but no observed source archive/extraction.
  const failure = await failed(async (context) => {
    const execution = await context.invoke([process.execPath, "--version"]);
    const claimed = {
      state: "observed" as const, sourceRef: "0".repeat(40), sourceTree: "0".repeat(40),
      sourceArchiveSha256: hashBytes("claimed-archive"),
      archivePath: join(context.paths.core, "source.tar"), extractedRoot: context.paths.core,
      sourceStatus: execution, commitObservation: execution, treeObservation: execution, archive: execution, extraction: execution,
    };
    // When
    return await produceBuild(context, claimed, [process.execPath, "--version"], [process.execPath, "--version"], "target/bin");
  });
  // Then: no compiler/build execution is started from a receipt-only claim.
  expect(failure.original).toHaveProperty("code", "unobserved-archive");
  expect(failure.executions).toHaveLength(1);
});

test("T8-A1 joins deadline-triggered action effects before claiming cleanup0", async () => {
  // Given: the cancellation barrier is subscribed before the deadline action.
  const controller = new AbortController();
  const finished = Promise.withResolvers<void>();
  let root = "";
  let spawnFailure: unknown;
  try {
    const failure = await failed(async (context) => {
      root = context.paths.root;
      await new Promise<void>((resolve) => {
        context.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      // Actual post-deadline filesystem effects cannot be cancelled by JavaScript.
      await mkdir(root, { recursive: true });
      await writeFile(join(root, "late-effect"), "actual");
      try { await context.spawn({ argv: childArgs(quietChild) }); }
      catch (error) { spawnFailure = error; }
      finished.resolve();
    }, { timeoutMs: 25, signal: controller.signal });
    // When: old implementation only releases the action after returning cleanup0.
    controller.abort();
    await finished.promise;
    // Then: a correct implementation already joined and removed the late write.
    expect(failure.original).toHaveProperty("code", "deadline");
    expect(spawnFailure).toBeInstanceOf(QaError);
    await expect(stat(root)).rejects.toHaveProperty("code", "ENOENT");
  } finally {
    controller.abort();
    await finished.promise;
    if (root) await rm(root, { recursive: true, force: true });
  }
});

const pinnedCoreSource = `${homedir()}/Desktop/herdr-updater-core`;
const pinnedCoreRef = "065ef9d6a531c49fb8bee7e818ef837065b21ee9";

async function acquirePinnedCore(context: QaContext): Promise<string> {
  const source = join(context.paths.tmp, "pinned-core");
  const clone = await context.invoke([
    "/usr/bin/git", "clone", "--local", "--no-checkout", "--no-hardlinks", pinnedCoreSource, source,
  ]);
  expect(clone.exitCode).toBe(0);
  const checkout = await context.invoke(["/usr/bin/git", "-C", source, "checkout", "--detach", pinnedCoreRef]);
  expect(checkout.exitCode).toBe(0);
  const head = await context.invoke(["/usr/bin/git", "-C", source, "rev-parse", "--verify", "HEAD^{commit}"]);
  const ref = await context.invoke(["/usr/bin/git", "-C", source, "rev-parse", "--verify", `${pinnedCoreRef}^{commit}`]);
  expect(head.exitCode).toBe(0);
  expect(ref.exitCode).toBe(0);
  expect(head.stdout.trim()).toBe(pinnedCoreRef);
  expect(ref.stdout.trim()).toBe(pinnedCoreRef);
  const detached = await context.invoke(["/usr/bin/git", "-C", source, "symbolic-ref", "--quiet", "HEAD"]);
  expect(detached.exitCode).toBe(1);
  expect(detached.stdout).toBe("");
  const status = await context.invoke(["/usr/bin/git", "-C", source, "status", "--porcelain=v1", "--untracked-files=all"]);
  expect(status.exitCode).toBe(0);
  expect(status.stdout).toBe("");
  return source;
}

test("T8-A2 cannot adopt prewritten output from a successful no-op build", async () => {
  // Given: a genuine observed archive, not fabricated source receipt JSON.
  const failure = await failed(async (context) => {
    const archive = await produceArchive(context, await acquirePinnedCore(context), pinnedCoreRef);
    const output = join(context.paths.core, "target/release/herdr");
    await mkdir(join(context.paths.core, "target/release"), { recursive: true });
    await writeFile(output, "not-compiled");
    // When
    return await produceBuild(context, archive, [process.execPath, "--version"], [process.execPath, "--version"], "target/release/herdr");
  });
  // Then
  expect(failure.original).toHaveProperty("code", "preexisting-output");
}, 15000);

test("T8-A3 rejects mutation of a genuine archive source binding", async () => {
  // Given: producer-observed archive and actual source commit.
  const failure = await failed(async (context) => {
    const archive = await produceArchive(context, await acquirePinnedCore(context), pinnedCoreRef);
    Reflect.set(archive, "sourceRef", "f".repeat(40));
    await mkdir(join(context.paths.core, "target/release"), { recursive: true });
    await writeFile(join(context.paths.core, "target/release/herdr"), "not-compiled");
    // When
    return await produceBuild(context, archive, [process.execPath, "--version"], [process.execPath, "--version"], "target/release/herdr");
  });
  // Then: reject this changed real binding before any generic compiler gate.
  expect(failure.original).toHaveProperty("code", "source-binding");
}, 15000);

test("T8-A4 direct all CLI rejects missing registry rather than exit0 no-op", async () => {
  // Given
  const runner = fileURLToPath(new URL("../../scripts/qa/runner.ts", import.meta.url));
  const result = await withIsolation(async (context) => {
    // When
    return await context.invoke([process.execPath, runner, "--registry", "/nonexistent/task8-registry.json", "--all", "--evidence-dir", context.paths.tmp]);
  });
  try {
    // Then: machine status, not prose, determines the outcome.
    expect(result.value.exitCode).not.toBe(0);
    const machine: unknown = JSON.parse(result.value.stdout);
    expect(machine).toMatchObject({ status: "BLOCKED", blockedField: "runner.registry", code: "registry-io", effects: 0, FullDone: false });
  } finally { await clean(result.cleanup); }
});

test("reports noncooperative action as unjoined until its eventual cleanup", async () => {
  // Given: a deliberately noncooperative action with an explicit release event.
  const release = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  let root = "";
  let failure: RunFailure | undefined;
  const run = withIsolation(async (context) => {
    root = context.paths.root;
    entered.resolve();
    await release.promise;
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "late-write"), "actual");
    await expect(copyPrivateBinary(context, process.execPath)).rejects.toHaveProperty("code", "closed");
  }, { timeoutMs: 25, joinTimeoutMs: 25 });
  try {
    await entered.promise;
    // When: the action deadline and bounded join both expire.
    try { await run; }
    catch (error) { if (!(error instanceof RunFailure)) throw error; failure = error; }
    // Then: no cleanup0 claim is allowed while this action can still write.
    if (!failure) throw new QaError("test", "expected unjoined action failure");
    expect(failure.code).toBe("action-unjoined");
    expect(failure.cleanup.actionState).toBe("pending");
    expect(failure.cleanup.resourcesRemaining).toBeGreaterThan(0);
    expect((await stat(root)).isDirectory()).toBe(true);
    release.resolve();
    await clean(await failure.finalCleanup);
  } finally {
    release.resolve();
    if (failure) await failure.finalCleanup;
    if (root) await rm(root, { recursive: true, force: true });
  }
});

test("joins admitted filesystem effects even when action did not await them", async () => {
  // Given: a context-admitted effect subscribed to closure before action returns.
  const result = await withIsolation(async (context) => {
    const cancelled = new Promise<void>((resolve) => context.signal.addEventListener("abort", () => resolve(), { once: true }));
    const effect = context.admit(async () => {
      await cancelled;
      await writeFile(join(context.paths.root, "admitted-write"), "actual");
    });
    // When: action returns but the context effect remains outstanding.
    return { effect };
  });
  // Then: only settled effects allow a joined cleanup0 receipt.
  await result.value.effect;
  expect(result.cleanup.actionState).toBe("joined");
  await clean(result.cleanup);
});

test("rejects no-op compiler argv even without a preexisting output", async () => {
  // Given: genuine unchanged core archive and absent build target.
  const failure = await failed(async (context) => {
    const archive = await produceArchive(context, await acquirePinnedCore(context), pinnedCoreRef);
    // When
    return await produceBuild(context, archive, [process.execPath, "--version"], [process.execPath, "--version"], "target/release/herdr");
  });
  // Then: successful version commands cannot count as compilation.
  expect(failure.original).toHaveProperty("code", "build-command");
  expect(failure.executions.some((entry) => entry.executable === process.execPath)).toBe(false);
}, 15000);

test("runner import has no CLI output or process effects", async () => {
  // Given
  const runner = new URL("../../scripts/qa/runner.ts", import.meta.url).href;
  const result = await withIsolation(async (context) => {
    // When
    return await context.invoke(childArgs(`await import(${JSON.stringify(runner)}); console.log(JSON.stringify({imported:true}))`));
  });
  // Then: no main result preceded the actual import completion.
  expect(result.value.exitCode).toBe(0);
  expect(JSON.parse(result.value.stdout)).toEqual({ imported: true });
  await clean(result.cleanup);
});

test("invalid runner arguments return explicit blocked machine result", async () => {
  // Given
  const runner = fileURLToPath(new URL("../../scripts/qa/runner.ts", import.meta.url));
  const result = await withIsolation(async (context) => {
    // When
    return await context.invoke([process.execPath, runner, "--definitely-invalid-task8-flag"]);
  });
  // Then
  expect(result.value.exitCode).toBe(2);
  expect(JSON.parse(result.value.stdout)).toMatchObject({ status: "BLOCKED", code: "invalid-arguments", effects: 0 });
  await clean(result.cleanup);
});

test("rejects caller compiler mimics even with expected names and version text", async () => {
  // Given: genuine source; caller executables are not the acquired private toolchain.
  const failure = await failed(async (context) => {
    const archive = await produceArchive(context, await acquirePinnedCore(context), pinnedCoreRef);
    const rustc = join(context.paths.prefix, "rustc");
    const cargo = join(context.paths.prefix, "cargo");
    await writeFile(rustc, `#!${process.execPath}\nconsole.log("rustc 1.96.1 (caller)")\n`, { mode: 0o700 });
    await writeFile(cargo, `#!${process.execPath}\nconsole.log("cargo 1.96.1 (caller)")\n`, { mode: 0o700 });
    // When
    return await produceBuild(context, archive, [rustc, "--version"], [cargo, "build", "--locked", "--release"], "target/release/herdr");
  });
  // Then: no caller compiler process ran, and no observed build was emitted.
  expect(failure.original).toHaveProperty("code", "compiler-acquisition");
  expect(failure.executions.every((entry) => !entry.executable.startsWith(join(failure.cleanup.root, "i")))).toBe(true);
}, 15000);

test("T8-R3 action join waits for external release", async () => {
  // Given: every barrier exists before the action can perform its filesystem effect.
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const finished = Promise.withResolvers<void>();
  let root = "";
  let written = "";
  let failure: RunFailure | undefined;
  const run = withIsolation(async (context) => {
    root = context.paths.root;
    entered.resolve();
    try {
      await release.promise;
      await mkdir(root, { recursive: true });
      const path = join(root, "external-action");
      await writeFile(path, "actual-action");
      written = await readFile(path, "utf8");
    } finally { finished.resolve(); }
  }, { timeoutMs: 25, joinTimeoutMs: 25 });
  try {
    await entered.promise;
    // When: deadline/join expire while the external release is still unresolved.
    try { await run; }
    catch (error) { if (!(error instanceof RunFailure)) throw error; failure = error; }
    // Then: removal of actionSettled cannot hide behind filesystem scheduling.
    expect(failure?.cleanup.actionState).toBe("pending");
    expect(failure?.cleanup.resourcesRemaining).toBe(1);
    expect((await stat(root)).isDirectory()).toBe(true);
    release.resolve();
    await finished.promise;
    if (!failure) throw new QaError("test", "missing action join failure");
    const cleanup = await failure.finalCleanup;
    expect(written).toBe("actual-action");
    await clean(cleanup);
  } finally {
    release.resolve();
    await finished.promise;
    if (failure) await failure.finalCleanup;
    if (root) await rm(root, { recursive: true, force: true });
  }
});

test("T8-R3 admitted read copy waits for external release", async () => {
  // Given: real source bytes and an external copy barrier registered before admission.
  const readReady = Promise.withResolvers<void>();
  const releaseCopy = Promise.withResolvers<void>();
  const finished = Promise.withResolvers<void>();
  const sourceBytes = Buffer.from([0x19, 0x73, 0xa4, 0x05]);
  let root = "";
  let copied: Uint8Array | undefined;
  let failure: RunFailure | undefined;
  const run = withIsolation(async (context) => {
    root = context.paths.root;
    const source = join(root, "read-source");
    await writeFile(source, sourceBytes);
    context.admit(async () => {
      try {
        const bytes = await readFile(source);
        readReady.resolve();
        await releaseCopy.promise;
        await mkdir(root, { recursive: true });
        const target = join(root, "admitted-copy");
        await writeFile(target, bytes);
        copied = await readFile(target);
      } finally { finished.resolve(); }
    });
    await readReady.promise;
  }, { joinTimeoutMs: 25 });
  try {
    await readReady.promise;
    // When: the action has finished, but its admitted real read/copy has not.
    try { await run; }
    catch (error) { if (!(error instanceof RunFailure)) throw error; failure = error; }
    // Then: admission join must keep the owned scope pending before copy release.
    expect(failure?.cleanup.actionState).toBe("pending");
    expect(failure?.cleanup.resourcesRemaining).toBe(1);
    expect((await stat(root)).isDirectory()).toBe(true);
    releaseCopy.resolve();
    await finished.promise;
    if (!failure) throw new QaError("test", "missing admission join failure");
    const cleanup = await failure.finalCleanup;
    expect(copied).toEqual(sourceBytes);
    await clean(cleanup);
  } finally {
    releaseCopy.resolve();
    await finished.promise;
    if (failure) await failure.finalCleanup;
    if (root) await rm(root, { recursive: true, force: true });
  }
});

test("T8-R3 exact compiler argv rejects before genuine invocation", async () => {
  // Given: genuine acquired executable names/bytes bypass all later mimic guards.
  const bin = `${homedir()}/Desktop/herdr-updater-toolchain/rustup/toolchains/1.96.1-aarch64-apple-darwin/bin`;
  const rustc = join(bin, "rustc");
  const cargo = join(bin, "cargo");
  const failure = await failed(async (context) => {
    const archive = await produceArchive(context, await acquirePinnedCore(context), pinnedCoreRef);
    // When: --locked is deliberately missing from otherwise genuine compiler argv.
    return await produceBuild(context, archive, [rustc, "--version"], [cargo, "build", "--release"], "target/release/herdr");
  });
  // Then: the exact argv gate, not a basename/acquisition/build failure, rejects.
  expect(failure.original).toHaveProperty("code", "build-command");
  expect(failure.executions.filter((entry) => entry.executable === rustc || entry.executable === cargo)).toHaveLength(0);
}, 15000);
