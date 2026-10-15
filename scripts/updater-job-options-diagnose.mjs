import { join } from "node:path";
import { pathToFileURL } from "node:url";
const [prefix, cwd, file] = process.argv.slice(2);
const engine = join(prefix, "install/global/node_modules/@code-yeongyu/senpi");
const { createAgentSession } = await import(pathToFileURL(join(engine, "dist/core/sdk.js")));
const { SessionManager } = await import(pathToFileURL(join(engine, "dist/core/session-manager.js")));
const created = await createAgentSession({ cwd, sessionManager: SessionManager.open(file) });
try {
  const absent = [];
  function check(value, path) {
    if (value === undefined) absent.push(path);
    else if (value !== null && typeof value === "object") for (const [key, child] of Object.entries(value)) check(child, `${path}.${key}`);
  }
  check(created.session.model, "model");
  console.log(JSON.stringify({ undefinedModelFields: absent }));
} finally { await created.session.dispose(); }
