import { accessSync, constants, existsSync, readFileSync, realpathSync } from "fs";
import { homedir } from "os";
import { basename, dirname, join, resolve, sep, win32 } from "path";
import { fileURLToPath } from "url";
import { createBunLauncherRepairCommand } from "./bun-global-launcher.js";
import { brandProfile, envValue } from "./core/brand.js";
import { findNearestParentConfigDir } from "./nearest-parent-config.js";
import { resolveInstallPath } from "./runtime-snapshot/marker.js";
import { spawnProcessSync } from "./utils/child-process.js";
import { normalizePath } from "./utils/paths.js";
import { stripBom } from "./utils/text.js";
// =============================================================================
// Package Detection
// =============================================================================
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
/**
 * Detect if we're running as a Bun compiled binary.
 * Bun binaries have import.meta.url containing "$bunfs", "~BUN", or "%7EBUN" (Bun's virtual filesystem path)
 */
export const isBunBinary = import.meta.url.includes("$bunfs") || import.meta.url.includes("~BUN") || import.meta.url.includes("%7EBUN");
/** Detect if Bun is the runtime (compiled binary or bun run) */
export const isBunRuntime = !!process.versions.bun;
export const isBundledNode = typeof PI_BUNDLED_NODE !== "undefined" && PI_BUNDLED_NODE;
function normalizeSelfUpdatePackageTarget(target) {
    if (typeof target === "string") {
        return { packageName: target, installSpec: target };
    }
    return { packageName: target.packageName, installSpec: target.installSpec ?? target.packageName };
}
function makeSelfUpdateCommand(installStep, uninstallStep, postInstallStep) {
    const steps = [
        ...(uninstallStep ? [uninstallStep] : []),
        installStep,
        ...(postInstallStep ? [postInstallStep] : []),
    ];
    if (steps.length === 1)
        return installStep;
    return {
        ...installStep,
        display: steps.map((step) => step.display).join(" && "),
        steps,
    };
}
function makeSelfUpdateCommandStep(command, args) {
    return {
        command,
        args,
        display: [command, ...args].map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg)).join(" "),
    };
}
export function detectInstallMethod() {
    if (isBunBinary) {
        return "bun-binary";
    }
    const moduleDir = resolveInstallPath(__dirname, findNodePackageDir(__dirname));
    const resolvedPath = `${moduleDir}\0${process.execPath || ""}`.toLowerCase().replace(/\\/g, "/");
    if (resolvedPath.includes("/pnpm/") || resolvedPath.includes("/.pnpm/")) {
        return "pnpm";
    }
    if (resolvedPath.includes("/yarn/") || resolvedPath.includes("/.yarn/")) {
        return "yarn";
    }
    if (isBunRuntime || resolvedPath.includes("/install/global/node_modules/")) {
        return "bun";
    }
    if (resolvedPath.includes("/npm/") || resolvedPath.includes("/node_modules/")) {
        return "npm";
    }
    return "unknown";
}
function getInferredNpmInstall() {
    const packageDir = getInstallPackageDir();
    const path = process.platform === "win32" || packageDir.includes("\\") ? win32 : { basename, dirname };
    const parent = path.dirname(packageDir);
    let root;
    if (path.basename(parent).startsWith("@") && path.basename(path.dirname(parent)) === "node_modules") {
        root = path.dirname(parent);
    }
    else if (path.basename(parent) === "node_modules") {
        root = parent;
    }
    if (!root)
        return undefined;
    const rootParent = path.dirname(root);
    if (path.basename(rootParent) === "lib")
        return { root, prefix: path.dirname(rootParent) };
    // Windows global npm prefixes use `<prefix>\\node_modules`, which is
    // indistinguishable from local project installs by path shape alone. Do not
    // infer unsupported Windows custom prefixes without `npm root -g` evidence.
    return undefined;
}
function getSelfUpdateCommandForMethod(method, installedPackageName, updatePackageTarget = installedPackageName, npmCommand) {
    const target = normalizeSelfUpdatePackageTarget(updatePackageTarget);
    switch (method) {
        case "bun-binary":
            return undefined;
        case "pnpm": {
            const match = readCommandOutput("pnpm", ["root", "-g"])
                ? undefined
                : /^(.*[\\/]global[\\/][^\\/]+)[\\/]\.pnpm[\\/]/.exec(getInstallPackageDir());
            const binDirArgs = match
                ? [`--config.global-bin-dir=${process.env.PNPM_HOME || dirname(dirname(match[1]))}`]
                : [];
            return makeSelfUpdateCommand(makeSelfUpdateCommandStep("pnpm", [
                "install",
                "-g",
                "--ignore-scripts",
                "--config.minimumReleaseAge=0",
                ...binDirArgs,
                target.installSpec,
            ]), target.packageName === installedPackageName
                ? undefined
                : makeSelfUpdateCommandStep("pnpm", ["remove", "-g", ...binDirArgs, installedPackageName]));
        }
        case "yarn":
            return makeSelfUpdateCommand(makeSelfUpdateCommandStep("yarn", ["global", "add", "--ignore-scripts", target.installSpec]), target.packageName === installedPackageName
                ? undefined
                : makeSelfUpdateCommandStep("yarn", ["global", "remove", installedPackageName]));
        case "bun": {
            const binDir = readCommandOutput("bun", ["pm", "bin", "-g"]);
            if (!binDir)
                return undefined;
            return makeSelfUpdateCommand(makeSelfUpdateCommandStep("bun", [
                "install",
                "-g",
                "--ignore-scripts",
                "--minimum-release-age=0",
                target.installSpec,
            ]), target.packageName === installedPackageName
                ? undefined
                : makeSelfUpdateCommandStep("bun", ["uninstall", "-g", installedPackageName]), process.platform === "win32"
                ? undefined
                : createBunLauncherRepairCommand(binDir, target.packageName, APP_NAME));
        }
        case "npm": {
            const [command = "npm", ...npmArgs] = npmCommand ?? [];
            const inferred = npmCommand?.length ? undefined : getInferredNpmInstall();
            const prefixArgs = [...npmArgs, ...(inferred ? ["--prefix", inferred.prefix] : [])];
            const installStep = makeSelfUpdateCommandStep(command, [
                ...prefixArgs,
                "install",
                "-g",
                "--ignore-scripts",
                "--min-release-age=0",
                target.installSpec,
            ]);
            const uninstallStep = target.packageName === installedPackageName
                ? undefined
                : makeSelfUpdateCommandStep(command, [...prefixArgs, "uninstall", "-g", installedPackageName]);
            return makeSelfUpdateCommand(installStep, uninstallStep);
        }
        case "unknown":
            return undefined;
    }
}
function readCommandOutput(command, args, options = {}) {
    const result = spawnProcessSync(command, args, {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.status === 0)
        return result.stdout.trim() || undefined;
    if (options.requireSuccess) {
        const reason = result.error?.message || result.stderr.trim() || `exit code ${result.status ?? "unknown"}`;
        throw new Error(`Failed to run ${[command, ...args].join(" ")}: ${reason}`);
    }
    return undefined;
}
function getGlobalPackageRoots(method, _packageName, npmCommand) {
    switch (method) {
        case "npm": {
            const configured = !!npmCommand?.length;
            const [command = "npm", ...npmArgs] = npmCommand ?? [];
            if (configured && command === "bun") {
                const bunBin = readCommandOutput(command, [...npmArgs, "pm", "bin", "-g"], {
                    requireSuccess: true,
                });
                const roots = [join(homedir(), ".bun", "install", "global", "node_modules")];
                if (bunBin) {
                    roots.push(join(dirname(bunBin), "install", "global", "node_modules"));
                }
                return roots;
            }
            const root = readCommandOutput(command, [...npmArgs, "root", "-g"], {
                requireSuccess: configured,
            });
            const inferred = configured ? undefined : getInferredNpmInstall();
            return [root, inferred?.root].filter((x) => !!x);
        }
        case "pnpm": {
            const root = readCommandOutput("pnpm", ["root", "-g"]);
            if (root)
                return [root, dirname(root)];
            const match = /^(.*[\\/]global[\\/][^\\/]+)[\\/]\.pnpm[\\/]/.exec(getInstallPackageDir());
            return match ? [match[1]] : [];
        }
        case "yarn": {
            const dir = readCommandOutput("yarn", ["global", "dir"]);
            return dir ? [dir, join(dir, "node_modules")] : [];
        }
        case "bun": {
            const bunBin = readCommandOutput("bun", ["pm", "bin", "-g"]);
            const roots = [join(homedir(), ".bun", "install", "global", "node_modules")];
            if (bunBin) {
                roots.push(join(dirname(bunBin), "install", "global", "node_modules"));
            }
            return roots;
        }
        case "bun-binary":
        case "unknown":
            return [];
    }
}
function normalizeExistingPathForComparison(path, resolveSymlinks) {
    const resolvedPath = resolve(path);
    if (!existsSync(resolvedPath)) {
        return undefined;
    }
    let normalizedPath = resolvedPath;
    if (resolveSymlinks) {
        try {
            normalizedPath = realpathSync(resolvedPath);
        }
        catch {
            return undefined;
        }
    }
    if (process.platform === "win32") {
        normalizedPath = normalizedPath.toLowerCase();
    }
    return normalizedPath;
}
function getPathComparisonCandidates(path) {
    return Array.from(new Set([normalizeExistingPathForComparison(path, false), normalizeExistingPathForComparison(path, true)].filter((candidate) => !!candidate)));
}
function getEntrypointPackageDir() {
    const entrypoint = process.argv[1];
    if (!entrypoint)
        return undefined;
    let dir = dirname(entrypoint);
    while (dir !== dirname(dir)) {
        if (existsSync(join(dir, "package.json"))) {
            return dir;
        }
        dir = dirname(dir);
    }
    return undefined;
}
function isSelfUpdatePathWritable() {
    const packageDir = getInstallPackageDir();
    try {
        accessSync(packageDir, constants.W_OK);
        accessSync(dirname(packageDir), constants.W_OK);
        return true;
    }
    catch {
        return false;
    }
}
function isManagedByGlobalPackageManager(method, packageName, npmCommand) {
    const packageDirs = [getInstallPackageDir(), getEntrypointPackageDir()].filter((dir) => !!dir);
    const packageDirCandidates = packageDirs.flatMap((dir) => getPathComparisonCandidates(dir));
    return getGlobalPackageRoots(method, packageName, npmCommand).some((root) => {
        return getPathComparisonCandidates(root).some((normalizedRoot) => {
            const rootPrefix = normalizedRoot.endsWith(sep) ? normalizedRoot : `${normalizedRoot}${sep}`;
            return packageDirCandidates.some((packageDir) => packageDir.startsWith(rootPrefix));
        });
    });
}
export function getSelfUpdateCommand(packageName, npmCommand, updatePackageTarget = packageName) {
    const method = detectInstallMethod();
    const command = getSelfUpdateCommandForMethod(method, packageName, updatePackageTarget, npmCommand);
    if (!command || !isManagedByGlobalPackageManager(method, packageName, npmCommand) || !isSelfUpdatePathWritable()) {
        return undefined;
    }
    return command;
}
export function getSelfUpdateUnavailableInstruction(packageName, npmCommand, updatePackageTarget = packageName) {
    const method = detectInstallMethod();
    const target = normalizeSelfUpdatePackageTarget(updatePackageTarget);
    if (method === "bun-binary") {
        return `Download from: https://github.com/code-yeongyu/senpi/releases/latest`;
    }
    const command = getSelfUpdateCommandForMethod(method, packageName, target, npmCommand);
    if (command) {
        if (isManagedByGlobalPackageManager(method, packageName, npmCommand) && !isSelfUpdatePathWritable()) {
            return `This installation is managed by a global ${method} install, but the install path is not writable. Update it yourself with: ${command.display}`;
        }
        return `This installation is not managed by a global ${method} install. Update it with the package manager, wrapper, or source checkout that provides it.`;
    }
    return `Update ${target.installSpec} using the package manager, wrapper, or source checkout that provides this installation.`;
}
export function getUpdateInstruction(packageName) {
    const method = detectInstallMethod();
    const command = getSelfUpdateCommandForMethod(method, packageName);
    if (command) {
        return `Run: ${command.display}`;
    }
    return getSelfUpdateUnavailableInstruction(packageName);
}
// =============================================================================
// Package Asset Paths (shipped with executable)
// =============================================================================
/**
 * Get the base directory for resolving package assets (themes, package.json, README.md, CHANGELOG.md).
 * - For Bun binary: returns the directory containing the executable
 * - For Node.js and tsx: returns the package root containing package.json
 * - Ignores Bun binary metadata copied into dist/ when the package root is available
 */
export function findNodePackageDir(startDir) {
    let dir = startDir;
    while (dir !== dirname(dir)) {
        if (existsSync(join(dir, "package.json"))) {
            const parent = dirname(dir);
            // build:binary places Bun's metadata inside dist/. Node still needs the
            // package root so its dist-relative asset paths do not become dist/dist/.
            if (basename(dir) === "dist" && existsSync(join(parent, "package.json"))) {
                return parent;
            }
            return dir;
        }
        dir = dirname(dir);
    }
    return startDir;
}
export function getPackageDir() {
    // Allow override via environment variable (useful for Nix/Guix where store paths tokenize poorly)
    const envDir = envValue("PACKAGE_DIR");
    if (envDir) {
        return normalizePath(envDir);
    }
    if (isBunBinary) {
        // Bun binary: process.execPath points to the compiled executable
        return dirname(process.execPath);
    }
    return findNodePackageDir(__dirname);
}
/**
 * Where the package manager installed this package. Equals `getPackageDir()` except in a process
 * running from its runtime snapshot (`runtime-snapshot/`), whose assets live in the snapshot.
 */
export function getInstallPackageDir() {
    const packageDir = getPackageDir();
    return resolveInstallPath(packageDir, packageDir);
}
const THEMES_ASSET = {
    binaryDir: "theme",
    sourceSegments: ["modes", "interactive", "theme"],
    probe: "dark.json",
};
const EXPORT_TEMPLATE_ASSET = {
    binaryDir: "export-html",
    sourceSegments: ["core", "export-html"],
    probe: "template.html",
};
const INTERACTIVE_ASSETS = {
    binaryDir: "assets",
    sourceSegments: ["modes", "interactive", "assets"],
    probe: "clankolas.png",
};
function assetDirIn(root, asset) {
    if (isBunBinary) {
        return join(root, asset.binaryDir);
    }
    const srcOrDist = existsSync(join(root, "src")) ? "src" : "dist";
    return join(root, srcOrDist, ...asset.sourceSegments);
}
/**
 * Resolve a shipped asset directory, preferring PACKAGE_DIR but never trusting it blindly.
 *
 * PACKAGE_DIR relocates the package root (Nix/Guix store paths), and a Bun binary that embeds this
 * CLI pins it to the binary's own root. When such a root is inherited by a Node install of the CLI,
 * the Node layout resolves under it to a directory that cannot exist and startup dies on ENOENT
 * (an omo binary keeps its themes in a flat theme/, so the inherited root has no dist/ tree at all).
 * Fall back to the running install whenever the preferred root does not actually ship the asset. When
 * neither ships it the install is genuinely broken, and the running install's own path is returned so
 * the resulting error names the tree that was supposed to carry the asset rather than a foreign root.
 */
function resolveShippedAssetDir(asset) {
    const preferred = assetDirIn(getPackageDir(), asset);
    if (existsSync(join(preferred, asset.probe))) {
        return preferred;
    }
    return assetDirIn(isBunBinary ? dirname(process.execPath) : findNodePackageDir(__dirname), asset);
}
/**
 * Get path to built-in themes directory (shipped with package)
 * - For Bun binary: theme/ next to executable
 * - For Node.js (dist/): dist/modes/interactive/theme/
 * - For tsx (src/): src/modes/interactive/theme/
 */
export function getThemesDir() {
    return resolveShippedAssetDir(THEMES_ASSET);
}
/**
 * Get path to HTML export template directory (shipped with package)
 * - For Bun binary: export-html/ next to executable
 * - For Node.js (dist/): dist/core/export-html/
 * - For tsx (src/): src/core/export-html/
 */
export function getExportTemplateDir() {
    return resolveShippedAssetDir(EXPORT_TEMPLATE_ASSET);
}
/** Get path to package.json */
export function getPackageJsonPath() {
    return join(getPackageDir(), "package.json");
}
/** Get path to README.md */
export function getReadmePath() {
    return resolve(join(getPackageDir(), "README.md"));
}
/** Get path to docs directory */
export function getDocsPath() {
    return resolve(join(getPackageDir(), "docs"));
}
/** Get path to examples directory */
export function getExamplesPath() {
    return resolve(join(getPackageDir(), "examples"));
}
/** Get path to CHANGELOG.md */
export function getChangelogPath() {
    return resolve(join(getPackageDir(), "CHANGELOG.md"));
}
/**
 * Get path to built-in interactive assets directory.
 * - For Bun binary: assets/ next to executable
 * - For Node.js (dist/): dist/modes/interactive/assets/
 * - For tsx (src/): src/modes/interactive/assets/
 */
export function getInteractiveAssetsDir() {
    return resolveShippedAssetDir(INTERACTIVE_ASSETS);
}
/** Get path to a bundled interactive asset */
export function getBundledInteractiveAssetPath(name) {
    return join(getInteractiveAssetsDir(), name);
}
let pkg = {};
try {
    pkg = JSON.parse(stripBom(readFileSync(getPackageJsonPath(), "utf-8")));
}
catch (e) {
    const err = e;
    if (err.code !== "ENOENT")
        throw e;
}
const piConfigName = pkg.piConfig?.name;
/**
 * A distribution repackaging this engine injects its brand once. The profile is consumed
 * here - which also scrubs the variable - so every process spawned later inherits a clean
 * environment and keeps the engine's own identity.
 */
export const BRAND = brandProfile();
export const PACKAGE_NAME = pkg.name || "@earendil-works/pi-coding-agent";
export const APP_NAME = BRAND?.name || piConfigName || "pi";
/** Command-line name; brands whose binary differs from their display name set this. */
export const APP_COMMAND = BRAND?.command ?? APP_NAME;
export const APP_TITLE = BRAND?.name || (piConfigName ? APP_NAME : "π");
export const CONFIG_DIR_NAME = BRAND?.configDir || pkg.piConfig?.configDir || ".pi";
/** True when the brand stores agent state directly under the config dir, with no `agent` segment. */
export const CONFIG_FLAT_LAYOUT = BRAND?.flatLayout === true;
export const VERSION = pkg.version || "0.0.0";
/** Version shown to users; VERSION stays the engine version used for update comparisons. */
export const DISPLAY_VERSION = BRAND?.displayVersion || VERSION;
// e.g., PI_CODING_AGENT_DIR or TAU_CODING_AGENT_DIR
/** Primary environment prefix for this product; legacy prefixes stay readable. */
export const ENV_PREFIX = BRAND?.envPrefix || APP_NAME.toUpperCase();
export const ENV_AGENT_DIR = `${ENV_PREFIX}_CODING_AGENT_DIR`;
export const ENV_SESSION_DIR = `${ENV_PREFIX}_CODING_AGENT_SESSION_DIR`;
export function expandTildePath(path) {
    return normalizePath(path);
}
const DEFAULT_SHARE_VIEWER_URL = "https://pi.dev/session/";
/** Get the share viewer URL for a gist ID. */
export function getShareViewerUrl(gistId) {
    const baseUrl = envValue("SHARE_VIEWER_URL") || DEFAULT_SHARE_VIEWER_URL;
    return `${baseUrl}#${gistId}`;
}
// =============================================================================
// User Config Paths (~/.senpi/agent/*)
// =============================================================================
/** Marker file that identifies a flat-layout config directory. */
export const FLAT_LAYOUT_SENTINEL = "settings.json";
/**
 * Resolve the agent config directory from an explicit environment.
 *
 * A flat-layout brand keeps its state directly under the config directory, so it looks for
 * the settings file as proof rather than for an `agent` subdirectory - the config directory
 * name may also be used by unrelated project tooling.
 */
export function resolveAgentDir(cwd, homeDir, envDir) {
    if (envDir) {
        return normalizePath(envDir, { homeDir });
    }
    if (CONFIG_FLAT_LAYOUT) {
        const flatProjectDir = findNearestParentConfigDir(cwd, homeDir, CONFIG_DIR_NAME, undefined, FLAT_LAYOUT_SENTINEL);
        return flatProjectDir ?? join(homeDir, CONFIG_DIR_NAME);
    }
    const projectConfigDir = findNearestParentConfigDir(cwd, homeDir, CONFIG_DIR_NAME, "agent");
    return projectConfigDir ? join(projectConfigDir, "agent") : join(homeDir, CONFIG_DIR_NAME, "agent");
}
/** Get the agent config directory (e.g., ~/.senpi/agent/) */
export function getAgentDir() {
    return resolveAgentDir(process.cwd(), homedir(), envValue("CODING_AGENT_DIR"));
}
/**
 * Short, display-only spelling of the agent directory for help text and tips, e.g.
 * `~/.omo` for a flat brand or `~/.senpi/agent` for the engine layout.
 */
export function agentDirLabel() {
    return CONFIG_FLAT_LAYOUT ? `~/${CONFIG_DIR_NAME}` : `~/${CONFIG_DIR_NAME}/agent`;
}
/** Get path to user's custom themes directory */
export function getCustomThemesDir() {
    return join(getAgentDir(), "themes");
}
/** Get path to models.json */
export function getModelsPath() {
    return join(getAgentDir(), "models.json");
}
/** Get path to auth.json */
export function getAuthPath() {
    return join(getAgentDir(), "auth.json");
}
/** Get path to settings.json */
export function getSettingsPath() {
    return join(getAgentDir(), "settings.json");
}
/** Get path to tools directory */
export function getToolsDir() {
    return join(getAgentDir(), "tools");
}
/** Get path to managed binaries directory (fd, rg) */
export function getBinDir() {
    return join(getAgentDir(), "bin");
}
/** Get path to prompt templates directory */
export function getPromptsDir() {
    return join(getAgentDir(), "prompts");
}
/** Get path to sessions directory */
export function getSessionsDir() {
    return join(getAgentDir(), "sessions");
}
/** Get path to debug log file */
export function getDebugLogPath() {
    return join(getAgentDir(), `${APP_NAME}-debug.log`);
}
//# sourceMappingURL=config.js.map
