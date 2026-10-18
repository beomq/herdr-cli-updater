import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { APP_NAME, getAgentDir, getSelfUpdateCommand, getSelfUpdateUnavailableInstruction, PACKAGE_NAME, VERSION, } from "./config.js";
import { brandProfile } from "./core/brand.js";
import { getLatestPiRelease, isNewerPackageVersion } from "./utils/version-check.js";
function parseBootstrapSelfUpdateArgs(args) {
    const [command, ...rest] = args;
    if (command !== "update") {
        return undefined;
    }
    let force = false;
    let selfFlag = false;
    let extensionsFlag = false;
    let extensionFlag = false;
    let source;
    for (let index = 0; index < rest.length; index++) {
        const arg = rest[index];
        if (arg === "-h" || arg === "--help") {
            return undefined;
        }
        if (arg === "--force") {
            force = true;
            continue;
        }
        if (arg === "--self") {
            selfFlag = true;
            continue;
        }
        if (arg === "--extensions") {
            extensionsFlag = true;
            continue;
        }
        if (arg === "--extension") {
            extensionFlag = true;
            index++;
            continue;
        }
        if (arg.startsWith("-")) {
            return undefined;
        }
        if (source) {
            return undefined;
        }
        source = arg;
    }
    if (extensionFlag) {
        return undefined;
    }
    const sourceIsSelf = source === "self" || source === "pi" || source === APP_NAME;
    if (source && !sourceIsSelf) {
        return undefined;
    }
    if (!selfFlag && !sourceIsSelf && extensionsFlag) {
        return undefined;
    }
    return { force };
}
function getObjectProperty(value, key) {
    if (!value || typeof value !== "object") {
        return undefined;
    }
    return Object.getOwnPropertyDescriptor(value, key)?.value;
}
function readConfiguredNpmCommand() {
    try {
        const parsed = JSON.parse(readFileSync(join(getAgentDir(), "settings.json"), "utf-8"));
        const npmCommand = getObjectProperty(parsed, "npmCommand");
        if (!Array.isArray(npmCommand) || npmCommand.some((part) => typeof part !== "string")) {
            return undefined;
        }
        return npmCommand.length > 0 ? npmCommand : undefined;
    }
    catch {
        return undefined;
    }
}
async function runCommand(step) {
    await new Promise((resolve, reject) => {
        const child = spawn(step.command, step.args, { stdio: "inherit" });
        child.on("error", (error) => {
            reject(error);
        });
        child.on("close", (code, signal) => {
            if (code === 0) {
                resolve();
            }
            else if (signal) {
                reject(new Error(`${step.display} terminated by signal ${signal}`));
            }
            else {
                reject(new Error(`${step.display} exited with code ${code ?? "unknown"}`));
            }
        });
    });
}
export async function handleBootstrapSelfUpdate(args, dependencies = {}) {
    const parsed = parseBootstrapSelfUpdateArgs(args);
    if (!parsed) {
        return false;
    }
    const writeStdout = dependencies.writeStdout ?? ((line) => console.log(line));
    const writeStderr = dependencies.writeStderr ?? ((line) => console.error(line));
    const readNpmCommand = dependencies.readNpmCommand ?? readConfiguredNpmCommand;
    const resolveSelfUpdateCommand = dependencies.getSelfUpdateCommand ?? getSelfUpdateCommand;
    const resolveUnavailableInstruction = dependencies.getUnavailableInstruction ?? getSelfUpdateUnavailableInstruction;
    const executeCommand = dependencies.runCommand ?? runCommand;
    const brandUpdate = brandProfile()?.update;
    if (brandUpdate) {
        writeStdout(`${APP_NAME} ships inside ${brandUpdate.packageName}. Update it with: ${brandUpdate.command}`);
        return true;
    }
    const loadLatestRelease = dependencies.getLatestRelease ?? getLatestPiRelease;
    let latestRelease;
    if (!parsed.force) {
        try {
            latestRelease = await loadLatestRelease(VERSION);
        }
        catch {
            latestRelease = undefined;
        }
    }
    const updatePackageName = latestRelease?.packageName ?? PACKAGE_NAME;
    const shouldRun = parsed.force ||
        !latestRelease ||
        updatePackageName !== PACKAGE_NAME ||
        isNewerPackageVersion(latestRelease.version, VERSION);
    if (!shouldRun) {
        writeStdout(`${APP_NAME} is already up to date (v${VERSION})`);
        return true;
    }
    const npmCommand = readNpmCommand();
    const selfUpdateCommand = resolveSelfUpdateCommand(PACKAGE_NAME, npmCommand, updatePackageName);
    if (!selfUpdateCommand) {
        writeStderr(`error: ${APP_NAME} cannot self-update this installation.`);
        writeStderr(resolveUnavailableInstruction(PACKAGE_NAME, npmCommand, updatePackageName));
        if (process.argv[1]) {
            writeStderr("");
            writeStderr(`Location of ${APP_NAME} executable: ${process.argv[1]}`);
        }
        process.exitCode = 1;
        return true;
    }
    if (latestRelease?.note?.trim()) {
        writeStdout("");
        writeStdout("Update note");
        writeStdout(latestRelease.note.trim());
        writeStdout("");
    }
    writeStdout(`Updating ${APP_NAME} with ${selfUpdateCommand.display}...`);
    for (const step of selfUpdateCommand.steps ?? [selfUpdateCommand]) {
        try {
            await executeCommand(step);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : "Unknown package command error";
            writeStderr(`Error: ${message}`);
            writeStderr(`If this keeps failing, run this command yourself: ${selfUpdateCommand.display}`);
            process.exitCode = 1;
            return true;
        }
    }
    writeStdout(`Updated ${APP_NAME}`);
    return true;
}
//# sourceMappingURL=self-update-bootstrap.js.map
