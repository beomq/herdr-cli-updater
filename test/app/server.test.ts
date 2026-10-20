import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { commandServer, controlServer, startServer } from "../../src/app/server";

const state = z.object({ revision: z.number(), serverInstance:z.string().uuid(),service: z.enum(["connecting", "ready", "unavailable"]), failure: z.string().nullable() });

async function ready(origin:string,cookie:string):Promise<void>{
  const abort=new AbortController();
  try{
    const response=await fetch(`${origin}/api/events`,{headers:{cookie},signal:AbortSignal.any([abort.signal,AbortSignal.timeout(15000)])});
    if(!response.body)throw new Error('missing stream');
    let pending='';
    for await(const chunk of response.body){
      pending+=new TextDecoder().decode(chunk);
      let boundary:number;
      while((boundary=pending.indexOf('\n\n'))>=0){
        const frame=pending.slice(0,boundary);pending=pending.slice(boundary+2);
        const data=frame.split('\n').find(line=>line.startsWith('data: '))?.slice(6);
        if(data&&state.parse(JSON.parse(data)).service!=='connecting')return;
      }
    }
    throw new Error('stream ended before initialization');
  }finally{abort.abort();}
}

test('approved browser cookie survives a real service restart while bootstrap and origin guards remain',async()=>{
  const root=realpathSync(mkdtempSync('/tmp/app-auth-restart-'));
  const assets=join(root,'assets');mkdirSync(assets,{mode:0o700});
  for(const name of ['index.html','main.js','main.css'])writeFileSync(join(assets,name),name,{mode:0o600});
  const options={directory:join(root,'state'),home:root,path:'',prefixes:[],assets};
  let service=await startServer(options);
  try{
    const origin=service.owner.origin;
    const token=new URLSearchParams(new URL(service.url).hash.slice(1)).get('token');
    const login=await fetch(`${origin}/api/session`,{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({token})});
    const cookie=login.headers.get('set-cookie')?.split(';')[0];if(!cookie)throw new Error('missing cookie');
    expect(login.headers.get('set-cookie')).toContain('Max-Age=2592000');
    await ready(origin,cookie);
    const before=state.parse(await(await fetch(`${origin}/api/state`,{headers:{cookie}})).json());
    await controlServer(service.owner,'stop');await service.closed;
    service=await startServer({...options,port:Number(new URL(origin).port)});
    const response=await fetch(`${origin}/api/state`,{headers:{cookie}});
    expect(response.status).toBe(200);
    const after=state.parse(await response.json());
    expect(after.serverInstance).not.toBe(before.serverInstance);
    expect((await fetch(`${origin}/api/state`)).status).toBe(401);
    expect((await fetch(`${origin}/api/state`,{headers:{cookie,origin:'https://foreign.example'}})).status).toBe(403);
    expect((await fetch(`${origin}/api/session`,{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({token})})).status).toBe(401);
    await ready(origin,cookie);
  }finally{await service.close();rmSync(root,{recursive:true,force:true});}
},30000);

test("real standalone HTTP service authenticates, streams changes, rejects foreign origins and closes", async () => {
  // Given: real worker and HTTP processes, with an empty isolated HOME.
  const root = realpathSync(mkdtempSync("/tmp/app-http-"));
  const assets = join(root, "assets");
  mkdirSync(assets, { mode: 0o700 });
  for (const name of ["index.html", "main.js", "main.css"]) writeFileSync(join(assets, name), name, { mode: 0o600 });
  const logo = await Bun.file(new URL("../../web/brand.svg", import.meta.url)).text();
  writeFileSync(join(assets, "brand.svg"), logo, { mode: 0o600 });
  const assetNames = ["symbol-sheep.png", "logo-horizontal-light.png", "logo-horizontal-dark.png", "favicon-16.png", "favicon-32.png", "favicon-48.png", "favicon-180.png", "favicon.ico"];
  for (const name of assetNames) writeFileSync(join(assets, name), await Bun.file(new URL(`../../web/assets/${name}`, import.meta.url)).bytes(), { mode: 0o600 });
  const service = await startServer({ directory: join(root, "state"), home: root, path: "", prefixes: [], assets });
  const origin = service.owner.origin;
  const abort = new AbortController();
  let testFailure: unknown;
  try {
    for (const path of ["/welcome", "/assets/landing.css"]) {
      const response = await fetch(`${origin}${path}`);
      expect(response.status).toBe(401);
    }
    const brand = await fetch(`${origin}/assets/brand.svg`);
    expect(brand.status).toBe(200);
    expect(brand.headers.get("content-type")).toBe("image/svg+xml");
    expect(await brand.text()).toBe(logo);
    for (const name of assetNames) {
      const asset = await fetch(`${origin}/assets/${name}`);
      expect(asset.status).toBe(200);
      expect(asset.headers.get("content-type")).toBe(name.endsWith(".ico") ? "image/x-icon" : "image/png");
      expect(new Uint8Array(await asset.arrayBuffer())).toEqual(await Bun.file(join(assets, name)).bytes());
    }
    expect((await fetch(`${origin}/assets/not-approved.png`)).status).toBe(401);
    expect((await fetch(`${origin}/api/state`)).status).toBe(401);
    const token = new URLSearchParams(new URL(service.url).hash.slice(1)).get("token");
    const exchange = () => fetch(`${origin}/api/session`, {
      method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ token }),
    });
    const login = await exchange();
    expect(login.status).toBe(200);
    const cookie = login.headers.get("set-cookie")?.split(";")[0];
    if (!cookie) throw new Error("missing_cookie");
    expect(login.headers.get("set-cookie")).toContain("HttpOnly");
    expect(login.headers.get("set-cookie")).toContain("SameSite=Strict");
    expect((await exchange()).status).toBe(401);

    // Subscribe before waiting for initialization or triggering a command.
    const events = await fetch(`${origin}/api/events`, {
      headers: { cookie }, signal: AbortSignal.any([abort.signal, AbortSignal.timeout(15_000)]),
    });
    if (!events.body) throw new Error("missing_stream");
    const iterator = events.body[Symbol.asyncIterator]();
    let pending = "";
    const next = async () => {
      for (;;) {
        const boundary = pending.indexOf("\n\n");
        if (boundary >= 0) {
          const frame = pending.slice(0, boundary); pending = pending.slice(boundary + 2);
          const data = frame.split("\n").find(line => line.startsWith("data: "))?.slice(6);
          if (data) return state.parse(JSON.parse(data));
        }
        const chunk = await iterator.next();
        if (chunk.done) throw new Error("stream_ended");
        pending += new TextDecoder().decode(chunk.value);
      }
    };
    let observed = await next();
    while (observed.service === "connecting") observed = await next();
    expect(observed).toMatchObject({ service: "ready", failure: null });

    // When: a foreign page has the cookie but not this origin.
    const foreign = await fetch(`${origin}/api/command`, {
      method: "POST", headers: { cookie, origin: "http://127.0.0.1:1", "content-type": "application/json" },
      body: JSON.stringify({ requestId: "foreign", command: { kind: "refresh" } }),
    });
    expect(foreign.status).toBe(403);
    expect((await fetch(`${origin}/internal/control`, {
      method: "POST", headers: { cookie, origin, "content-type": "application/json" },
      body: JSON.stringify({ action: "stop", instance: service.owner.instance }),
    })).status).toBe(403);
    expect((await fetch(`${origin}/internal/command`, {
      method: "POST", headers: { cookie, origin, "content-type": "application/json" },
      body: JSON.stringify({ instance: service.owner.instance, request: { requestId: "no-auth", command: { kind: "refresh" } } }),
    })).status).toBe(403);
    expect(await commandServer(service.owner, { requestId: "cli-refresh", command: { kind: "refresh" } }))
      .toMatchObject({ ok: true, snapshot: { service: "ready", native: { selections: [], jobs: [] } } });
    // A relaunched CLI reopens with its fresh conversation context; an unknown shape is rejected without a token.
    const reopened = await controlServer(service.owner, "open", { pid: process.pid, startedAt: "2026-10-12T10:03:44.000Z", id: "conversation", path: "/tmp/conversation.jsonl" });
    expect(reopened.url).toMatch(/#token=[a-f0-9]{64}$/);
    expect((await fetch(`${origin}/internal/control`, {
      method: "POST", headers: { authorization: `Bearer ${service.owner.secret}`, "content-type": "application/json" },
      body: JSON.stringify({ action: "open", instance: service.owner.instance, currentConversation: { pid: 0 } }),
    })).status).not.toBe(200);
    const cli = Bun.spawn([process.execPath, join(import.meta.dir, "../../src/index.ts"), "native-targets",
      "--state-dir", join(root, "state")], { stdout: "pipe", stderr: "pipe" });
    const cliOutput = new Response(cli.stdout).json();
    expect(await cli.exited).toBe(0);
    expect(await cliOutput).toMatchObject({ ok: true, snapshot: { native: { selections: [], jobs: [] } } });

    // Then: the genuine command publishes a newer snapshot on the existing stream.
    const before = observed.revision;
    const changed = next();
    const response = await fetch(`${origin}/api/command`, {
      method: "POST", headers: { cookie, origin, "content-type": "application/json" },
      body: JSON.stringify({ requestId: "refresh", command: { kind: "refresh" } }),
    });
    expect(response.status).toBe(200);
    expect((await changed).revision).toBeGreaterThan(before);
    expect(await response.json()).toMatchObject({ ok: true, snapshot: { service: "ready", installations: [],serverInstance:service.owner.instance } });
    abort.abort();
    await controlServer(service.owner, "stop");
    await service.closed;
    expect((await Bun.file(join(root, "state/server.json")).exists())).toBe(false);
    expect((await Bun.file(join(root, "state/server.lock")).exists())).toBe(false);
  } catch (error) {
    testFailure = error;
    throw error;
  } finally {
    abort.abort();
    try {
      if (await Bun.file(join(root, "state/server.json")).exists()) await service.close();
    } catch (cleanupError) {
      if (testFailure) throw new AggregateError([testFailure, cleanupError], "http_test_and_cleanup_failed");
      throw cleanupError;
    }
    rmSync(root, { recursive: true });
  }
}, 20_000);


test("a server record left by a dead service is reclaimed instead of blocking the next start", async () => {
  // Given: the previous service died without cleaning up (crash, reboot, kill -9).
  const root = realpathSync(mkdtempSync("/tmp/server-stale-"));
  const assets = join(root, "assets"); mkdirSync(assets, { recursive: true });
  for (const name of ["index.html", "main.js", "main.css"]) writeFileSync(join(assets, name), "");
  const directory = join(root, "state"); mkdirSync(directory, { mode: 0o700 });
  // PID 1 is alive but never this user's service; use an exited child's pid for a provably dead owner.
  const child = Bun.spawn(["/bin/sh", "-c", "exit 0"]); await child.exited;
  writeFileSync(join(directory, "server.json"), JSON.stringify({ version: 1, pid: child.pid, instance: "00000000-0000-4000-8000-000000000000", origin: "http://127.0.0.1:1", secret: "f".repeat(64) }), { mode: 0o600 });
  writeFileSync(join(directory, "server.lock"), "", { mode: 0o600 });
  // When: a new service starts on the same state directory.
  const service = await startServer({ directory, home: root, path: "", prefixes: [], assets });
  try {
    // Then: the stale record is replaced by the live owner.
    expect(service.owner.pid).toBe(process.pid);
    expect(JSON.parse(await Bun.file(join(directory, "server.json")).text()).pid).toBe(process.pid);
  } finally {
    // The controller initializes asynchronously; stop through the control endpoint once it reports a state.
    for (let attempt = 0; attempt < 200; attempt++) { if ((await controlServer(service.owner, "status")).service !== "connecting") break; await new Promise(resolve => setTimeout(resolve, 50)); }
    await controlServer(service.owner, "stop"); await service.closed; rmSync(root, { recursive: true, force: true });
  }
});
