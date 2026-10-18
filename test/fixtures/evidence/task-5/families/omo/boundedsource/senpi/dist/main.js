// allow: SIZE_OK - CLI coordinator is pre-existing oversized glue; app-server command handling is extracted for this branch and a full main split needs behavior-locked follow-up coverage.
/**
 * Main entry point for the coding agent CLI.
 *
 * This file handles CLI argument parsing and translates them into
 * createAgentSession() options. The SDK does the heavy lifting.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { modelsAreEqual } from "@earendil-works/pi-ai";
import { setCapabilityOverrides } from "@earendil-works/pi-tui";
import chalk from "chalk";
import { normalizeSessionName, parseArgs, printHelp, resolveSessionRuntime } from "./cli/args.js";
import { checkProviderAuth, createAuthCheckModelRuntime, getProviderCredential, } from "./cli/auth-check.js";
import { AuthCommandError, getAuthCommandName, getAuthCommandUsage, isAuthCommandHelp, parseAuthCommand, printAuthCommandHelp, validateAuthCommandArgs, } from "./cli/auth-command.js";
import { movedSessionToContinue } from "./cli/continue-moved.js";
import { resolveCredentialForPrint } from "./cli/credential-print.js";
import { chooseCrossProjectAction, confirmSameRepositoryRebind } from "./cli/cross-project-session.js";
import { dispatchAppServerCommand, dispatchConfigCommand, dispatchHostCommand, dispatchPackageCommand, dispatchScheduleCommand, } from "./cli/deferred-commands.js";
import { processFileArguments } from "./cli/file-processor.js";
import { resolveHelpExtensionFlags } from "./cli/help-extension-flags.js";
import { helpFlagsScope, isPlainHelpRequest, resolveHelpProjectTrust } from "./cli/help-fast-path.js";
import { writeHelpFlagsCache } from "./cli/help-flags-cache.js";
import { buildInitialMessage } from "./cli/initial-message.js";
import { listModels } from "./cli/list-models.js";
import { isModelsDiscoverCommand, runModelsDiscoverCommand } from "./cli/models-command.js";
import { createProjectTrustContext } from "./cli/project-trust.js";
import { createStartupLoadingIndicator, pauseIndicatorDuringPrompts, shouldShowStartupLoadingIndicator, } from "./cli/startup-loading-indicator.js";
import { shouldRunFirstTimeSetup, showFirstTimeSetup, showStartupSelector } from "./cli/startup-ui.js";
import { APP_NAME, DISPLAY_VERSION, ENV_SESSION_DIR, expandTildePath, getAgentDir, getInstallPackageDir, } from "./config.js";
import { createAgentSessionRuntime } from "./core/agent-session-runtime.js";
import { createAgentSessionFromServices, createAgentSessionServices, } from "./core/agent-session-services.js";
import { formatNoModelsAvailableMessage } from "./core/auth-guidance.js";
import { AuthStorage, ReadOnlyAuthStorage } from "./core/auth-storage.js";
import { envValue } from "./core/brand.js";
import { summarizeCredentialAccounts } from "./core/credential-accounts.js";
import { exportFromFile } from "./core/export-html/index.js";
import { applyHttpProxySettings, configureHttpDispatcher } from "./core/http-dispatcher.js";
import { getModelNarrowingPatterns, resolveCliModel, resolveModelScope, } from "./core/model-resolver.js";
import { ModelRuntime } from "./core/model-runtime.js";
import { markMovedSessions, withMovedSessions } from "./core/moved-sessions.js";
import { restoreStdout, takeOverStdout } from "./core/output-guard.js";
import { recordProcessLifetime } from "./core/process-crash-record.js";
import { resolveProjectTrusted } from "./core/project-trust.js";
import { resolveResumeTarget } from "./core/resume-target.js";
import { formatMissingSessionCwdPrompt, getMissingSessionCwdIssue, MissingSessionCwdError, } from "./core/session-cwd.js";
import { sessionExtensionFlagValues } from "./core/session-extension-flags.js";
import { assertValidSessionId, SessionManager } from "./core/session-manager.js";
import { classifySessionRepository, readSessionCwd, rebindSessionFile } from "./core/session-rebind.js";
import { collectSettingsDiagnosticsWithContext } from "./core/settings-diagnostics.js";
import { SettingsManager } from "./core/settings-manager.js";
import { printTimings, recordTiming, resetTimings, time } from "./core/timings.js";
import { hasTrustRequiringProjectResources, ProjectTrustStore } from "./core/trust-manager.js";
import { builtInExtensions } from "./extensions/index.js";
import { getFromSourceRealConfigWarning } from "./from-source-config-guard.js";
import { legacyPiEditStartupNotice } from "./legacy-pi-edits.js";
import { runMigrations, showDeprecationWarnings } from "./migrations.js";
import { initTheme, stopThemeWatcher } from "./modes/interactive/theme/theme.js";
import { runPrintMode } from "./modes/print-mode.js";
import { startHostChildReaper } from "./modes/rpc/child-reaper.js";
import { AUTO_TITLE_SESSIONS_CAPABILITY, parseClientCapabilities } from "./modes/rpc/custom-capability.js";
import { dispatchInternalSupervisor } from "./modes/rpc/supervisor-route.js";
import { isLocalPath, normalizePath, resolvePath } from "./utils/paths.js";
import { cleanupWindowsSelfUpdateQuarantine } from "./utils/windows-self-update.js";
const EXTENSION_LOAD_FAILURE_HINT = `Hint: Start without extensions using "${APP_NAME} -ne".`;
/**
 * Read all content from piped stdin.
 * Returns undefined if stdin is a TTY (interactive terminal).
 */
async function readPipedStdin() {
    // If stdin is a TTY, we're running interactively - don't read stdin
    if (process.stdin.isTTY) {
        return undefined;
    }
    return new Promise((resolve) => {
        let data = "";
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", (chunk) => {
            data += chunk;
        });
        process.stdin.on("end", () => {
            resolve(data.trim() || undefined);
        });
        process.stdin.resume();
    });
}
function collectAuthDiagnostics(authStorage, context) {
    return authStorage.drainErrors().map((error) => ({
        type: "warning",
        message: `(${context}, auth storage) ${error.message}`,
    }));
}
export function collectExtensionLoadDiagnostics(errors) {
    return errors.map(({ path, error }) => ({
        type: "warning",
        message: `Failed to load extension "${path}": ${error}`,
    }));
}
function reportDiagnostics(diagnostics) {
    for (const diagnostic of diagnostics) {
        const color = diagnostic.type === "error" ? chalk.red : diagnostic.type === "warning" ? chalk.yellow : chalk.dim;
        const prefix = diagnostic.type === "error" ? "Error: " : diagnostic.type === "warning" ? "Warning: " : "";
        console.error(color(`${prefix}${diagnostic.message}`));
    }
}
function isTruthyEnvFlag(value) {
    if (!value)
        return false;
    return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}
function resolveAppMode(parsed, stdinIsTTY, stdoutIsTTY) {
    if (parsed.mode === undefined && parsed.messages[0] === "app-server") {
        return "app-server";
    }
    if (parsed.mode === "rpc") {
        return "rpc";
    }
    if (parsed.mode === "json") {
        return "json";
    }
    if (parsed.print || !stdinIsTTY || !stdoutIsTTY) {
        return "print";
    }
    return "interactive";
}
function toPrintOutputMode(appMode) {
    return appMode === "json" ? "json" : "text";
}
function toProjectTrustMode(appMode) {
    return appMode === "app-server" ? "print" : appMode;
}
/**
 * Interactive launches auto-title by default. RPC clients can opt in through
 * `auto_title_sessions`; every other non-interactive app mode opts in with
 * `--auto-title-sessions`. A per-session `open_session.auto_title`, when present,
 * replaces that host-wide decision for that session only. Sessions resumed with
 * existing context messages are never retitled, whatever the mode, capability,
 * flag, or per-session override.
 */
export function resolveAutoTitleSessions(appMode, parsed, hasContextMessages, clientCapabilities = parseClientCapabilities(envValue("RPC_CLIENT_CAPABILITIES")), sessionAutoTitle) {
    if (hasContextMessages)
        return false;
    if (sessionAutoTitle !== undefined)
        return sessionAutoTitle;
    return (appMode === "interactive" ||
        parsed.autoTitleSessions === true ||
        (appMode === "rpc" && clientCapabilities.includes(AUTO_TITLE_SESSIONS_CAPABILITY)));
}
function isPlainRuntimeMetadataCommand(parsed) {
    return (!parsed.print &&
        parsed.mode === undefined &&
        (parsed.help === true || parsed.listModels !== undefined || parsed.listTips === true));
}
async function runAuthCommand(args) {
    if (isAuthCommandHelp(args)) {
        printAuthCommandHelp();
        return true;
    }
    let command;
    try {
        command = parseAuthCommand(args);
    }
    catch (error) {
        const message = error instanceof AuthCommandError ? error.message : "Failed to parse auth command";
        console.error(chalk.red(`Error: ${message}`));
        process.exitCode = 1;
        return true;
    }
    if (!command)
        return false;
    const parsed = parseArgs(command.args);
    if (parsed.unknownFlags.size > 0) {
        const option = parsed.unknownFlags.keys().next().value;
        console.error(chalk.red(`Unknown option --${option} for "${getAuthCommandName(command.kind)}".`));
        console.error(chalk.dim(`Use "${APP_NAME} --help" or "${getAuthCommandUsage(command.kind)}".`));
        process.exitCode = 1;
        return true;
    }
    try {
        if (parsed.diagnostics.length > 0) {
            throw new AuthCommandError(parsed.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
        }
        if (command.kind !== "check") {
            const signal = AbortSignal.timeout(15_000);
            const modelRuntime = await ModelRuntime.create({ allowModelNetwork: false, signal });
            const credential = await resolveCredentialForPrint(parsed, modelRuntime, command.kind, command.minExpiryMs, signal);
            process.stdout.write(`${credential}\n`);
            return true;
        }
        const requestedAuth = validateAuthCommandArgs(parsed, command.kind);
        let result;
        let credential;
        try {
            const credentials = command.noRefresh ? new ReadOnlyAuthStorage() : AuthStorage.create();
            const modelRuntime = await createAuthCheckModelRuntime(credentials);
            result = await checkProviderAuth(parsed, modelRuntime, { refresh: !command.noRefresh });
            if (command.credentials && result.status === "ready") {
                credential = await getProviderCredential(result.provider, modelRuntime, credentials, {
                    refresh: !command.noRefresh,
                });
                if (!credential) {
                    result = { status: "not_ready", provider: result.provider, reason: "credential_not_available" };
                }
            }
        }
        catch {
            result = {
                status: "invalid",
                provider: requestedAuth.provider ?? requestedAuth.model,
                reason: "invalid_state",
            };
        }
        let accounts = [];
        if (command.json && result.status !== "invalid") {
            try {
                const credentials = command.noRefresh ? new ReadOnlyAuthStorage() : AuthStorage.create();
                accounts = await summarizeCredentialAccounts(result.provider, await credentials.read(result.provider));
            }
            catch {
                // Account enrichment must never turn a readable auth state into a failure.
            }
        }
        const output = command.json
            ? JSON.stringify({ ...result, accounts, ...(credential ? { credentials: credential } : {}) })
            : (credential ?? result.status);
        process.stdout.write(`${output}\n`);
        process.exitCode = result.status === "ready" ? 0 : result.status === "not_ready" ? 1 : 2;
    }
    catch (error) {
        const message = error instanceof AuthCommandError ? error.message : "Failed to resolve credential";
        console.error(chalk.red(`Error: ${message}`));
        process.exitCode = command.kind === "check" ? 2 : 1;
    }
    return true;
}
async function prepareInitialMessage(parsed, autoResizeImages, stdinContent) {
    if (parsed.fileArgs.length === 0) {
        return buildInitialMessage({ parsed, stdinContent });
    }
    const { text, images } = await processFileArguments(parsed.fileArgs, { autoResizeImages });
    return buildInitialMessage({
        parsed,
        fileText: text,
        fileImages: images,
        stdinContent,
    });
}
/**
 * Resolve a session argument to a file path.
 * If it looks like a path, use as-is. Otherwise try to match as session ID prefix.
 */
async function findLocalSessionByExactId(sessionId, cwd, sessionDir) {
    const localSessions = sessionDir ? await SessionManager.listAll(sessionDir) : await SessionManager.list(cwd);
    const localMatch = localSessions.find((s) => s.id === sessionId);
    return localMatch ? { type: "local", path: localMatch.path } : undefined;
}
async function resolveSessionPath(sessionArg, cwd, sessionDir) {
    // If it looks like a file path, resolve it before handing it to the session manager.
    if (sessionArg.includes("/") || sessionArg.includes("\\") || sessionArg.endsWith(".jsonl")) {
        return { type: "path", path: resolvePath(sessionArg, cwd) };
    }
    // Try to match as session ID in current project first
    const localSessions = await SessionManager.list(cwd, sessionDir);
    const localMatch = localSessions.find((s) => s.id === sessionArg) ?? localSessions.find((s) => s.id.startsWith(sessionArg));
    if (localMatch) {
        return { type: "local", path: localMatch.path };
    }
    // Try global search across all projects
    const allSessions = await SessionManager.listAll(sessionDir);
    const globalMatch = allSessions.find((s) => s.id === sessionArg) ?? allSessions.find((s) => s.id.startsWith(sessionArg));
    if (globalMatch) {
        return { type: "global", path: globalMatch.path, cwd: globalMatch.cwd };
    }
    // Not found anywhere
    return { type: "not_found", arg: sessionArg };
}
/**
 * Prompt user for yes/no confirmation.
 * Resolves false on stdin EOF (Ctrl+D, closed pipe): without the close handler a
 * readline question never settles once the input stream ends, hanging the process.
 */
export async function promptConfirm(message) {
    return new Promise((resolve) => {
        const rl = createInterface({
            input: process.stdin,
            output: process.stdout,
        });
        let settled = false;
        const settle = (result) => {
            if (settled)
                return;
            settled = true;
            resolve(result);
        };
        rl.question(`${message} [y/N] `, (answer) => {
            const normalized = answer.trim().toLowerCase();
            settle(normalized === "y" || normalized === "yes");
            rl.close();
        });
        rl.once("close", () => settle(false));
    });
}
function validateForkFlags(parsed) {
    if (!parsed.fork)
        return;
    const conflictingFlags = [
        parsed.session ? "--session" : undefined,
        parsed.continue ? "--continue" : undefined,
        parsed.resume ? "--resume" : undefined,
        parsed.noSession ? "--no-session" : undefined,
    ].filter((flag) => flag !== undefined);
    if (conflictingFlags.length > 0) {
        console.error(chalk.red(`Error: --fork cannot be combined with ${conflictingFlags.join(", ")}`));
        process.exit(1);
    }
}
function validateRebindFlags(parsed) {
    if (!parsed.rebind)
        return;
    const conflictingFlags = [
        parsed.session ? "--session" : undefined,
        parsed.fork ? "--fork" : undefined,
        parsed.continue ? "--continue" : undefined,
        parsed.resume ? "--resume" : undefined,
        parsed.noSession ? "--no-session" : undefined,
        parsed.sessionId !== undefined ? "--session-id" : undefined,
    ].filter((flag) => flag !== undefined);
    if (conflictingFlags.length > 0) {
        console.error(chalk.red(`Error: --rebind cannot be combined with ${conflictingFlags.join(", ")}`));
        process.exit(1);
    }
}
function validateSessionIdFlags(parsed) {
    if (parsed.sessionId === undefined)
        return;
    const conflictingFlags = [
        parsed.session ? "--session" : undefined,
        parsed.continue ? "--continue" : undefined,
        parsed.resume ? "--resume" : undefined,
    ].filter((flag) => flag !== undefined);
    if (conflictingFlags.length > 0) {
        console.error(chalk.red(`Error: --session-id cannot be combined with ${conflictingFlags.join(", ")}`));
        process.exit(1);
    }
    try {
        assertValidSessionId(parsed.sessionId);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(chalk.red(`Error: ${message}`));
        process.exit(1);
    }
}
function openSessionOrExit(path, sessionDir) {
    try {
        return SessionManager.open(path, sessionDir);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(chalk.red(`Error: ${message}`));
        process.exit(1);
    }
}
function forkSessionOrExit(sourcePath, cwd, sessionDir, sessionId) {
    try {
        return SessionManager.forkFrom(sourcePath, cwd, sessionDir, { id: sessionId });
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(chalk.red(`Error: ${message}`));
        process.exit(1);
    }
}
async function rebindSessionOrExit(sourcePath, cwd, sessionDir) {
    try {
        const reboundPath = await rebindSessionFile(sourcePath, cwd, sessionDir);
        console.log(chalk.dim(`Session moved to ${cwd}`));
        return SessionManager.open(reboundPath, sessionDir);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(chalk.red(`Error: ${message}`));
        process.exit(1);
    }
}
function sessionCwdOrUndefined(sessionFile) {
    try {
        return readSessionCwd(sessionFile);
    }
    catch {
        return undefined;
    }
}
export async function createSessionManager(parsed, cwd, sessionDir, settingsManager, appMode) {
    if (parsed.noSession || parsed.help || parsed.listModels !== undefined || parsed.listTips) {
        return SessionManager.inMemory(cwd, parsed.sessionId !== undefined ? { id: parsed.sessionId } : undefined);
    }
    if (parsed.fork) {
        if (parsed.sessionId) {
            const existingTarget = await findLocalSessionByExactId(parsed.sessionId, cwd, sessionDir);
            if (existingTarget) {
                console.error(chalk.red(`Session already exists with id '${parsed.sessionId}'`));
                process.exit(1);
            }
        }
        const resolved = await resolveSessionPath(parsed.fork, cwd, sessionDir);
        switch (resolved.type) {
            case "path":
            case "local":
            case "global":
                return forkSessionOrExit(resolved.path, cwd, sessionDir, parsed.sessionId);
            case "not_found":
                console.error(chalk.red(`No session found matching '${resolved.arg}'`));
                process.exit(1);
        }
    }
    if (parsed.rebind) {
        const resolved = await resolveSessionPath(parsed.rebind, cwd, sessionDir);
        if (resolved.type === "not_found") {
            console.error(chalk.red(`No session found matching '${resolved.arg}'`));
            process.exit(1);
        }
        const sessionCwd = resolved.type === "global" ? resolved.cwd : sessionCwdOrUndefined(resolved.path);
        if (resolved.type === "local" || sessionCwd === undefined || resolvePath(sessionCwd) === resolvePath(cwd)) {
            return openSessionOrExit(resolved.path, sessionDir);
        }
        if ((await classifySessionRepository(resolved.path, sessionCwd, cwd)) === "different") {
            console.error(chalk.red(`Refusing to rebind: ${cwd} is a different git repository than ${sessionCwd}. Use --fork '${parsed.rebind}' to copy the session into this directory instead.`));
            process.exit(1);
        }
        return rebindSessionOrExit(resolved.path, cwd, sessionDir);
    }
    if (parsed.session) {
        const resolved = await resolveSessionPath(parsed.session, cwd, sessionDir);
        switch (resolved.type) {
            case "path":
            case "local":
                return openSessionOrExit(resolved.path, sessionDir);
            case "global": {
                // The confirmation blocks on readline, which only an interactive session can
                // answer. Print, JSON, RPC, and app-server runs reach here with a TTY attached
                // too (`-p` from a terminal), where the question hangs the process or resolves
                // as "no" on stdin EOF, so they get the exact commands and a non-zero exit.
                const action = await chooseCrossProjectAction({
                    sessionArg: parsed.session,
                    sessionCwd: resolved.cwd,
                    cwd,
                    match: await classifySessionRepository(resolved.path, resolved.cwd, cwd),
                    interactive: appMode === "interactive",
                    confirm: promptConfirm,
                    out: (line) => console.log(line),
                    err: (line) => console.error(line),
                });
                if (action === "rebind")
                    return rebindSessionOrExit(resolved.path, cwd, sessionDir);
                if (action === "fork")
                    return forkSessionOrExit(resolved.path, cwd, sessionDir);
                if (action === "abort")
                    console.log(chalk.dim("Aborted."));
                return process.exit(action === "abort" ? 0 : 1);
            }
            case "not_found":
                console.error(chalk.red(`No session found matching '${resolved.arg}'`));
                process.exit(1);
        }
    }
    if (parsed.resume) {
        try {
            const { selectSession } = await import("./cli/session-picker.js");
            const movedOptions = sessionDir === undefined ? {} : { sessionDir };
            const selectedPath = await selectSession((onProgress) => withMovedSessions(SessionManager.list(cwd, sessionDir, onProgress), cwd, movedOptions), async (onProgress) => markMovedSessions(await SessionManager.listAll(sessionDir, onProgress), cwd), settingsManager);
            if (!selectedPath) {
                console.log(chalk.dim("No session selected"));
                process.exit(0);
            }
            const target = await resolveResumeTarget({
                sessionPath: selectedPath,
                cwd,
                ...movedOptions,
                confirm: (selectedCwd) => {
                    console.log(chalk.yellow(`Session found in different project: ${selectedCwd}`));
                    return confirmSameRepositoryRebind({
                        sessionArg: selectedPath,
                        cwd,
                        confirm: promptConfirm,
                        out: (line) => console.log(line),
                    });
                },
            }).catch((error) => {
                console.error(chalk.red(`Error: ${error instanceof Error ? error.message : String(error)}`));
                return process.exit(1);
            });
            if (target.rebound)
                console.log(chalk.dim(`Session moved to ${cwd}`));
            return SessionManager.open(target.path, sessionDir);
        }
        finally {
            stopThemeWatcher();
        }
    }
    if (parsed.continue) {
        const recent = SessionManager.continueRecent(cwd, sessionDir);
        const recentFile = recent.getSessionFile();
        if (recentFile !== undefined && existsSync(recentFile))
            return recent;
        const moved = await movedSessionToContinue({
            cwd,
            ...(sessionDir === undefined ? {} : { sessionDir }),
            interactive: appMode === "interactive",
            confirm: promptConfirm,
            out: (line) => console.log(line),
            err: (line) => console.error(line),
        });
        return moved === undefined ? recent : rebindSessionOrExit(moved, cwd, sessionDir);
    }
    if (parsed.sessionId) {
        const existingSession = await findLocalSessionByExactId(parsed.sessionId, cwd, sessionDir);
        if (existingSession) {
            return SessionManager.open(existingSession.path, sessionDir);
        }
        console.error(chalk.yellow(`Warning: No project session found with id '${parsed.sessionId}'; creating a new session with that id.`));
    }
    return SessionManager.create(cwd, sessionDir, { id: parsed.sessionId });
}
function buildSessionOptions(parsed, scopedModels, hasExistingSession, modelRuntime, settingsManager) {
    const options = {};
    const diagnostics = [];
    let cliThinkingFromModel = false;
    // Model from CLI
    // - supports --provider <name> --model <pattern>
    // - supports --model <provider>/<pattern>
    if (parsed.model) {
        const resolved = resolveCliModel({
            cliProvider: parsed.provider,
            cliModel: parsed.model,
            cliThinking: parsed.thinking,
            modelRuntime,
        });
        if (resolved.warning) {
            diagnostics.push({ type: "warning", message: resolved.warning });
        }
        if (resolved.error) {
            diagnostics.push({ type: "error", message: resolved.error });
        }
        if (resolved.model) {
            options.model = resolved.model;
            options.serviceTier = resolved.serviceTier;
            options.initialModelProvenance = "cli";
            // Allow "--model <pattern>:<thinking>" as a shorthand.
            // Explicit --thinking still takes precedence (applied later).
            if (!parsed.thinking && resolved.thinkingLevel) {
                options.thinkingLevel = resolved.thinkingLevel;
                options.thinkingSelection = resolved.thinkingSelection;
                cliThinkingFromModel = true;
            }
        }
    }
    if (!options.model && scopedModels.length > 0 && !hasExistingSession) {
        // Check if saved default is in scoped models - use it if so, otherwise first scoped model
        const savedProvider = settingsManager.getDefaultProvider();
        const savedModelId = settingsManager.getDefaultModel();
        const savedModel = savedProvider && savedModelId ? modelRuntime.getModel(savedProvider, savedModelId) : undefined;
        const savedInScope = savedModel ? scopedModels.find((sm) => modelsAreEqual(sm.model, savedModel)) : undefined;
        if (savedInScope) {
            options.model = savedInScope.model;
            options.initialModelProvenance = "scoped";
            // Use thinking level from scoped model config if explicitly set
            if (!parsed.thinking && savedInScope.thinkingLevel) {
                options.thinkingLevel = savedInScope.thinkingLevel;
                options.thinkingSelection = savedInScope.thinkingSelection;
            }
        }
        else {
            options.model = scopedModels[0].model;
            options.initialModelProvenance = "scoped";
            // Use thinking level from first scoped model if explicitly set
            if (!parsed.thinking && scopedModels[0].thinkingLevel) {
                options.thinkingLevel = scopedModels[0].thinkingLevel;
                options.thinkingSelection = scopedModels[0].thinkingSelection;
            }
        }
    }
    // Thinking level from CLI (takes precedence over scoped model thinking levels set above)
    if (parsed.thinking) {
        options.thinkingLevel = parsed.thinking;
        options.thinkingSelection = { level: parsed.thinking, source: "explicit" };
    }
    // Scoped models for Ctrl+P cycling
    // Keep thinking level undefined when not explicitly set in the model pattern.
    // Undefined means "inherit current session thinking level" during cycling.
    if (scopedModels.length > 0) {
        options.scopedModels = scopedModels.map((sm) => ({
            model: sm.model,
            thinkingLevel: sm.thinkingLevel,
            thinkingSelection: sm.thinkingSelection,
            serviceTier: sm.serviceTier,
        }));
    }
    // API key from CLI - set as a non-persistent runtime override
    // (handled by caller before createAgentSession)
    // Tools
    if (parsed.noTools) {
        options.noTools = "all";
    }
    else if (parsed.noBuiltinTools) {
        options.noTools = "builtin";
    }
    if (parsed.tools) {
        options.tools = [...parsed.tools];
    }
    if (parsed.excludeTools) {
        options.excludeTools = [...parsed.excludeTools];
    }
    return { options, cliThinkingFromModel, diagnostics };
}
function resolveCliPaths(cwd, paths) {
    return paths?.map((value) => (isLocalPath(value) ? resolvePath(value, cwd) : value));
}
async function promptForMissingSessionCwd(issue, settingsManager) {
    return showStartupSelector(settingsManager, formatMissingSessionCwdPrompt(issue), [
        { label: "Continue", value: issue.fallbackCwd },
        { label: "Cancel", value: undefined },
    ]);
}
/**
 * Supply grok-night as a non-persistent fallback until a user explicitly chooses
 * a theme. Existing settings are always returned first.
 */
export function applyGrokNeoThemeFallback(settingsManager) {
    if (settingsManager.getThemeSetting() !== undefined)
        return;
    const getThemeSetting = settingsManager.getThemeSetting.bind(settingsManager);
    const setTheme = settingsManager.setTheme.bind(settingsManager);
    let fallbackActive = true;
    settingsManager.getThemeSetting = () => getThemeSetting() ?? (fallbackActive ? "grok-night" : undefined);
    settingsManager.setTheme = (theme) => {
        fallbackActive = false;
        setTheme(theme);
    };
}
/** Fixed launch data is cloneable; UI callbacks and extension factories stay in their isolate. */
export function createCliRuntimeFactory(configuration, local = {}) {
    const { parsed, cwd, agentDir, appMode } = configuration;
    const extensionFactories = local.extensionFactories ?? builtInExtensions;
    const startupSettingsManager = local.startupSettingsManager ?? SettingsManager.create(cwd, agentDir);
    const startupLoadingIndicator = local.startupLoadingIndicator ??
        createStartupLoadingIndicator({
            writer: () => { },
            isTTY: false,
            label: `Loading ${APP_NAME}`,
        });
    const trustStore = new ProjectTrustStore(agentDir);
    const projectTrustByCwd = new Map();
    const trustPromptMode = parsed.help || parsed.listModels !== undefined || parsed.listTips ? "print" : toProjectTrustMode(appMode);
    const resolvedExtensionPaths = resolveCliPaths(cwd, parsed.extensions);
    const resolvedSkillPaths = resolveCliPaths(cwd, parsed.skills);
    const resolvedPromptTemplatePaths = resolveCliPaths(cwd, parsed.promptTemplates);
    const resolvedThemePaths = resolveCliPaths(cwd, parsed.themes);
    // The cwd-bound services one session needs, built alone: the runtime factory below builds them
    // before its session, and a multi-session host's `warm` builds and drops them (senpi#2314).
    const createServices = async ({ cwd, agentDir, projectTrustContext, launchProfile, mcpRegistry, isInitialRuntime, }) => {
        const projectTrustDiagnostics = [];
        const cachedProjectTrust = projectTrustByCwd.get(cwd);
        const hasTrustRequiringResources = hasTrustRequiringProjectResources(cwd);
        const shouldResolveProjectTrust = parsed.projectTrustOverride === undefined && cachedProjectTrust === undefined && hasTrustRequiringResources;
        const projectTrusted = shouldResolveProjectTrust
            ? false
            : (cachedProjectTrust ??
                parsed.projectTrustOverride ??
                (!hasTrustRequiringResources || trustStore.get(cwd) === true));
        const runtimeSettingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted });
        const services = await createAgentSessionServices({
            cwd,
            agentDir,
            settingsManager: runtimeSettingsManager,
            ...(local.modelRuntime === undefined ? {} : { modelRuntime: local.modelRuntime }),
            mcpRegistry,
            modelRuntimeSignal: AbortSignal.timeout(15_000),
            extensionFlagValues: sessionExtensionFlagValues(parsed.unknownFlags, launchProfile),
            resourceLoaderReloadOptions: shouldResolveProjectTrust
                ? {
                    resolveProjectTrust: async ({ extensionsResult }) => {
                        const trusted = await resolveProjectTrusted({
                            cwd,
                            trustStore,
                            trustOverride: parsed.projectTrustOverride,
                            defaultProjectTrust: startupSettingsManager.getDefaultProjectTrust(),
                            extensionsResult,
                            projectTrustContext: projectTrustContext ??
                                pauseIndicatorDuringPrompts(createProjectTrustContext({
                                    cwd,
                                    mode: isInitialRuntime ? trustPromptMode : toProjectTrustMode(appMode),
                                    settingsManager: startupSettingsManager,
                                    hasUI: isInitialRuntime && trustPromptMode === "interactive",
                                }), startupLoadingIndicator),
                            onExtensionError: (message) => projectTrustDiagnostics.push({ type: "warning", message }),
                        });
                        projectTrustByCwd.set(cwd, trusted);
                        return trusted;
                    },
                }
                : undefined,
            resourceLoaderOptions: {
                // Per-session identity reaches the extensions this session loads and stops
                // there: it is deliberately NOT merged into `parsed`, so it can never move
                // a model, an auth decision or a CLI flag.
                sessionKind: launchProfile?.sessionKind,
                sessionContext: launchProfile?.sessionContext,
                additionalExtensionPaths: resolvedExtensionPaths,
                additionalSkillPaths: resolvedSkillPaths,
                additionalPromptTemplatePaths: resolvedPromptTemplatePaths,
                additionalThemePaths: resolvedThemePaths,
                noExtensions: parsed.noExtensions,
                noSkills: parsed.noSkills,
                noPromptTemplates: parsed.noPromptTemplates,
                noThemes: parsed.noThemes,
                noContextFiles: parsed.noContextFiles,
                systemPrompt: parsed.systemPrompt,
                appendSystemPrompt: parsed.appendSystemPrompt,
                extensionFactories,
            },
        });
        return { services, projectTrustDiagnostics };
    };
    const createRuntime = async ({ cwd, agentDir, sessionManager, sessionStartEvent, projectTrustContext, launchProfile, mcpRegistry, }) => {
        const isInitialRuntime = sessionStartEvent === undefined;
        const markSwitch = (label) => {
            if (sessionStartEvent?.reason === "resume")
                time(label, "switch");
        };
        const { services, projectTrustDiagnostics } = await createServices({
            cwd,
            agentDir,
            ...(projectTrustContext !== undefined ? { projectTrustContext } : {}),
            ...(launchProfile !== undefined ? { launchProfile } : {}),
            ...(mcpRegistry !== undefined ? { mcpRegistry } : {}),
            isInitialRuntime,
        });
        markSwitch("services");
        const { settingsManager, modelRuntime, resourceLoader } = services;
        const diagnostics = [
            ...projectTrustDiagnostics,
            ...services.diagnostics,
            ...collectSettingsDiagnosticsWithContext(settingsManager, "runtime creation"),
            ...collectExtensionLoadDiagnostics(resourceLoader.getExtensions().errors),
            ...(resourceLoader.getExtensions().warnings ?? []).map(({ path, warning }) => ({
                type: "warning",
                message: `Extension package "${path}": ${warning}`,
            })),
        ];
        const modelPatterns = getModelNarrowingPatterns({
            cliPatterns: parsed.models,
            legacyEnabledPatterns: settingsManager.getEnabledModels(),
        });
        const scopedModels = modelPatterns && modelPatterns.length > 0
            ? await resolveModelScope(modelPatterns, modelRuntime, { signal: AbortSignal.timeout(15_000) })
            : [];
        // Multi-session opens carry their per-session startup choices here rather
        // than through process argv. This deliberately feeds the same resolver as
        // --provider/--model/--thinking, preserving classic flag semantics.
        const runtimeParsed = launchProfile === undefined
            ? parsed
            : {
                ...parsed,
                ...(launchProfile.creationModel === undefined
                    ? {}
                    : {
                        provider: launchProfile.creationModel.provider,
                        model: launchProfile.creationModel.modelId,
                    }),
                ...(launchProfile.initialThinkingLevel === undefined
                    ? {}
                    : { thinking: launchProfile.initialThinkingLevel }),
            };
        const { options: sessionOptions, cliThinkingFromModel, diagnostics: sessionOptionDiagnostics, } = buildSessionOptions(runtimeParsed, scopedModels, sessionManager.hasContextMessages(), modelRuntime, settingsManager);
        diagnostics.push(...sessionOptionDiagnostics);
        if (parsed.apiKey) {
            if (!sessionOptions.model) {
                diagnostics.push({
                    type: "error",
                    message: "--api-key requires a model to be specified via --model, --provider/--model, or --models",
                });
            }
            else {
                await modelRuntime.setRuntimeApiKey(sessionOptions.model.provider, parsed.apiKey);
            }
        }
        if (isInitialRuntime) {
            startupLoadingIndicator.setPhase("opening session");
        }
        markSwitch("sessionOptions");
        const created = await createAgentSessionFromServices({
            services,
            sessionManager,
            sessionStartEvent,
            model: sessionOptions.model,
            initialModelProvenance: sessionOptions.initialModelProvenance,
            thinkingLevel: sessionOptions.thinkingLevel,
            thinkingSelection: sessionOptions.thinkingSelection,
            serviceTier: sessionOptions.serviceTier,
            scopedModels: sessionOptions.scopedModels,
            tools: sessionOptions.tools,
            excludeTools: sessionOptions.excludeTools,
            noTools: sessionOptions.noTools,
            customTools: sessionOptions.customTools,
            autoTitleSessions: resolveAutoTitleSessions(appMode, parsed, sessionManager.hasContextMessages(), parseClientCapabilities(envValue("RPC_CLIENT_CAPABILITIES")), launchProfile?.autoTitle),
            promptSurface: launchProfile?.promptSurface,
        });
        markSwitch("createSession");
        const cliThinkingOverride = runtimeParsed.thinking !== undefined || cliThinkingFromModel;
        if (created.session.model && cliThinkingOverride) {
            created.session.setThinkingLevel(created.session.thinkingLevel);
        }
        return {
            ...created,
            services,
            diagnostics,
        };
    };
    // A host open creates its session with no start event, so a warm prepares exactly that open.
    return Object.assign(createRuntime, {
        prepare: async (options) => {
            await createServices({ ...options, isInitialRuntime: true });
        },
    });
}
export async function main(args, options) {
    resetTimings();
    // The pre-main phase - runtime boot, cli.js, and this module's static import graph - is already
    // over when the first statement runs, so it is read from the process clock rather than measured.
    recordTiming("processStart->main", Math.round(process.uptime() * 1000));
    const extensionFactories = [...builtInExtensions, ...(options?.extensionFactories ?? [])];
    const offlineMode = args.includes("--offline") || isTruthyEnvFlag(envValue("OFFLINE"));
    if (offlineMode) {
        process.env.PI_OFFLINE = "1";
        process.env.PI_SKIP_VERSION_CHECK = "1";
    }
    if (await runAuthCommand(args)) {
        return;
    }
    if (isModelsDiscoverCommand(args)) {
        process.exitCode = await runModelsDiscoverCommand(args.slice(2));
        return;
    }
    // Internal launch surface used by bundled/rebranded runtimes. It is deliberately
    // not accepted by parseArgs, so existing CLI modes remain unchanged. The route and
    // the RPC host graph behind it live in ./modes/rpc/supervisor-route.ts.
    if (await dispatchInternalSupervisor(args)) {
        return;
    }
    if (process.platform === "win32") {
        cleanupWindowsSelfUpdateQuarantine(getInstallPackageDir());
    }
    const cwd = process.cwd();
    const agentDir = getAgentDir();
    const fromSourceWarning = getFromSourceRealConfigWarning(agentDir);
    if (fromSourceWarning) {
        console.error(chalk.yellow(fromSourceWarning));
    }
    const bootstrapSettingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
    applyHttpProxySettings(bootstrapSettingsManager.getGlobalSettings().httpProxy);
    configureHttpDispatcher();
    if (await dispatchPackageCommand(args, { extensionFactories })) {
        const exitCode = process.exitCode ?? 0;
        if (process.platform === "win32" && exitCode === 0 && args[0] === "update") {
            // We normally prefer process.exit(0) for package commands so bad extensions cannot keep
            // one-shot commands alive. On Windows, Node can assert after fetch() if process.exit(0)
            // runs during teardown; let successful `pi update` drain naturally instead.
            // https://github.com/nodejs/node/issues/56645
            return;
        }
        process.exit(exitCode);
        return;
    }
    if (await dispatchConfigCommand(args, { extensionFactories })) {
        return;
    }
    if (await dispatchAppServerCommand(args)) {
        return;
    }
    // The shared-daemon command: one JSON line on stdout and an exit code that classifies it, so it
    // exits here rather than falling through into argument parsing and the interactive path.
    const hostExitCode = await dispatchHostCommand(args);
    if (hostExitCode !== undefined) {
        process.exit(hostExitCode);
    }
    // Durable scheduled prompts: fired out of process, so a job scheduled by an exited --print run still runs.
    const scheduleExitCode = await dispatchScheduleCommand(args);
    if (scheduleExitCode !== undefined) {
        process.exit(scheduleExitCode);
    }
    const parsed = parseArgs(args);
    if (parsed.diagnostics.length > 0) {
        for (const d of parsed.diagnostics) {
            const color = d.type === "error" ? chalk.red : chalk.yellow;
            console.error(color(`${d.type === "error" ? "Error" : "Warning"}: ${d.message}`));
        }
        if (parsed.diagnostics.some((d) => d.type === "error")) {
            process.exit(1);
        }
    }
    time("parseArgs");
    if (parsed.version) {
        console.log(DISPLAY_VERSION);
        process.exit(0);
    }
    if (parsed.export) {
        let result;
        try {
            const outputPath = parsed.messages.length > 0 ? parsed.messages[0] : undefined;
            result = await exportFromFile(parsed.export, outputPath);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : "Failed to export session";
            console.error(chalk.red(`Error: ${message}`));
            process.exit(1);
        }
        console.log(`Exported to: ${result}`);
        process.exit(0);
    }
    let appMode = resolveAppMode(parsed, process.stdin.isTTY, process.stdout.isTTY);
    const shouldTakeOverStdout = appMode !== "interactive" && (!isPlainRuntimeMetadataCommand(parsed) || (parsed.help && parsed.mode === "json"));
    if (shouldTakeOverStdout) {
        takeOverStdout();
    }
    if (parsed.mode === "json") {
        const log = console.log.bind(console);
        console.log = (...args) => console.error(...args);
        process.once("exit", () => {
            console.log = log;
        });
    }
    if (parsed.mode === "rpc" && parsed.fileArgs.length > 0) {
        console.error(chalk.red("Error: @file arguments are not supported in RPC mode"));
        process.exit(1);
    }
    validateForkFlags(parsed);
    validateRebindFlags(parsed);
    validateSessionIdFlags(parsed);
    // Run migrations (pass cwd for project-local migrations)
    const { migratedAuthProviders: migratedProviders, deprecationWarnings } = runMigrations(cwd);
    time("runMigrations");
    const startupSettingsManager = SettingsManager.create(cwd, agentDir);
    reportDiagnostics(collectSettingsDiagnosticsWithContext(startupSettingsManager, "startup session lookup"));
    const resolvedExtensionPaths = resolveCliPaths(cwd, parsed.extensions);
    const resolvedSkillPaths = resolveCliPaths(cwd, parsed.skills);
    const resolvedPromptTemplatePaths = resolveCliPaths(cwd, parsed.promptTemplates);
    const resolvedThemePaths = resolveCliPaths(cwd, parsed.themes);
    // Help is answered from the flags alone, so it stops here instead of continuing into the model
    // runtime, the session manager and the rest of the resource load. The flags are cached for the
    // next run, which `cli.ts` then answers before this module is even imported.
    if (isPlainHelpRequest(parsed)) {
        const projectTrusted = resolveHelpProjectTrust(parsed, cwd, agentDir);
        const scope = helpFlagsScope(parsed, cwd, agentDir, projectTrusted);
        const { flags, extensionPaths } = await resolveHelpExtensionFlags({
            cwd,
            agentDir,
            settingsManager: SettingsManager.create(cwd, agentDir, { projectTrusted }),
            additionalExtensionPaths: resolvedExtensionPaths ?? [],
            noExtensions: parsed.noExtensions === true,
            ...(extensionFactories ? { extensionFactories } : {}),
        });
        printHelp(flags);
        writeHelpFlagsCache({ scope, flags, extensionPaths });
        printTimings();
        process.exit(0);
    }
    if (parsed.listTips) {
        const { listTips } = await import("./cli/list-tips.js");
        listTips();
        process.exit(0);
    }
    if (parsed.listModels !== undefined) {
        const services = await createAgentSessionServices({
            cwd,
            agentDir,
            settingsManager: startupSettingsManager,
            extensionFlagValues: parsed.unknownFlags,
            resourceLoaderOptions: {
                additionalExtensionPaths: resolvedExtensionPaths,
                additionalSkillPaths: resolvedSkillPaths,
                additionalPromptTemplatePaths: resolvedPromptTemplatePaths,
                additionalThemePaths: resolvedThemePaths,
                noExtensions: parsed.noExtensions,
                noSkills: true,
                noPromptTemplates: true,
                noThemes: true,
                noContextFiles: true,
                extensionFactories,
            },
        });
        reportDiagnostics([
            ...services.diagnostics,
            ...collectSettingsDiagnosticsWithContext(services.settingsManager, "model listing"),
            ...collectAuthDiagnostics(services.authStorage, "model listing"),
        ]);
        const searchPattern = typeof parsed.listModels === "string" ? parsed.listModels : undefined;
        await listModels(services.modelRuntime, searchPattern);
        process.exit(0);
    }
    // Experimental first-time setup: theme choice and analytics opt-in.
    // Runs before any runtime services are created so the chosen settings apply everywhere.
    if (appMode === "interactive" &&
        !parsed.help &&
        parsed.listModels === undefined &&
        !parsed.listTips &&
        shouldRunFirstTimeSetup()) {
        await showFirstTimeSetup(startupSettingsManager);
        time("firstTimeSetup");
    }
    if (appMode === "interactive" && parsed.useTheme !== undefined) {
        startupSettingsManager.applyOverrides({ theme: parsed.useTheme });
    }
    if (appMode === "rpc" && parsed.multiSession) {
        if (options?.extensionFactories?.length)
            throw new Error("Shared RPC workers require file-backed extensions; inline factories cannot cross isolates");
        const runtimeConfiguration = { parsed, cwd, agentDir, appMode };
        // Socket hosts (the machine-wide daemon) run every session IN this process:
        // createHostCore selects the worker registry only when a workerConfiguration
        // is passed, so withholding it is what selects the uncapped in-process registry.
        const sessionRuntime = resolveSessionRuntime(parsed);
        const { runMultiSessionHost } = await import("./modes/rpc/multi-session-host.js");
        // In-process sessions share the host's model runtime: one agent dir, one
        // catalog. Worker sessions build their own inside the isolate - an object
        // cannot cross that boundary - so the shared one is offered only here.
        const hostModelRuntime = sessionRuntime === "worker"
            ? undefined
            : await ModelRuntime.create({
                credentials: AuthStorage.create(join(agentDir, "auth.json")),
                authPath: join(agentDir, "auth.json"),
                agentDir,
                modelsPath: join(agentDir, "models.json"),
                signal: AbortSignal.timeout(15_000),
            });
        // The multi-session host below never returns, so the initTheme() call further
        // down main() is unreachable on this path. Extensions load per open_session and
        // read the theme proxy: the worker runtime initializes the theme inside each
        // session worker, but the in-process runtime (the socket-host default) shares
        // this process, so the host must initialize the theme before serving sessions -
        // otherwise theme-touching extensions fail with "Theme not initialized. Call
        // initTheme() first." (senpi#1894).
        initTheme(startupSettingsManager.getTheme(), false);
        printTimings();
        await runMultiSessionHost({
            agentDir,
            createRuntime: createCliRuntimeFactory(runtimeConfiguration, {
                ...(hostModelRuntime === undefined ? {} : { modelRuntime: hostModelRuntime }),
            }),
            ...(sessionRuntime === "worker" ? { workerConfiguration: runtimeConfiguration } : {}),
            cwd,
            creationModel: parsed.provider && parsed.model ? { provider: parsed.provider, modelId: parsed.model } : undefined,
            initialThinkingLevel: parsed.thinking,
            listen: parsed.listen,
        });
    }
    // Decide the final runtime cwd before creating cwd-bound runtime services.
    // --session and --resume may select a session from another project, so project-local
    // settings, resources, provider registrations, and models must be resolved only after
    // the target session cwd is known. The startup-cwd settings manager is used only for
    // sessionDir lookup during session selection.
    const envSessionDir = process.env[ENV_SESSION_DIR];
    const sessionDir = (parsed.sessionDir ? normalizePath(parsed.sessionDir) : undefined) ??
        (envSessionDir ? expandTildePath(envSessionDir) : undefined) ??
        startupSettingsManager.getSessionDir();
    let sessionManager = await createSessionManager(parsed, cwd, sessionDir, startupSettingsManager, appMode);
    const missingSessionCwdIssue = getMissingSessionCwdIssue(sessionManager, cwd);
    if (missingSessionCwdIssue) {
        if (appMode === "interactive") {
            const selectedCwd = await promptForMissingSessionCwd(missingSessionCwdIssue, startupSettingsManager);
            if (!selectedCwd) {
                process.exit(0);
            }
            sessionManager = SessionManager.open(missingSessionCwdIssue.sessionFile, sessionDir, selectedCwd);
        }
        else {
            console.error(chalk.red(new MissingSessionCwdError(missingSessionCwdIssue).message));
            process.exit(1);
        }
    }
    if (parsed.name !== undefined) {
        const name = normalizeSessionName(parsed.name);
        if (name === undefined) {
            console.error(chalk.red("Error: --name requires a non-empty value"));
            process.exit(1);
        }
        sessionManager.appendSessionInfo(name);
    }
    time("createSessionManager");
    const sessionCwd = sessionManager.getCwd();
    const autoTrustOnReloadCwd = parsed.projectTrustOverride === undefined && !hasTrustRequiringProjectResources(sessionCwd)
        ? sessionCwd
        : undefined;
    // Immediate feedback while the heavy runtime (extensions, models, trust) is
    // created; without it the terminal stays blank and looks stuck (codex-style
    // UI-first startup). Stopped before any other surface writes to stdout.
    const startupLoadingIndicator = createStartupLoadingIndicator({
        writer: (chunk) => process.stdout.write(chunk),
        isTTY: process.stdout.isTTY === true,
        label: `Loading ${APP_NAME}`,
    });
    if (shouldShowStartupLoadingIndicator({
        appMode,
        stdoutIsTTY: process.stdout.isTTY === true,
        helpRequested: parsed.help === true,
    })) {
        startupLoadingIndicator.start();
        startupLoadingIndicator.setPhase("extensions & models");
    }
    const createRuntime = createCliRuntimeFactory({ parsed, cwd, agentDir, appMode }, { extensionFactories, startupSettingsManager, startupLoadingIndicator });
    time("createRuntime");
    const runtime = await createAgentSessionRuntime(createRuntime, {
        cwd: sessionManager.getCwd(),
        agentDir,
        sessionManager,
    }).finally(() => {
        startupLoadingIndicator.stop();
    });
    time("createAgentSessionRuntime");
    const { services, session, modelFallbackMessage } = runtime;
    const { settingsManager, modelRuntime, resourceLoader } = services;
    setCapabilityOverrides(settingsManager.getTerminalCapabilityOverrides());
    applyHttpProxySettings(settingsManager.getGlobalSettings().httpProxy);
    configureHttpDispatcher(settingsManager.getHttpIdleTimeoutMs());
    const loadedExtensions = resourceLoader.getExtensions().extensions;
    const extensionFlags = loadedExtensions.flatMap((extension) => Array.from(extension.flags.values()));
    if (parsed.help) {
        printHelp(extensionFlags);
        process.exit(0);
    }
    time("extensionFlags");
    // Every full launch refreshes what `--help` reads, so the fast path stays warm without a help
    // run of its own.
    writeHelpFlagsCache({
        scope: helpFlagsScope(parsed, cwd, agentDir, settingsManager.isProjectTrusted()),
        flags: extensionFlags,
        extensionPaths: loadedExtensions.map((extension) => extension.resolvedPath),
    });
    time("helpFlagsCache");
    // Read piped stdin content (if any) - skip for RPC mode which uses stdin for JSON-RPC
    let stdinContent;
    if (appMode !== "rpc") {
        stdinContent = await readPipedStdin();
        if (stdinContent !== undefined && appMode === "interactive") {
            appMode = "print";
        }
    }
    time("readPipedStdin");
    // An RPC process always has a parent that watches its exit; every other mode dies unobserved.
    recordProcessLifetime(agentDir, appMode, { supervised: appMode === "rpc" });
    time("recordProcessLifetime");
    const { initialMessage, initialImages, initialTitlePrompt } = await prepareInitialMessage(parsed, settingsManager.getImageAutoResize(), stdinContent);
    time("prepareInitialMessage");
    if (parsed.grokNeo && appMode === "interactive") {
        applyGrokNeoThemeFallback(settingsManager);
    }
    initTheme(settingsManager.getTheme(), appMode === "interactive");
    time("initTheme");
    // Show deprecation warnings in interactive mode
    if (appMode === "interactive" && deprecationWarnings.length > 0) {
        await showDeprecationWarnings(deprecationWarnings);
    }
    time("resolveModelScope");
    reportDiagnostics(runtime.diagnostics);
    if (appMode !== "interactive") {
        reportDiagnostics(collectAuthDiagnostics(services.authStorage, "runtime creation"));
    }
    if (runtime.diagnostics.some((diagnostic) => diagnostic.type === "error")) {
        if (runtime.diagnostics.some((diagnostic) => diagnostic.message.includes("Failed to load extension"))) {
            console.error(chalk.yellow(EXTENSION_LOAD_FAILURE_HINT));
        }
        process.exit(1);
    }
    time("createAgentSession");
    if (appMode !== "interactive" && !session.model) {
        console.error(chalk.red(formatNoModelsAvailableMessage()));
        process.exit(1);
    }
    const startupBenchmark = isTruthyEnvFlag(envValue("STARTUP_BENCHMARK"));
    if (startupBenchmark && appMode !== "interactive") {
        console.error(chalk.red("Error: PI_STARTUP_BENCHMARK only supports interactive mode"));
        process.exit(1);
    }
    // RPC refreshes catalogs here in the background; interactive mode starts its refresh after TUI initialization.
    if (!offlineMode && appMode === "rpc") {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15_000);
        void modelRuntime
            .refresh({ signal: controller.signal })
            .catch(() => { })
            .finally(() => clearTimeout(timeout));
    }
    // Every mode hosts the eval kernel, and a worker thread that is terminated takes its children's exit
    // watchers with it, so single-session modes arm the same reaper the multi-session host runs (#1962). The
    // TUI owns stderr, so interactive mode reaps silently.
    const stopChildReaper = await startHostChildReaper(appMode === "interactive" ? () => { } : (message) => void process.stderr.write(`${message}\n`));
    if (appMode === "rpc") {
        const { runRpcMode } = await import("./modes/rpc/rpc-mode.js");
        printTimings();
        await runRpcMode(runtime);
    }
    else if (appMode === "interactive") {
        // Keep the TUI graph out of headless RPC children. This is intentionally at the
        // mode seam: interactive startup still loads the same module before first use.
        const { InteractiveMode } = await import("./modes/interactive/interactive-mode.js");
        const interactiveMode = new InteractiveMode(runtime, {
            migratedProviders,
            legacyPiEditNotice: legacyPiEditStartupNotice(),
            modelFallbackMessage,
            autoTrustOnReloadCwd,
            initialMessage,
            initialImages,
            initialTitlePrompt,
            initialMessages: parsed.messages,
            verbose: parsed.verbose,
            chrome: parsed.grokNeo ? "grok" : undefined,
            tuiMode: parsed.tuiMode,
            initialThemeSetting: parsed.useTheme,
        });
        if (startupBenchmark) {
            await interactiveMode.init();
            time("interactiveMode.init");
            // Give the TUI's stdin handler a brief chance to consume terminal query replies
            // (Kitty keyboard protocol, device attributes, cell size) before restoring the terminal.
            await new Promise((resolve) => setTimeout(resolve, 150));
            interactiveMode.stop();
            stopThemeWatcher();
            printTimings();
            if (process.stdout.writableLength > 0) {
                await new Promise((resolve) => process.stdout.once("drain", resolve));
            }
            if (process.stderr.writableLength > 0) {
                await new Promise((resolve) => process.stderr.once("drain", resolve));
            }
            // Benchmark runs leave the TUI's terminal handles active, so returning here only parks the
            // loop; the measurement is complete, so the process ends with it.
            process.exit(0);
        }
        printTimings();
        await interactiveMode.run();
    }
    else {
        printTimings();
        const exitCode = await runPrintMode(runtime, {
            mode: toPrintOutputMode(appMode),
            messages: parsed.messages,
            initialMessage,
            initialImages,
        });
        reportDiagnostics(collectAuthDiagnostics(services.authStorage, "print mode"));
        stopChildReaper();
        stopThemeWatcher();
        restoreStdout();
        if (exitCode !== 0) {
            process.exitCode = exitCode;
        }
        return;
    }
}
//# sourceMappingURL=main.js.map
