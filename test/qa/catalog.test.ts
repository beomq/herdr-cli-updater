import { expect, spyOn, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { catalogExchange, parseCatalogArgs } from "../../scripts/qa/catalog";
import { lifecycleMain } from "../../scripts/qa/lifecycle";
import { withIsolation } from "../../scripts/qa/runner";
import * as runner from "../../scripts/qa/runner";

const taskEvidence = resolve(import.meta.dir, "../../.omo/evidence/herdr-cli-updater/task-1");
const catalogCommand = (destination: string) => ["--scenario", "catalog", "--fixtures",
  "test/fixtures/catalog", "--evidence-dir", destination];

test("catalog admits the exact parent destination and preserves the E/catalog mapping", () => {
  // Given / When
  const parent = parseCatalogArgs(catalogCommand(join(taskEvidence, "catalog-parent-r1")));
  const alias = parseCatalogArgs(catalogCommand("E/catalog"));
  // Then: these values are the output routing contract, not prose.
  expect(parent.evidenceDir).toBe(join(taskEvidence, "catalog-parent-r1"));
  expect(alias.evidenceDir).toBe(join(taskEvidence, "catalog-r1"));
});

test("an empty alternate destination reaches acquisition only after admission", async () => {
  // Given: a unique worker-owned directory; never occupy the parent's destination.
  await mkdir(taskEvidence, { recursive: true });
  const root = await mkdtemp(join(taskEvidence, "catalog-admission-"));
  const destination = join(root, "alternate");
  const acquire = spyOn(runner, "withIsolation").mockImplementation(async () => {
    throw new runner.QaError("acquisition-probe", "acquisition-probe");
  });
  try {
    // When
    await expect(lifecycleMain(catalogCommand(destination))).rejects.toMatchObject({ code: "acquisition-probe" });
    // Then
    expect(acquire).toHaveBeenCalledTimes(1);
    expect(await readdir(destination)).toEqual([]);
  } finally { acquire.mockRestore(); await rm(root, { recursive: true }); }
});

test.each(["occupied", "symlink", "escape"] as const)(
  "catalog refuses %s before isolation or core acquisition",
  async scenario => {
    // Given: intercept only the effect boundary; do not fabricate any runtime result.
    await mkdir(taskEvidence, { recursive: true });
    const root = await mkdtemp(join(taskEvidence, "catalog-admission-"));
    let destination = root;
    let code = "evidence-path";
    const marker = join(root, "marker");
    switch (scenario) {
      case "occupied": await writeFile(marker, "preserved"); code = "evidence-not-empty"; break;
      case "symlink":
        await mkdir(join(root, "actual"));
        await symlink(join(root, "actual"), join(root, "link"));
        destination = join(root, "link", "must-not-exist");
        break;
      case "escape": destination = join(taskEvidence, "..", "must-not-exist"); break;
    }
    const before = await readdir(root);
    const acquire = spyOn(runner, "withIsolation").mockImplementation(async () => {
      throw new runner.QaError("unexpected-acquisition", "unexpected-acquisition");
    });
    try {
      // When
      await expect(lifecycleMain(catalogCommand(destination))).rejects.toMatchObject({ code });
      // Then: the wrong guard cannot pass by throwing after acquiring a core.
      expect(acquire).not.toHaveBeenCalled();
      expect(await readdir(root)).toEqual(before);
      if (scenario === "occupied") expect(await readFile(marker, "utf8")).toBe("preserved");
      if (scenario === "symlink") expect(await readdir(join(root, "actual"))).toEqual([]);
    } finally { acquire.mockRestore(); await rm(root, { recursive: true }); }
  },
);

test("catalog rejects foreign fixtures before writing evidence or acquiring children", async () => {
  // Given
  const run = await withIsolation(async context => {
    const before = await readdir(context.paths.root);
    // When
    const rejected = lifecycleMain(["--scenario", "catalog", "--fixtures", context.paths.prefix,
      "--evidence-dir", join(context.paths.root, "foreign")]);
    // Then
    await expect(rejected).rejects.toMatchObject({ code: "invalid-command" });
    expect(await readdir(context.paths.root)).toEqual(before);
  });
  expect(run.executions).toHaveLength(0);
  expect(run.cleanup.resourcesRemaining).toBe(0);
});

test("catalog rejects foreign output and malformed arguments at admission", () => {
  // Given
  const args = ["--scenario", "catalog", "--fixtures", "test/fixtures/catalog",
    "--evidence-dir", "/tmp/not-owned"];
  // When / Then
  expect(() => parseCatalogArgs(args)).toThrow(expect.objectContaining({ code: "evidence-path" }));
  expect(() => parseCatalogArgs(args.slice(0, 4))).toThrow(expect.objectContaining({ code: "invalid-command" }));
});

test.each(["echo", "wrong-id", "early-close"] as const)(
  "catalog wire %s retains response identity and terminal failure",
  async mode => {
    // Given: an NDJSON echo/close transport, NOT a core or native qualification mock.
    const run = await withIsolation(async context => {
      const path = join(context.paths.sockets, "echo.sock");
      const server = createServer(socket => {
        socket.setEncoding("utf8");
        socket.on("error", () => socket.destroy());
        let bytes = "";
        socket.on("data", chunk => {
          bytes += chunk;
          const end = bytes.indexOf("\n");
          if (end < 0) return;
          switch (mode) {
            case "echo": socket.end(bytes.slice(0, end + 1)); break;
            case "wrong-id": {
              const request: unknown = JSON.parse(bytes.slice(0, end));
              if (typeof request !== "object" || request === null) throw new TypeError("request envelope");
              socket.end(JSON.stringify({ ...request, id: "different-request" }) + "\n");
              break;
            }
            case "early-close": socket.end(); break;
          }
        });
      });
      const listening = new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(path, resolve);
      });
      await listening;
      await chmod(path, 0o600);
      try {
        // When: all data/close/error subscriptions precede the write.
        const response = catalogExchange(path, "ping", { marker: "transport-only" });
        // Then
        switch (mode) {
          case "echo":
            expect(await response).toMatchObject({ method: "ping", params: { marker: "transport-only" } });
            break;
          case "wrong-id": await expect(response).rejects.toMatchObject({ code: "response-identity" }); break;
          case "early-close": await expect(response).rejects.toMatchObject({ code: "response-missing" }); break;
        }
      } finally {
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      }
    });
    expect(run.cleanup).toMatchObject({ rootRemoved: true, actionState: "joined", resourcesRemaining: 0 });
  },
  10000,
);

test("catalog cannot issue an unregistered mutating method", async () => {
  // Given / When: method admission must occur before even opening a missing socket.
  const response = catalogExchange("/not-a-task-socket", "updater.native.launch.v1", { profile: "forged" });
  // Then
  await expect(response).rejects.toMatchObject({ code: "unregistered-method" });
});
