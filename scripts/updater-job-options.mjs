import { join } from "node:path";
import { pathToFileURL } from "node:url";
const [prefix, cwd, file, ...argv] = process.argv.slice(2);
const engine = join(prefix, "install/global/node_modules/@code-yeongyu/senpi");
const { createAgentSession } = await import(pathToFileURL(join(engine, "dist/core/sdk.js")));
const { SessionManager } = await import(pathToFileURL(join(engine, "dist/core/session-manager.js")));
const { nativeEffectiveOptions } = await import(pathToFileURL(join(engine, "dist/core/updater-native-bridge.js")));
// Preserve the existing conversation's model, thinking and normal tools.
const created = await createAgentSession({ cwd, sessionManager: SessionManager.open(file) });
try { console.log(JSON.stringify(nativeEffectiveOptions(created.session, argv))); }
finally { await created.session.dispose(); }
