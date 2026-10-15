import { join } from "node:path";
import { pathToFileURL } from "node:url";
const prefix = "/Users/beomseok/.local/share/herdr-cli-updater/operating-native/prefix";
const engine = join(prefix, "install/global/node_modules/@code-yeongyu/senpi");
const { createAgentSession } = await import(pathToFileURL(join(engine, "dist/core/sdk.js")));
const { nativeEffectiveOptions } = await import(pathToFileURL(join(engine, "dist/core/updater-native-bridge.js")));
const created = await createAgentSession({ cwd: "/Users/beomseok/Desktop/portfolio", agentDir: "/Users/beomseok/.omo/agent",
  thinkingLevel: "off", thinkingSelection: { level: "off", source: "explicit" }, tools: ["bash"], autoTitleSessions: false });
function nonJson(value, path, found) {
  if (value === undefined || (typeof value === "number" && !Number.isFinite(value))) found.push(path);
  else if (value !== null && typeof value === "object") {
    if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) found.push(`${path}:prototype`);
    for (const [key, item] of Object.entries(value)) nonJson(item, `${path}.${key}`, found);
  }
}
try {
  const paths = [];
  nonJson(created.session.model, "model", paths);
  nonJson(created.session.settingsManager.getSettings(), "settings", paths);
  nonJson(created.session.thinkingSelection, "thinkingSelection", paths);
  console.log(JSON.stringify({ nonJsonPaths: paths, modelKeys: Object.keys(created.session.model ?? {}) }));
  nativeEffectiveOptions(created.session, []);
  console.log("ATTESTATION_PROBE_PASS");
} finally { await created.session.dispose(); }
