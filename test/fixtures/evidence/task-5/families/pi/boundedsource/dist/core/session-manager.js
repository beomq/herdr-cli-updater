import { getCurrentSystemMessage, normalizeProviderId } from "@earendil-works/pi-ai";
import { randomBytes, randomUUID } from "crypto";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, writeFileSync, } from "fs";
import { appendFile, open, readdir, rm } from "fs/promises";
import { join, resolve } from "path";
import { StringDecoder } from "string_decoder";
import { APP_NAME, getAgentDir as getDefaultAgentDir, getSessionsDir } from "../config.js";
import { normalizePath, resolvePath } from "../utils/paths.js";
import { ALL_SESSION_LIST_PUBLISH_INTERVAL, listSessionFilesInDir, listSessionsFromDir, sortSessionInfos, } from "./session-discovery.js";
import { materializeSessionEntries } from "./session-entry-materializer.js";
import { replaceFileAtomically } from "./session-file-replace.js";
import { ResidentStringStore } from "./session-resident-store.js";
import { discardFailedFirstFlush, discardFailedFirstFlushAsync, truncateToLastCompleteLine, } from "./session-write-recovery.js";
import { hasOtherLiveSessionWriter, registerSessionWriter, reserveSessionWrite, unregisterSessionWriter, } from "./session-write-reservation.js";
import { isVirtualModel } from "./virtual-models.js";
// Fork change: inlined UUIDv7 (upstream uses the `uuid` npm package). Keeps this
// package self-contained so consumers don't need a transitive `uuid` install.
function uuidv7() {
    const ts = BigInt(Date.now());
    const bytes = randomBytes(10);
    const hex = [
        ((ts >> 40n) & 0xffn).toString(16).padStart(2, "0"),
        ((ts >> 32n) & 0xffn).toString(16).padStart(2, "0"),
        ((ts >> 24n) & 0xffn).toString(16).padStart(2, "0"),
        ((ts >> 16n) & 0xffn).toString(16).padStart(2, "0"),
        ((ts >> 8n) & 0xffn).toString(16).padStart(2, "0"),
        (ts & 0xffn).toString(16).padStart(2, "0"),
        (0x70 | (bytes[0] & 0x0f)).toString(16).padStart(2, "0"),
        bytes[1].toString(16).padStart(2, "0"),
        (0x80 | (bytes[2] & 0x3f)).toString(16).padStart(2, "0"),
        bytes[3].toString(16).padStart(2, "0"),
        ...Array.from(bytes.slice(4), (b) => b.toString(16).padStart(2, "0")),
    ].join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
import { createBranchSummaryMessage, createCompactionSummaryMessage, createCustomMessage, } from "./messages.js";
const contextMessageEntryIds = new WeakMap();
/** Request-local field carried across context hooks; never persisted or sent to providers. */
export const SESSION_CONTEXT_ENTRY_ID = "__piSessionContextEntryId";
function withContextEntryId(entryId, message) {
    contextMessageEntryIds.set(message, entryId);
    return message;
}
/** Entry identity for a transient message projected from session history. */
export function getSessionContextEntryId(message) {
    return contextMessageEntryIds.get(message);
}
export const CURRENT_SESSION_VERSION = 3;
function createSessionId() {
    return uuidv7();
}
export function assertValidSessionId(id) {
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(id)) {
        throw new Error("Session id must be non-empty, contain only alphanumeric characters, '-', '_', and '.', and start and end with an alphanumeric character");
    }
}
/** Generate a unique short ID (8 hex chars, collision-checked) */
function generateId(byId) {
    for (let i = 0; i < 100; i++) {
        const id = randomUUID().slice(0, 8);
        if (!byId.has(id))
            return id;
    }
    // Fallback to full UUID if somehow we have collisions
    return randomUUID();
}
/** Migrate v1 → v2: add id/parentId tree structure. Mutates in place. */
function migrateV1ToV2(entries) {
    const ids = new Set();
    let prevId = null;
    for (const entry of entries) {
        if (entry.type === "session") {
            entry.version = 2;
            continue;
        }
        entry.id = generateId(ids);
        entry.parentId = prevId;
        prevId = entry.id;
        // Convert firstKeptEntryIndex to firstKeptEntryId for compaction
        if (entry.type === "compaction") {
            const comp = entry;
            if (typeof comp.firstKeptEntryIndex === "number") {
                const targetEntry = entries[comp.firstKeptEntryIndex];
                if (targetEntry && targetEntry.type !== "session") {
                    comp.firstKeptEntryId = targetEntry.id;
                }
                delete comp.firstKeptEntryIndex;
            }
        }
    }
}
/** Migrate v2 → v3: rename hookMessage role to custom. Mutates in place. */
function migrateV2ToV3(entries) {
    for (const entry of entries) {
        if (entry.type === "session") {
            entry.version = 3;
            continue;
        }
        // Update message entries with hookMessage role
        if (entry.type === "message") {
            const msgEntry = entry;
            if (msgEntry.message && msgEntry.message.role === "hookMessage") {
                msgEntry.message.role = "custom";
            }
        }
    }
}
/**
 * Run all necessary migrations to bring entries to current version.
 * Mutates entries in place. Returns true if any migration was applied.
 */
function migrateToCurrentVersion(entries) {
    const header = entries.find((e) => e.type === "session");
    const version = header?.version ?? 1;
    if (version >= CURRENT_SESSION_VERSION)
        return false;
    if (version < 2)
        migrateV1ToV2(entries);
    if (version < 3)
        migrateV2ToV3(entries);
    return true;
}
/** Exported for testing */
export function migrateSessionEntries(entries) {
    migrateToCurrentVersion(entries);
}
/** Exported for compaction.test.ts */
export function parseSessionEntries(content) {
    const entries = [];
    const lines = content.trim().split("\n");
    for (const line of lines) {
        if (!line.trim())
            continue;
        try {
            const entry = JSON.parse(line);
            entries.push(entry);
        }
        catch {
            // Skip malformed lines
        }
    }
    return entries;
}
export function getLatestCompactionEntry(entries) {
    for (let i = entries.length - 1; i >= 0; i--) {
        if (entries[i].type === "compaction") {
            return entries[i];
        }
    }
    return null;
}
function buildEntryIndex(entries, byId) {
    if (byId)
        return byId;
    const index = new Map();
    for (const entry of entries) {
        index.set(entry.id, entry);
    }
    return index;
}
function buildSessionPath(entries, leafId, byId) {
    const index = buildEntryIndex(entries, byId);
    let leaf;
    if (leafId === null) {
        return [];
    }
    if (leafId) {
        leaf = index.get(leafId);
    }
    leaf ??= entries[entries.length - 1];
    if (!leaf) {
        return [];
    }
    const path = [];
    let current = leaf;
    while (current) {
        path.push(current);
        current = current.parentId ? index.get(current.parentId) : undefined;
    }
    path.reverse();
    return path;
}
function getSessionContextSettings(path) {
    let thinkingLevel = "off";
    let thinkingSelection;
    let configurationUpdate;
    let model = null;
    // An explicit selection (a manual `model_change`, or the primary restored from a fallback
    // window) outranks the model id echoed by later assistant messages from the SAME provider:
    // the persisted message id is the wire id, which differs from the catalog id whenever the
    // catalog entry maps to an `upstreamModelId` (a `-fast` priority variant is the common case),
    // so trusting the echo would resume the base model and silently drop the tier. A message
    // from another provider still wins, since no `model_change` recorded that hop.
    let isModelSelectionExplicit = false;
    let isInFallbackWindow = false;
    // A fallback switch applies an ephemeral thinking level to the fallback model, so
    // the level recorded inside the window must not outlive it: restoring the primary
    // model with the fallback model's level would silently change the reasoning budget.
    // Mirrors the model restoration above, including the never-reverted (crashed) case.
    let preFallbackThinkingLevel = thinkingLevel;
    let preFallbackThinkingSelection = thinkingSelection;
    for (const entry of path) {
        if (entry.type === "thinking_level_change") {
            thinkingLevel = entry.thinkingLevel;
            thinkingSelection = entry.thinkingSelection;
        }
        else if (entry.type === "configuration_update") {
            configurationUpdate = { effort: entry.reasoning.effort };
        }
        else if (entry.type === "model_change") {
            if (entry.reason === "fallback") {
                if (!isInFallbackWindow) {
                    preFallbackThinkingLevel = thinkingLevel;
                    preFallbackThinkingSelection = thinkingSelection;
                    if (entry.originalProvider && entry.originalModelId) {
                        // Read boundary (senpi#1989): a session recorded by an earlier
                        // version carries the legacy provider id, so normalize on read.
                        // No rewrite is added here.
                        model = { provider: normalizeProviderId(entry.originalProvider), modelId: entry.originalModelId };
                        isModelSelectionExplicit = true;
                    }
                }
                isInFallbackWindow = true;
            }
            else if (entry.reason === "fallback-revert") {
                if (isInFallbackWindow) {
                    thinkingLevel = preFallbackThinkingLevel;
                    thinkingSelection = preFallbackThinkingSelection;
                }
                isInFallbackWindow = false;
            }
            else {
                // A manual model switch abandons the window: the level the user set inside
                // it is a deliberate choice and carries over to the newly selected model.
                isInFallbackWindow = false;
                // Session files are parsed without validation, so an entry missing its provider or
                // model id must not become an authoritative selection; the fallback-original restore
                // above guards the same way, and a later assistant message still restores the model.
                if (entry.provider && entry.modelId) {
                    model = { provider: normalizeProviderId(entry.provider), modelId: entry.modelId };
                    isModelSelectionExplicit = true;
                }
            }
        }
        else if (entry.type === "message" &&
            entry.message.role === "assistant" &&
            !isInFallbackWindow &&
            // A failed routing attempt names the virtual model; no model answered it.
            !isVirtualModel(entry.message)) {
            if (isModelSelectionExplicit && model?.provider === normalizeProviderId(entry.message.provider))
                continue;
            model = { provider: normalizeProviderId(entry.message.provider), modelId: entry.message.model };
            isModelSelectionExplicit = false;
        }
    }
    // The process can exit inside a fallback window; the primary model is already
    // restored above, so its pre-fallback level has to be restored with it.
    if (isInFallbackWindow) {
        thinkingLevel = preFallbackThinkingLevel;
        thinkingSelection = preFallbackThinkingSelection;
    }
    return { thinkingLevel, thinkingSelection, configurationUpdate, model };
}
/**
 * Project one selected session entry into LLM/runtime messages.
 * Plain custom entries are display/state entries and do not participate in context.
 */
export function sessionEntryToContextMessages(entry) {
    if (entry.type === "message") {
        const message = entry.message;
        // Session files are parsed without validation; old versions, forks, or
        // hand-edited files can contain messages with null/missing content.
        if (message.role === "system" && message.content == null)
            return [{ ...message, content: "" }];
        if ((message.role === "user" || message.role === "assistant" || message.role === "toolResult") &&
            message.content == null) {
            return [withContextEntryId(entry.id, { ...message, content: [] })];
        }
        return [withContextEntryId(entry.id, message)];
    }
    if (entry.type === "configuration_update") {
        return [
            withContextEntryId(entry.id, {
                role: "configurationUpdate",
                content: [],
                effort: entry.reasoning.effort,
                timestamp: new Date(entry.timestamp).getTime(),
            }),
        ];
    }
    if (entry.type === "custom_message") {
        return [
            withContextEntryId(entry.id, createCustomMessage(entry.customType, entry.content ?? [], entry.display, entry.details, entry.timestamp)),
        ];
    }
    if (entry.type === "branch_summary" && entry.summary) {
        return [withContextEntryId(entry.id, createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp))];
    }
    if (entry.type === "compaction") {
        const summary = withContextEntryId(entry.id, createCompactionSummaryMessage(entry.summary, entry.tokensBefore, entry.timestamp, entry.details));
        return entry.systemMessage ? [withContextEntryId(entry.id, entry.systemMessage), summary] : [summary];
    }
    return [];
}
/**
 * Build the active, compaction-aware session entry list.
 *
 * This follows the current leaf path. If the path contains compaction entries,
 * the latest compaction is represented by the compaction entry itself, followed
 * by the kept entries starting at firstKeptEntryId and all entries after the
 * compaction entry. Older summarized entries are omitted.
 */
export function buildContextEntries(entries, leafId, byId) {
    const path = buildSessionPath(entries, leafId, byId);
    let compaction = null;
    for (const entry of path) {
        if (entry.type === "compaction") {
            compaction = entry;
        }
    }
    if (!compaction) {
        return path;
    }
    const compactionIdx = path.findIndex((entry) => entry.id === compaction.id);
    if (compactionIdx < 0) {
        return path;
    }
    const contextEntries = [compaction];
    let foundFirstKept = false;
    for (let i = 0; i < compactionIdx; i++) {
        const entry = path[i];
        // The latest summary supersedes every older compaction summary. Older
        // entries selected by firstKeptEntryId remain verbatim, but nesting a
        // prior summary here would double-count it in the model context.
        if (entry.type === "compaction")
            continue;
        if (entry.id === compaction.firstKeptEntryId) {
            foundFirstKept = true;
        }
        if (foundFirstKept && !(entry.type === "message" && entry.message.role === "system")) {
            contextEntries.push(entry);
        }
    }
    contextEntries.push(...path.slice(compactionIdx + 1));
    return contextEntries;
}
function projectContextEntry(entry, edit) {
    const messages = sessionEntryToContextMessages(entry);
    if (!edit)
        return messages;
    const replacement = edit.replacement;
    if (replacement === null)
        return [];
    return messages.map((message) => {
        if (message.role !== "user" &&
            message.role !== "assistant" &&
            message.role !== "toolResult" &&
            message.role !== "custom") {
            return message;
        }
        const content = (message.role === "assistant" || message.role === "toolResult") && typeof replacement.content === "string"
            ? [{ type: "text", text: replacement.content }]
            : replacement.content;
        // The edited copy keeps the entry identity of the message it replaces.
        return withContextEntryId(entry.id, { ...message, content });
    });
}
/** One pass over the path: the projection plus the fork's full context settings. */
function projectSession(entries, leafId, byId) {
    const path = buildSessionPath(entries, leafId, byId);
    const settings = getSessionContextSettings(path);
    const contextEntries = buildContextEntries(entries, leafId, byId);
    const edits = new Map();
    for (const entry of contextEntries) {
        if (entry.type === "context_edit")
            edits.set(entry.targetId, entry);
    }
    const projectedEntries = contextEntries.map((sourceEntry, index) => ({
        sourceEntry,
        // buildContextEntries() may retain an older compaction entry because its
        // raw ID lies inside the newest retained range. Only the newest compaction
        // at index zero contributes a checkpoint and summary.
        messages: sourceEntry.type === "compaction" && index > 0
            ? []
            : projectContextEntry(sourceEntry, edits.get(sourceEntry.id)),
    }));
    return {
        projection: {
            entries: projectedEntries,
            messages: projectedEntries.flatMap((entry) => entry.messages),
            thinkingLevel: settings.thinkingLevel,
            model: settings.model,
        },
        settings,
    };
}
/** Build provenance-preserving, compaction-aware model context. */
export function buildSessionProjection(entries, leafId, byId) {
    return projectSession(entries, leafId, byId).projection;
}
/**
 * Build the session context from entries using tree traversal.
 * If leafId is provided, walks from that entry to root.
 * Handles compaction, branch summaries and context edits along the path: the messages are the
 * canonical session projection's.
 */
export function buildSessionContext(entries, leafId, byId) {
    const { projection, settings } = projectSession(entries, leafId, byId);
    const { thinkingLevel, thinkingSelection, model, configurationUpdate } = settings;
    return { messages: projection.messages, thinkingLevel, thinkingSelection, model, configurationUpdate };
}
/**
 * Compute the default session directory for a cwd.
 * Encodes cwd into a safe directory name under ~/.senpi/agent/sessions/.
 */
function getDefaultSessionDirPath(cwd, agentDir = getDefaultAgentDir()) {
    const resolvedCwd = resolvePath(cwd);
    const resolvedAgentDir = resolvePath(agentDir);
    const safePath = `--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
    return join(resolvedAgentDir, "sessions", safePath);
}
export function getDefaultSessionDir(cwd, agentDir = getDefaultAgentDir()) {
    const sessionDir = getDefaultSessionDirPath(cwd, agentDir);
    if (!existsSync(sessionDir)) {
        mkdirSync(sessionDir, { recursive: true });
    }
    return sessionDir;
}
const SESSION_READ_BUFFER_SIZE = 1024 * 1024;
const SESSION_HEADER_READ_BUFFER_SIZE = 4096;
/** Bound synchronous header discovery while allowing large cwd and custom metadata fields. */
const MAX_SESSION_HEADER_SCAN_BYTES = 1024 * 1024;
class SessionHeaderScanLimitError extends Error {
    constructor(filePath) {
        super(`Session header exceeds ${MAX_SESSION_HEADER_SCAN_BYTES}-byte scan limit: ${filePath}`);
        this.name = "SessionHeaderScanLimitError";
    }
}
function parseSessionEntryLine(line) {
    if (!line.trim())
        return null;
    try {
        return JSON.parse(line);
    }
    catch {
        // Skip malformed lines
        return null;
    }
}
/** Exported for testing */
export function loadEntriesFromFile(filePath) {
    const resolvedFilePath = normalizePath(filePath);
    if (!existsSync(resolvedFilePath))
        return [];
    const entries = [];
    let pending = "";
    const fd = openSync(resolvedFilePath, "r");
    try {
        const decoder = new StringDecoder("utf8");
        const buffer = Buffer.allocUnsafe(SESSION_READ_BUFFER_SIZE);
        while (true) {
            const bytesRead = readSync(fd, buffer, 0, buffer.length, null);
            if (bytesRead === 0)
                break;
            pending += decoder.write(buffer.subarray(0, bytesRead));
            let lineStart = 0;
            let newlineIndex = pending.indexOf("\n", lineStart);
            while (newlineIndex !== -1) {
                const entry = parseSessionEntryLine(pending.slice(lineStart, newlineIndex));
                if (entry)
                    entries.push(entry);
                lineStart = newlineIndex + 1;
                newlineIndex = pending.indexOf("\n", lineStart);
            }
            pending = pending.slice(lineStart);
        }
        pending += decoder.end();
        const finalEntry = parseSessionEntryLine(pending);
        if (finalEntry)
            entries.push(finalEntry);
    }
    finally {
        closeSync(fd);
    }
    // Validate session header before repairing the file.
    if (entries.length === 0)
        return entries;
    const header = entries[0];
    if (header.type !== "session" || typeof header.id !== "string") {
        return [];
    }
    return entries;
}
/**
 * Inspect a physical line while searching for the first parsed session entry.
 * Blank and malformed lines are skipped to match loadEntriesFromFile().
 * Returns undefined to keep scanning, null for a parsed non-header entry, or the header.
 */
function parseSessionHeaderCandidate(line) {
    if (!line.trim())
        return undefined;
    const entry = parseSessionEntryLine(line);
    if (!entry)
        return undefined;
    if (entry.type !== "session" || typeof entry.id !== "string")
        return null;
    return entry;
}
function readSessionHeader(filePath) {
    const fd = openSync(filePath, "r");
    try {
        const decoder = new StringDecoder("utf8");
        const buffer = Buffer.allocUnsafe(SESSION_HEADER_READ_BUFFER_SIZE);
        const lineChunks = [];
        let scannedBytes = 0;
        while (scannedBytes < MAX_SESSION_HEADER_SCAN_BYTES) {
            const readLength = Math.min(buffer.length, MAX_SESSION_HEADER_SCAN_BYTES - scannedBytes);
            const bytesRead = readSync(fd, buffer, 0, readLength, null);
            if (bytesRead === 0) {
                lineChunks.push(decoder.end());
                return parseSessionHeaderCandidate(lineChunks.join("")) ?? null;
            }
            scannedBytes += bytesRead;
            const chunk = decoder.write(buffer.subarray(0, bytesRead));
            let lineStart = 0;
            let newlineIndex = chunk.indexOf("\n", lineStart);
            while (newlineIndex !== -1) {
                lineChunks.push(chunk.slice(lineStart, newlineIndex));
                const header = parseSessionHeaderCandidate(lineChunks.join(""));
                if (header !== undefined)
                    return header;
                lineChunks.length = 0;
                lineStart = newlineIndex + 1;
                newlineIndex = chunk.indexOf("\n", lineStart);
            }
            lineChunks.push(chunk.slice(lineStart));
        }
        // Probe for EOF so a final header without a newline is allowed when it ends
        // exactly at the scan limit. Any additional byte exceeds the bounded scan.
        const probe = Buffer.allocUnsafe(1);
        if (readSync(fd, probe, 0, probe.length, null) === 0) {
            lineChunks.push(decoder.end());
            return parseSessionHeaderCandidate(lineChunks.join("")) ?? null;
        }
        throw new SessionHeaderScanLimitError(filePath);
    }
    finally {
        closeSync(fd);
    }
}
function readSessionHeaderForDiscovery(filePath) {
    try {
        return readSessionHeader(filePath);
    }
    catch {
        // Discovery is best-effort: unreadable or oversized files are not sessions,
        // and one corrupt file must not prevent other sessions from being found.
        return null;
    }
}
function getSessionHeaderCwd(header) {
    const cwd = header.cwd;
    return typeof cwd === "string" ? cwd : undefined;
}
function sessionCwdMatches(cwd, resolvedCwd) {
    return cwd !== undefined && cwd !== "" && resolvePath(cwd) === resolvedCwd;
}
/** Exported for testing */
export function findMostRecentSession(sessionDir, cwd) {
    const resolvedSessionDir = normalizePath(sessionDir);
    const resolvedCwd = cwd ? resolvePath(cwd) : undefined;
    try {
        const files = readdirSync(resolvedSessionDir)
            .filter((file) => file.endsWith(".jsonl"))
            .map((file) => join(resolvedSessionDir, file))
            .map((path) => ({ path, mtime: statSync(path).mtimeMs }))
            .sort((a, b) => b.mtime - a.mtime);
        for (const { path } of files) {
            const header = readSessionHeaderForDiscovery(path);
            if (header && (!resolvedCwd || sessionCwdMatches(getSessionHeaderCwd(header), resolvedCwd)))
                return path;
        }
        return null;
    }
    catch {
        // Directory access and stat races make recent-session discovery unavailable.
        return null;
    }
}
/**
 * Manages conversation sessions as append-only trees stored in JSONL files.
 *
 * Each session entry has an id and parentId forming a tree structure. The "leaf"
 * pointer tracks the current position. Appending creates a child of the current leaf.
 * Branching moves the leaf to an earlier entry, allowing new branches without
 * modifying history.
 *
 * Use buildSessionContext() to get the resolved message list for the LLM, which
 * handles compaction summaries and follows the path from root to current leaf.
 */
let sessionEntryLoader = loadEntriesFromFile;
/** Test seam for observing disk reloads without mocking ESM filesystem exports. */
export function setSessionEntryLoaderForTesting(loader) {
    const previous = sessionEntryLoader;
    sessionEntryLoader = loader;
    return () => {
        sessionEntryLoader = previous;
    };
}
const SETUP_ONLY_ENTRY_TYPES = new Set([
    "session",
    "model_change",
    "model_change_rejected",
    "thinking_level_change",
]);
/** A user or assistant message: the first one makes a new session worth a file (#10000). */
function isConversationEntry(entry) {
    return entry.type === "message" && (entry.message.role === "user" || entry.message.role === "assistant");
}
export class SessionManager {
    constructor(cwd, sessionDir, sessionFile, persist, newSessionOptions, preloadedFileEntries) {
        this.sessionId = "";
        this.flushed = false;
        // Set when an append to the flushed file failed and may have left a partial last line.
        this.tailMayBeTorn = false;
        this.fileEntries = [];
        this.byId = new Map();
        // Runtime-only identity tracking lets AgentSession compare messages to a
        // compaction boundary by append order rather than provider timestamps.
        // Materialized persisted messages are bound as they are read; only pending
        // messages that have not reached a session entry use AgentSession's fallback.
        this.entryOrdersById = new Map();
        this.messageEntryPositions = new WeakMap();
        this.labelsById = new Map();
        this.labelTimestampsById = new Map();
        this.leafId = null;
        this.residentStore = new ResidentStringStore();
        this.mirrorTrimmed = false;
        // Counts loaded/appended entries, including those removed from the resident mirror.
        this.fullEntryCount = 0;
        this.compactEntriesCache = null;
        // Monotonic counter bumped by every mutator; memoized materialized views are
        // keyed on it so read hot paths (footer, RPC) never re-materialize unchanged sessions.
        this.mutationCount = 0;
        this.entriesCache = null;
        this.branchCache = null;
        this.sessionNameCache = undefined;
        // Running usage totals over ALL entries (not branch-scoped), maintained
        // incrementally on assistant-message append and rebuilt from scratch in
        // _buildIndex()/newSession. Usage fields are numeric and unaffected by
        // string externalization, so the resident form can be read directly.
        this.usageTotals = {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            cost: 0,
            latestCacheHitRate: undefined,
        };
        this.cwd = resolvePath(cwd);
        this.sessionDir = normalizePath(sessionDir);
        this.persist = persist;
        // A persisted manager owns its session file for as long as it lives; the shared
        // RPC host reads this registry to release grants no writer holds anymore.
        if (persist)
            registerSessionWriter(this);
        if (persist && this.sessionDir && !existsSync(this.sessionDir)) {
            mkdirSync(this.sessionDir, { recursive: true });
        }
        // Lazily resolved: the session id only exists once the header loads or
        // newSession() runs. Unpersisted sessions disable eviction entirely —
        // dropping strings with no backing would lose them.
        this.residentStore.configure({
            blobsDir: () => this.persist && this.sessionId ? join(this.sessionDir, "resident-blobs", this.sessionId) : undefined,
        });
        if (sessionFile) {
            this._setSessionFile(sessionFile, preloadedFileEntries, newSessionOptions);
        }
        else if (preloadedFileEntries?.length) {
            this._loadEntries(preloadedFileEntries, newSessionOptions);
        }
        else {
            this.newSession(newSessionOptions);
        }
    }
    /**
     * Reload session entries from the session file on disk.
     */
    reloadFromDisk() {
        if (!this.sessionFile || !existsSync(this.sessionFile))
            return;
        // A live session file can be observed between truncate and rewrite. Treat
        // that window (and an invalid replacement) as unavailable rather than
        // routing it through the create/recover path in _setSessionFile().
        const fileEntries = loadEntriesFromFile(this.sessionFile);
        if (fileEntries.length === 0) {
            if (statSync(this.sessionFile).size === 0)
                return;
            throw new Error(`Session file is not a valid ${APP_NAME} session: ${this.sessionFile}`);
        }
        this._setSessionFile(this.sessionFile, fileEntries);
    }
    /** Switch to a different session file (used for resume and branching) */
    setSessionFile(sessionFile) {
        this._setSessionFile(sessionFile);
    }
    _setSessionFile(sessionFile, preloadedFileEntries, newSessionOptions) {
        if (this.persist)
            reserveSessionWrite(resolvePath(sessionFile));
        this.sessionFile = resolvePath(sessionFile);
        this.mirrorTrimmed = false;
        this.residentStore.clear();
        if (existsSync(this.sessionFile)) {
            const entries = preloadedFileEntries ?? loadEntriesFromFile(this.sessionFile);
            // If file was empty, initialize it with a valid session header. If it was
            // non-empty but did not parse as a pi session, fail without modifying it.
            if (entries.length === 0) {
                const explicitPath = this.sessionFile;
                if (statSync(explicitPath).size > 0) {
                    throw new Error(`Session file is not a valid ${APP_NAME} session: ${explicitPath}`);
                }
                // The explicit path is already granted above and keeps being written here:
                // allocating a second path would take a grant no writer ever uses.
                // An empty file carries no identity yet, so a caller-supplied id still applies.
                this._resetToNewSession(newSessionOptions);
                this._rewriteFile();
                this.flushed = true;
                return;
            }
            // A file-backed load keeps the reader contract: an entry set without a header
            // adopts a fresh id in memory instead of creating a replacement session file
            // (which `_loadEntries`' header-less branch would do for ingested entries).
            this.fileEntries = entries;
            const header = this.fileEntries.find((e) => e.type === "session");
            this.sessionId = header?.id ?? createSessionId();
            // Blobs left under this id by a process that is gone are a disposable cache:
            // the JSONL is the authority for every entry and this store rewrites what it
            // evicts, so clearing them bounds the directory to one process lifetime.
            this._releaseBlobsDirUnlessShared();
            if (migrateToCurrentVersion(this.fileEntries)) {
                this._rewriteFile();
            }
            this.fileEntries = this.fileEntries.map((entry) => this.residentStore.externalize(entry));
            this._buildIndex();
            this.mutationCount++;
            this.flushed = true;
        }
        else {
            // Same here: the explicit path from --session stays the only granted one.
            // The file does not exist yet, so this open CREATES the session: a caller-supplied
            // id is the session's identity from here on. An EXISTING file never reaches this
            // branch, which is why a supplied id can never overwrite a header id.
            this._resetToNewSession(newSessionOptions);
            // A host-minted id is referenced by nothing yet, so its file may wait for the first
            // assistant message. A CALLER-chosen id is already held in the caller's own records:
            // the file has to answer to it now, or a reopen before the first reply would mint a
            // different identity and the caller's record would point at nothing (#2010).
            if (newSessionOptions?.id !== undefined) {
                this._rewriteFile();
                this.flushed = true;
            }
        }
    }
    newSession(options) {
        const timestamp = this._resetToNewSession(options);
        if (this.persist) {
            const fileTimestamp = timestamp.replace(/[:.]/g, "-");
            const path = join(this.getSessionDir(), `${fileTimestamp}_${this.sessionId}.jsonl`);
            reserveSessionWrite(path);
            this.sessionFile = path;
        }
        return this.sessionFile;
    }
    /** Resets every in-memory field onto a fresh header. Allocates no session path. */
    _resetToNewSession(options) {
        if (options?.id !== undefined) {
            assertValidSessionId(options.id);
        }
        // Capture the previous backing before the id changes: the blobsDir
        // provider resolves against the new id after this assignment, so clear()
        // below would otherwise leak the old session's blob directory on disk.
        const previousBlobsDir = this.residentStore.resolvedBlobsDir();
        this.sessionId = options?.id ?? createSessionId();
        const timestamp = new Date().toISOString();
        const header = {
            type: "session",
            version: CURRENT_SESSION_VERSION,
            id: this.sessionId,
            timestamp,
            cwd: this.cwd,
            parentSession: options?.parentSession,
        };
        this.fileEntries = [header];
        this.mirrorTrimmed = false;
        this.fullEntryCount = 0;
        this.residentStore.clear();
        if (previousBlobsDir) {
            this._removeBlobsDir(previousBlobsDir);
        }
        this.byId.clear();
        this.entryOrdersById.clear();
        this.messageEntryPositions = new WeakMap();
        this.labelsById.clear();
        this.labelTimestampsById.clear();
        this.leafId = null;
        this.sessionNameCache = undefined;
        this.usageTotals = {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            cost: 0,
            latestCacheHitRate: undefined,
        };
        this.mutationCount++;
        this.flushed = false;
        return timestamp;
    }
    _loadEntries(entries, options) {
        const header = entries.find((e) => e.type === "session");
        if (header) {
            this.fileEntries = entries;
            this.sessionId = header.id;
            if (migrateToCurrentVersion(this.fileEntries)) {
                this._rewriteFile();
            }
        }
        else {
            this.newSession(options);
            this.fileEntries = this.fileEntries.concat(entries);
        }
        // Ingested entries join the same resident-string store as file-loaded ones, so large
        // payloads stay out-of-line and every reader materializes through the one path.
        this.fileEntries = this.fileEntries.map((entry) => this.residentStore.externalize(entry));
        this._buildIndex();
        this.mutationCount++;
    }
    _buildIndex() {
        this.byId.clear();
        this.entryOrdersById.clear();
        this.messageEntryPositions = new WeakMap();
        this.labelsById.clear();
        this.labelTimestampsById.clear();
        this.leafId = null;
        this.sessionNameCache = undefined;
        this.usageTotals = {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            cost: 0,
            latestCacheHitRate: undefined,
        };
        let fullEntryCount = 0;
        for (const [order, entry] of this.fileEntries.entries()) {
            if (entry.type === "session")
                continue;
            fullEntryCount++;
            this.byId.set(entry.id, entry);
            this.entryOrdersById.set(entry.id, order);
            this.leafId = entry.id;
            this._accumulateUsage(entry);
            if (entry.type === "session_info") {
                // Empty names explicitly clear the session title.
                this.sessionNameCache = entry.name?.trim() || undefined;
            }
            if (entry.type === "label") {
                if (entry.label) {
                    this.labelsById.set(entry.targetId, entry.label);
                    this.labelTimestampsById.set(entry.targetId, entry.timestamp);
                }
                else {
                    this.labelsById.delete(entry.targetId);
                    this.labelTimestampsById.delete(entry.targetId);
                }
            }
        }
        // A trimmed mirror cannot replace the full-history count.
        if (!this.mirrorTrimmed) {
            this.fullEntryCount = fullEntryCount;
        }
    }
    _rewriteFile() {
        if (!this.persist || !this.sessionFile)
            return;
        reserveSessionWrite(this.sessionFile);
        replaceFileAtomically(this.sessionFile, this._serializedFileEntries());
    }
    *_serializedFileEntries() {
        for (const entry of this.fileEntries) {
            yield `${JSON.stringify(this.residentStore.materialize(entry))}\n`;
        }
    }
    isPersisted() {
        return this.persist;
    }
    getCwd() {
        return this.cwd;
    }
    getSessionDir() {
        return this.sessionDir;
    }
    usesDefaultSessionDir() {
        return this.sessionDir === getDefaultSessionDirPath(this.cwd);
    }
    getSessionId() {
        return this.sessionId;
    }
    getSessionFile() {
        return this.sessionFile;
    }
    /**
     * Exposes the resident store for out-of-band string lifecycles such as the
     * agent's runtime message state (tokenized while idle, hydrated per turn).
     */
    getResidentStore() {
        return this.residentStore;
    }
    getResidentStoreStats() {
        return this.residentStore.stats();
    }
    /**
     * Writes the buffered header (and anything buffered behind it) through an exclusive create, as
     * the first assistant message would, and appends every later entry immediately. A session that
     * is exposed to other processes needs its id on disk first: a reopen of a missing file mints a
     * new id. The write is asynchronous (the session path never blocks on the filesystem); entries
     * persisted while it runs are appended by it before the transcript counts as flushed.
     */
    persistHeaderNow() {
        if (!this.persist || !this.sessionFile || this.flushed)
            return this.headerWrite ?? Promise.resolve();
        const sessionFile = this.sessionFile;
        this.headerWrite ??= this._writeHeaderAsync(sessionFile).finally(() => {
            this.headerWrite = undefined;
        });
        return this.headerWrite;
    }
    isTranscriptFlushed() {
        return this.flushed;
    }
    /**
     * Removes the session file when nothing happened in it - the header plus model/thinking setup
     * entries only - and returns to buffering, so a later entry cannot recreate a header-less file.
     */
    async discardHeaderOnlyFile() {
        await this.headerWrite;
        if (!this.persist || !this.sessionFile || !this.flushed)
            return false;
        if (!this.fileEntries.every((entry) => SETUP_ONLY_ENTRY_TYPES.has(entry.type)))
            return false;
        await rm(this.sessionFile, { force: true });
        this.flushed = false;
        return true;
    }
    async _writeHeaderAsync(sessionFile) {
        reserveSessionWrite(sessionFile);
        const entries = this.fileEntries;
        const serialize = (batch) => batch.map((e) => `${JSON.stringify(this.residentStore.materialize(e))}\n`).join("");
        let written = 0;
        let handle = await open(sessionFile, "wx");
        try {
            while (written < entries.length) {
                const batch = entries.slice(written);
                written += batch.length;
                await handle.writeFile(serialize(batch));
            }
            const closing = handle;
            handle = undefined;
            await closing.close();
            // Entries persisted while the handle closed: append until a pass finds nothing new.
            while (written < entries.length && this.sessionFile === sessionFile && this.fileEntries === entries) {
                const batch = entries.slice(written);
                written += batch.length;
                await appendFile(sessionFile, serialize(batch));
            }
        }
        catch (error) {
            // This write created the file: a part-written one would fail every later first flush with
            // EEXIST while the entries it was carrying stayed in memory only. Nothing counts as flushed yet.
            return discardFailedFirstFlushAsync(sessionFile, handle, error);
        }
        // Synchronous with the last check above: no entry can land between it and the flag.
        if (this.sessionFile === sessionFile && this.fileEntries === entries && written === entries.length) {
            this.flushed = true;
        }
    }
    /**
     * A new session file is created only once the session contains a user or assistant message.
     * Setup entries alone (model, thinking level, system prompt) stay in memory so opening and
     * closing the agent without chatting leaves no file behind. Starting at the user message (not the
     * first assistant reply) keeps the prompt on disk if the first turn never completes (#10000).
     * An explicit persistHeaderNow() still writes the header first: a session exposed to other
     * processes needs its id on disk before any conversation.
     */
    _hasConversation() {
        return this.fileEntries.some(isConversationEntry);
    }
    /**
     * Writes `entry`, which is not in `fileEntries` yet, before memory commits it. A throw means the
     * file did not take the entry, so the caller commits nothing and no later entry can chain onto it.
     */
    _persist(entry) {
        if (!this.persist || !this.sessionFile)
            return;
        reserveSessionWrite(this.sessionFile);
        const persistedEntry = this.residentStore.materialize(entry);
        if (this.flushed) {
            if (this.tailMayBeTorn) {
                truncateToLastCompleteLine(this.sessionFile);
                this.tailMayBeTorn = false;
            }
            try {
                appendFileSync(this.sessionFile, `${JSON.stringify(persistedEntry)}\n`);
            }
            catch (error) {
                this.tailMayBeTorn = true;
                throw error;
            }
            return;
        }
        // Entries stay in memory only until the branch holds a user or assistant message; then all are
        // written (#10000: the prompt reaches disk even if the first turn never completes).
        if (!isConversationEntry(entry) && !this._hasConversation())
            return;
        // An asynchronous header write owns the file until it finishes, and appends this entry.
        if (this.headerWrite)
            return;
        const fd = openSync(this.sessionFile, "wx");
        try {
            for (const e of [...this.fileEntries, entry]) {
                writeFileSync(fd, `${JSON.stringify(this.residentStore.materialize(e))}\n`);
            }
        }
        catch (error) {
            discardFailedFirstFlush(this.sessionFile, fd, error);
        }
        closeSync(fd);
        this.flushed = true;
    }
    _appendEntry(entry) {
        const residentEntry = this.residentStore.externalize(entry);
        this._persist(residentEntry);
        this._commitEntry(residentEntry);
    }
    _commitEntry(residentEntry) {
        this.fileEntries.push(residentEntry);
        this.byId.set(residentEntry.id, residentEntry);
        this.entryOrdersById.set(residentEntry.id, this.fileEntries.length - 1);
        this.leafId = residentEntry.id;
        this.fullEntryCount++;
        this._accumulateUsage(residentEntry);
        this.mutationCount++;
    }
    /**
     * Append an already-materialized entry without rewriting its identity or tree
     * fields. This is the transport seam for entries captured by another manager.
     */
    appendEntry(entry) {
        this._appendEntry(entry);
        const order = this.entryOrdersById.get(entry.id);
        if (entry.type === "message" && order !== undefined) {
            this.messageEntryPositions.set(entry.message, { entryId: entry.id, order });
        }
        if (entry.type === "session_info")
            this.sessionNameCache = entry.name?.trim() || undefined;
        if (entry.type === "label") {
            if (entry.label) {
                this.labelsById.set(entry.targetId, entry.label);
                this.labelTimestampsById.set(entry.targetId, entry.timestamp);
            }
            else {
                this.labelsById.delete(entry.targetId);
                this.labelTimestampsById.delete(entry.targetId);
            }
        }
    }
    _materializeEntry(entry) {
        let missingResidentString = false;
        const materialized = this.residentStore.materialize(entry, () => {
            missingResidentString = true;
            return undefined;
        });
        // The resident store is a bounded cache. The JSONL remains authoritative
        // when an evicted blob is needed by a branch or read operation.
        if (missingResidentString && this.sessionFile) {
            const persisted = loadEntriesFromFile(this.sessionFile).find((candidate) => candidate.id === entry.id);
            if (persisted)
                return persisted;
        }
        if (materialized.type === "message") {
            const order = this.entryOrdersById.get(materialized.id);
            if (order !== undefined) {
                this.messageEntryPositions.set(materialized.message, { entryId: materialized.id, order });
            }
        }
        return materialized;
    }
    /**
     * Fold one entry into the running usage totals. Totals iterate ALL entries
     * (not branch-scoped), matching the footer hot path's historical semantics.
     */
    _accumulateUsage(entry) {
        if (entry.type !== "message" || entry.message.role !== "assistant")
            return;
        const usage = entry.message.usage;
        // Assistant messages persisted without usage (e.g. aborted/error turns in
        // older session files) contribute nothing to the running totals.
        if (!usage)
            return;
        this.usageTotals.input += usage.input;
        this.usageTotals.output += usage.output;
        this.usageTotals.cacheRead += usage.cacheRead;
        this.usageTotals.cacheWrite += usage.cacheWrite;
        this.usageTotals.cost += usage.cost?.total ?? 0;
        const latestPromptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
        this.usageTotals.latestCacheHitRate =
            latestPromptTokens > 0 ? (usage.cacheRead / latestPromptTokens) * 100 : undefined;
    }
    /**
     * O(1) running usage totals across ALL session entries (not branch-scoped).
     * Maintained incrementally; identical to summing usage over getEntries().
     */
    getUsageTotals() {
        return this.usageTotals;
    }
    /** Append a message as child of current leaf, then advance leaf. Returns entry id.
     * Does not allow writing CompactionSummaryMessage and BranchSummaryMessage directly.
     * Reason: we want these to be top-level entries in the session, not message session entries,
     * so it is easier to find them.
     * These need to be appended via appendCompaction() and appendBranchSummary() methods.
     */
    appendMessage(message) {
        const entry = {
            type: "message",
            id: generateId(this.byId),
            parentId: this.leafId,
            timestamp: new Date().toISOString(),
            message,
        };
        this._appendEntry(entry);
        const order = this.entryOrdersById.get(entry.id);
        if (order !== undefined) {
            this.messageEntryPositions.set(message, { entryId: entry.id, order });
        }
        return entry.id;
    }
    /** Runtime append position for this exact persisted message object, if known. */
    getMessageEntryPosition(message) {
        return this.messageEntryPositions.get(message);
    }
    /** Runtime/file append position for an entry, used with getMessageEntryPosition(). */
    getEntryOrder(entryId) {
        return this.entryOrdersById.get(entryId);
    }
    /** Append a thinking level change as child of current leaf, then advance leaf. Returns entry id. */
    appendThinkingLevelChange(thinkingLevel, thinkingSelection) {
        const entry = {
            type: "thinking_level_change",
            id: generateId(this.byId),
            parentId: this.leafId,
            timestamp: new Date().toISOString(),
            thinkingLevel,
            thinkingSelection,
        };
        this._appendEntry(entry);
        return entry.id;
    }
    /** Append a durable Responses configuration update as child of current leaf. */
    appendConfigurationUpdate(effort) {
        const entry = {
            type: "configuration_update",
            id: generateId(this.byId),
            parentId: this.leafId,
            timestamp: new Date().toISOString(),
            reasoning: { effort },
        };
        this._appendEntry(entry);
        return entry.id;
    }
    /**
     * Append a refused model switch (#1526). The refusal happens before any
     * `model_change` is written, so without this the attempt leaves no trace.
     */
    appendModelChangeRejected(details) {
        const entry = {
            type: "model_change_rejected",
            id: generateId(this.byId),
            parentId: this.leafId,
            timestamp: new Date().toISOString(),
            ...details,
        };
        this._appendEntry(entry);
        return entry.id;
    }
    /** Append a model change as child of current leaf, then advance leaf. Returns entry id. */
    appendModelChange(provider, modelId, reason, originalProvider, originalModelId) {
        const entry = {
            type: "model_change",
            id: generateId(this.byId),
            parentId: this.leafId,
            timestamp: new Date().toISOString(),
            provider,
            modelId,
            reason,
            originalProvider,
            originalModelId,
        };
        this._appendEntry(entry);
        return entry.id;
    }
    /** Append model-attributed usage that does not participate in LLM context. Returns the appended entry. */
    appendUsage(kind, provider, model, usage, note) {
        const entry = {
            type: "usage",
            id: generateId(this.byId),
            parentId: this.leafId,
            timestamp: new Date().toISOString(),
            kind,
            provider,
            model,
            usage,
            ...(note ? { note } : {}),
        };
        this._appendEntry(entry);
        return entry;
    }
    /** Append a compaction summary as child of current leaf, then advance leaf. Returns entry id. */
    appendCompaction(summary, firstKeptEntryId, tokensBefore, details, fromHook, usage) {
        const timestamp = new Date().toISOString();
        const systemMessage = getCurrentSystemMessage(this.buildSessionProjection().messages);
        const id = generateId(this.byId);
        const entry = {
            type: "compaction",
            id,
            parentId: this.leafId,
            timestamp,
            summary,
            firstKeptEntryId: firstKeptEntryId ?? id,
            tokensBefore,
            details,
            usage,
            fromHook,
            ...(systemMessage ? { systemMessage: { ...systemMessage, timestamp: new Date(timestamp).getTime() } } : {}),
        };
        this._appendEntry(entry);
        this._trimMirrorAfterCompaction(entry);
        return entry.id;
    }
    /**
     * Release what outlives this manager in the process: the shared host's write
     * grant and the blob directory backing its resident mirror. The session JSONL
     * is untouched - it is the authority the next reader loads from. Idempotent.
     */
    dispose() {
        unregisterSessionWriter(this);
        this._releaseBlobsDirUnlessShared();
    }
    /**
     * The blob directory is keyed by session id, so every live manager over the same
     * session file hydrates from it. Removing it while one of them is still reading
     * would cost that manager a full JSONL recovery per evicted string, so the last
     * owner to let go is the one that clears it.
     */
    _releaseBlobsDirUnlessShared() {
        const blobsDir = this.residentStore.resolvedBlobsDir();
        if (!blobsDir)
            return;
        if (this.sessionFile && hasOtherLiveSessionWriter(this.sessionFile, this))
            return;
        this._removeBlobsDir(blobsDir);
    }
    _removeBlobsDir(dir) {
        try {
            rmSync(dir, { force: true, recursive: true });
        }
        catch { }
    }
    _trimMirrorAfterCompaction(compaction) {
        if (!this.persist)
            return;
        const firstKeptIndex = this.fileEntries.findIndex((entry) => entry.id === compaction.firstKeptEntryId);
        const compactionIndex = this.fileEntries.findIndex((entry) => entry.id === compaction.id);
        if (firstKeptIndex < 0 || compactionIndex < firstKeptIndex)
            return;
        const header = this.fileEntries.find((entry) => entry.type === "session");
        const retained = [
            ...this.fileEntries.slice(0, firstKeptIndex).filter((entry) => entry.type !== "message"),
            ...this.fileEntries.slice(firstKeptIndex, compactionIndex + 1),
        ];
        let parentId = null;
        for (const entry of retained) {
            if (entry.type !== "session")
                entry.parentId = parentId;
            parentId = entry.type === "session" ? null : entry.id;
        }
        this.residentStore.spillResident();
        this.mirrorTrimmed = true;
        this.fileEntries = [header, ...retained]
            .filter((entry) => entry !== undefined)
            .map((entry) => this.residentStore.externalize(entry));
        this._buildIndex();
        this.mutationCount++;
    }
    /** Append a custom entry (for extensions) as child of current leaf, then advance leaf. */
    appendCustomEntry(customType, data) {
        const entry = {
            type: "custom",
            customType,
            data,
            id: generateId(this.byId),
            parentId: this.leafId,
            timestamp: new Date().toISOString(),
        };
        this._appendEntry(entry);
        return entry.id;
    }
    /** Append a session info entry (e.g., display name). Returns entry id. */
    appendSessionInfo(name) {
        const sanitizedName = name.replace(/[\r\n]+/g, " ").trim();
        const entry = {
            type: "session_info",
            id: generateId(this.byId),
            parentId: this.leafId,
            timestamp: new Date().toISOString(),
            name: sanitizedName,
        };
        this._appendEntry(entry);
        this.sessionNameCache = sanitizedName || undefined;
        return entry.id;
    }
    /**
     * Get the current session name from the latest session_info entry, if any.
     * O(1): the value is maintained incrementally on appendSessionInfo() and index rebuilds.
     */
    getSessionName() {
        return this.sessionNameCache;
    }
    /**
     * Append a custom message entry (for extensions) that participates in LLM context.
     * @param customType Extension identifier for filtering on reload
     * @param content Message content (string or TextContent/ImageContent array)
     * @param display Whether to show in TUI (true = styled display, false = hidden)
     * @param details Optional extension-specific metadata (not sent to LLM)
     * @returns Entry id
     */
    appendCustomMessageEntry(customType, content, display, details) {
        const entry = {
            type: "custom_message",
            customType,
            content,
            display,
            details,
            id: generateId(this.byId),
            parentId: this.leafId,
            timestamp: new Date().toISOString(),
        };
        this._appendEntry(entry);
        return entry.id;
    }
    /** Append a branch-local edit to an earlier model-visible entry. */
    appendContextEdit(targetId, replacement) {
        if (replacement !== null &&
            (typeof replacement !== "object" ||
                !("content" in replacement) ||
                (typeof replacement.content !== "string" && !Array.isArray(replacement.content)))) {
            throw new Error("Context edit replacement must be null or contain string/array content");
        }
        const target = this.byId.get(targetId);
        if (!target)
            throw new Error(`Entry ${targetId} not found`);
        if (!this.getBranch().some((entry) => entry.id === targetId)) {
            throw new Error(`Entry ${targetId} is not on the active branch`);
        }
        const editable = target.type === "custom_message" ||
            (target.type === "message" &&
                (target.message.role === "user" ||
                    target.message.role === "assistant" ||
                    target.message.role === "toolResult"));
        if (!editable)
            throw new Error(`Entry ${targetId} does not contribute editable model content`);
        const targetRole = target.type === "message" ? target.message.role : "custom";
        const normalizedReplacement = replacement !== null &&
            (targetRole === "assistant" || targetRole === "toolResult") &&
            typeof replacement.content === "string"
            ? { content: [{ type: "text", text: replacement.content }] }
            : replacement;
        const entry = {
            type: "context_edit",
            id: generateId(this.byId),
            parentId: this.leafId,
            timestamp: new Date().toISOString(),
            targetId,
            replacement: normalizedReplacement,
        };
        this._appendEntry(entry);
        return entry.id;
    }
    // =========================================================================
    // Tree Traversal
    // =========================================================================
    getLeafId() {
        return this.leafId;
    }
    getLeafEntry() {
        const entry = this.leafId ? this.byId.get(this.leafId) : undefined;
        return entry ? this._materializeEntry(entry) : undefined;
    }
    getEntry(id) {
        const entry = this.byId.get(id);
        if (entry)
            return this._materializeEntry(entry);
        if (this.mirrorTrimmed && this.sessionFile) {
            const persisted = this._loadFullHistoryEntries().find((candidate) => candidate.id === id);
            return persisted ? this.residentStore.materialize(persisted) : undefined;
        }
        return undefined;
    }
    /**
     * Get all direct children of an entry.
     */
    getChildren(parentId) {
        const children = [];
        for (const entry of this.byId.values()) {
            if (entry.parentId === parentId) {
                children.push(this._materializeEntry(entry));
            }
        }
        return children;
    }
    /**
     * Get the label for an entry, if any.
     */
    getLabel(id) {
        return this.labelsById.get(id);
    }
    /**
     * Set or clear a label on an entry.
     * Labels are user-defined markers for bookmarking/navigation.
     * Pass undefined or empty string to clear the label.
     */
    appendLabelChange(targetId, label) {
        if (!this.byId.has(targetId)) {
            throw new Error(`Entry ${targetId} not found`);
        }
        const entry = {
            type: "label",
            id: generateId(this.byId),
            parentId: this.leafId,
            timestamp: new Date().toISOString(),
            targetId,
            label,
        };
        this._appendEntry(entry);
        if (label) {
            this.labelsById.set(targetId, label);
            this.labelTimestampsById.set(targetId, entry.timestamp);
        }
        else {
            this.labelsById.delete(targetId);
            this.labelTimestampsById.delete(targetId);
        }
        return entry.id;
    }
    /**
     * Walk from entry to root, returning all entries in path order.
     * Includes all entry types (messages, compaction, model changes, etc.).
     * Use buildSessionContext() to get the resolved messages for the LLM.
     */
    getBranch(fromId) {
        // No-arg reads (the common hot path) are memoized on (leafId, mutationCount);
        // explicit fromId lookups bypass the cache.
        if (fromId === undefined &&
            this.branchCache !== null &&
            this.branchCache.leafId === this.leafId &&
            this.branchCache.mutation === this.mutationCount) {
            return this.branchCache.entries;
        }
        const path = [];
        const startId = fromId ?? this.leafId;
        let entriesById = this.byId;
        if (fromId !== undefined && !entriesById.has(fromId) && this.mirrorTrimmed && this.sessionFile) {
            entriesById = new Map(this._loadFullHistoryEntries()
                .filter((entry) => entry.type !== "session")
                .map((entry) => [entry.id, this.residentStore.materialize(entry)]));
        }
        let current = startId ? entriesById.get(startId) : undefined;
        while (current) {
            path.unshift(current);
            current = current.parentId ? entriesById.get(current.parentId) : undefined;
        }
        const materializedPath = this._materializeEntries(path);
        if (fromId === undefined) {
            this.branchCache = { leafId: this.leafId, mutation: this.mutationCount, entries: materializedPath };
        }
        return materializedPath;
    }
    /**
     * Build the active, compaction-aware entry list for context/rendering.
     * Uses tree traversal from current leaf.
     */
    buildContextEntries() {
        return buildContextEntries(this._getCompactEntries(), this.leafId);
    }
    /**
     * Build the canonical session projection (context edits, compaction boundary) from the current
     * leaf. Reads the compact mirror like buildSessionContext(), so a trimmed mirror never reloads
     * the full history.
     */
    buildSessionProjection() {
        return buildSessionProjection(this._getCompactEntries(), this.leafId);
    }
    /**
     * Build the session context (what gets sent to the LLM).
     * Uses tree traversal from current leaf.
     */
    buildSessionContext() {
        return buildSessionContext(this._getCompactEntries(), this.leafId);
    }
    hasContextMessages() {
        return this.hasBranchEntry((entry) => entry.type === "message" ||
            entry.type === "custom_message" ||
            entry.type === "compaction" ||
            (entry.type === "branch_summary" && Boolean(entry.summary)));
    }
    hasThinkingLevelChanges() {
        return this.hasBranchEntry((entry) => entry.type === "thinking_level_change");
    }
    countCompactions() {
        let count = 0;
        for (const entry of this.fileEntries) {
            if (entry.type === "compaction")
                count++;
        }
        return count;
    }
    hasBranchEntry(predicate) {
        let current = this.leafId ? this.byId.get(this.leafId) : undefined;
        while (current) {
            if (predicate(current))
                return true;
            current = current.parentId ? this.byId.get(current.parentId) : undefined;
        }
        return false;
    }
    /**
     * Get session header.
     */
    getHeader() {
        const h = this.fileEntries.find((e) => e.type === "session");
        return h ? this.residentStore.materialize(h) : null;
    }
    /**
     * Get all session entries (excludes header).
     * The session is append-only: use appendXXX() to add entries, branch() to
     * change the leaf pointer. Entries cannot be modified or deleted.
     *
     * The result is memoized behind the session mutation counter: repeated calls
     * without an intervening mutation return the SAME shared array instance.
     * Callers must not mutate the returned array or its entries; copy first if
     * you need to filter/reorder.
     */
    getEntries() {
        if (this.mirrorTrimmed && this.sessionFile) {
            return this._loadFullHistoryEntries()
                .filter((e) => e.type !== "session")
                .map((entry) => this.residentStore.materialize(entry));
        }
        if (this.entriesCache !== null && this.entriesCache.mutation === this.mutationCount) {
            return this.entriesCache.entries;
        }
        const entries = this.fileEntries.filter((e) => e.type !== "session");
        const materializedEntries = this._materializeEntries(entries);
        this.entriesCache = { mutation: this.mutationCount, entries: materializedEntries };
        return materializedEntries;
    }
    /** Returns the maintained non-header entry count without loading or materializing history. */
    getEntryCount() {
        return this.fullEntryCount;
    }
    /**
     * Release the memoized materialized views. Materialized entries hold the full
     * persisted strings, so views kept between turns pin the whole session text
     * in memory even while nothing runs. The next read rebuilds them from the
     * bounded resident store.
     */
    dropMaterializedCaches() {
        this.entriesCache = null;
        this.branchCache = null;
        this.compactEntriesCache = null;
    }
    _materializeEntries(entries) {
        return materializeSessionEntries(entries, {
            residentStore: this.residentStore,
            loadHistoryEntries: () => this._loadFullHistoryEntries(),
            onMaterialized: (entry) => {
                if (entry.type !== "message")
                    return;
                const order = this.entryOrdersById.get(entry.id);
                if (order !== undefined) {
                    this.messageEntryPositions.set(entry.message, { entryId: entry.id, order });
                }
            },
        });
    }
    _getCompactEntries() {
        if (this.compactEntriesCache?.mutation !== this.mutationCount) {
            this.compactEntriesCache = {
                mutation: this.mutationCount,
                entries: this.fileEntries.filter((e) => e.type !== "session"),
            };
        }
        const entries = this.compactEntriesCache.entries;
        const missingEntryIds = new Set();
        for (const entry of entries) {
            this.residentStore.materialize(entry, () => {
                missingEntryIds.add(entry.id);
                return undefined;
            });
        }
        if (missingEntryIds.size > 0 && this.sessionFile) {
            const persistedById = new Map(this._loadFullHistoryEntries().map((entry) => [entry.id, entry]));
            for (let index = 0; index < entries.length; index++) {
                const entry = entries[index];
                if (!missingEntryIds.has(entry.id))
                    continue;
                const persisted = persistedById.get(entry.id);
                if (persisted)
                    entries[index] = this.residentStore.externalize(persisted);
            }
        }
        const materialized = entries.map((entry) => this.residentStore.materialize(entry));
        for (const entry of materialized) {
            if (entry.type !== "message")
                continue;
            const order = this.entryOrdersById.get(entry.id);
            if (order !== undefined)
                this.messageEntryPositions.set(entry.message, { entryId: entry.id, order });
        }
        return materialized;
    }
    _loadFullHistoryEntries() {
        return this.sessionFile ? sessionEntryLoader(this.sessionFile) : this.fileEntries;
    }
    /**
     * Get the session as a tree structure. Returns a shallow defensive copy of all entries.
     * A well-formed session has exactly one root (first entry with parentId === null).
     * Orphaned entries (broken parent chain) are also returned as roots.
     */
    getTree() {
        const entries = this.getEntries();
        const nodeMap = new Map();
        const roots = [];
        // Create nodes with resolved labels
        for (const entry of entries) {
            const label = this.labelsById.get(entry.id);
            const labelTimestamp = this.labelTimestampsById.get(entry.id);
            nodeMap.set(entry.id, { entry, children: [], label, labelTimestamp });
        }
        // Build tree
        for (const entry of entries) {
            const node = nodeMap.get(entry.id);
            if (entry.parentId === null || entry.parentId === entry.id) {
                roots.push(node);
            }
            else {
                const parent = nodeMap.get(entry.parentId);
                if (parent) {
                    parent.children.push(node);
                }
                else {
                    // Orphan - treat as root
                    roots.push(node);
                }
            }
        }
        // Sort children by timestamp (oldest first, newest at bottom)
        // Use iterative approach to avoid stack overflow on deep trees
        const stack = [...roots];
        while (stack.length > 0) {
            const node = stack.pop();
            node.children.sort((a, b) => new Date(a.entry.timestamp).getTime() - new Date(b.entry.timestamp).getTime());
            stack.push(...node.children);
        }
        return roots;
    }
    // =========================================================================
    // Branching
    // =========================================================================
    /**
     * Start a new branch from an earlier entry.
     * Moves the leaf pointer to the specified entry. The next appendXXX() call
     * will create a child of that entry, forming a new branch. Existing entries
     * are not modified or deleted.
     */
    branch(branchFromId) {
        if (!this.byId.has(branchFromId) && this.sessionFile) {
            this.reloadFromDisk();
        }
        if (!this.byId.has(branchFromId)) {
            throw new Error(`Entry ${branchFromId} not found`);
        }
        this.leafId = branchFromId;
        this.mutationCount++;
    }
    /**
     * Reset the leaf pointer to null (before any entries).
     * The next appendXXX() call will create a new root entry (parentId = null).
     * Use this when navigating to re-edit the first user message.
     */
    resetLeaf() {
        this.leafId = null;
        this.mutationCount++;
    }
    /**
     * Start a new branch with a summary of the abandoned path.
     * Same as branch(), but also appends a branch_summary entry that captures
     * context from the abandoned conversation path.
     */
    branchWithSummary(branchFromId, summary, details, fromHook, usage) {
        if (branchFromId !== null && !this.byId.has(branchFromId)) {
            throw new Error(`Entry ${branchFromId} not found`);
        }
        const fromId = this.leafId ?? "root";
        const entry = {
            type: "branch_summary",
            id: generateId(this.byId),
            parentId: branchFromId,
            timestamp: new Date().toISOString(),
            fromId,
            summary,
            details,
            usage,
            fromHook,
        };
        this._appendEntry(entry);
        return entry.id;
    }
    /**
     * Create a new session file containing only the path from root to the specified leaf.
     * Useful for extracting a single conversation path from a branched session.
     * Returns the new session file path, or undefined if not persisting.
     */
    createBranchedSession(leafId) {
        const previousSessionFile = this.sessionFile;
        const path = this.getBranch(leafId);
        if (path.length === 0) {
            throw new Error(`Entry ${leafId} not found`);
        }
        // Filter out LabelEntry from path - we'll recreate them from the resolved map.
        // Because labels are real tree entries, later entries can be children of labels;
        // removing labels requires re-chaining the retained path to avoid orphaned subtrees.
        const pathWithoutLabels = [];
        const replacementByLabelId = new Map();
        const pendingLabelIds = [];
        let pathParentId = null;
        for (const entry of path) {
            if (entry.type === "label") {
                pendingLabelIds.push(entry.id);
                continue;
            }
            for (const labelId of pendingLabelIds) {
                replacementByLabelId.set(labelId, entry.id);
            }
            pendingLabelIds.length = 0;
            pathWithoutLabels.push(entry.type === "compaction"
                ? {
                    ...entry,
                    parentId: pathParentId,
                    firstKeptEntryId: entry.firstKeptEntryId === entry.id
                        ? entry.id
                        : (replacementByLabelId.get(entry.firstKeptEntryId) ?? entry.firstKeptEntryId),
                }
                : { ...entry, parentId: pathParentId });
            pathParentId = entry.id;
        }
        const newSessionId = createSessionId();
        const timestamp = new Date().toISOString();
        const fileTimestamp = timestamp.replace(/[:.]/g, "-");
        const newSessionFile = join(this.getSessionDir(), `${fileTimestamp}_${newSessionId}.jsonl`);
        const header = {
            type: "session",
            version: CURRENT_SESSION_VERSION,
            id: newSessionId,
            timestamp,
            cwd: this.cwd,
            parentSession: this.persist ? previousSessionFile : undefined,
        };
        // Collect labels for entries in the path
        const pathEntryIds = new Set(pathWithoutLabels.map((e) => e.id));
        const labelsToWrite = [];
        for (const [targetId, label] of this.labelsById) {
            if (pathEntryIds.has(targetId)) {
                labelsToWrite.push({ targetId, label, timestamp: this.labelTimestampsById.get(targetId) });
            }
        }
        if (this.persist) {
            // Build label entries
            const lastEntryId = pathWithoutLabels[pathWithoutLabels.length - 1]?.id || null;
            let parentId = lastEntryId;
            const labelEntries = [];
            for (const { targetId, label, timestamp: labelTimestamp } of labelsToWrite) {
                const labelEntry = {
                    type: "label",
                    id: generateId(new Set(pathEntryIds)),
                    parentId,
                    timestamp: labelTimestamp,
                    targetId,
                    label,
                };
                pathEntryIds.add(labelEntry.id);
                labelEntries.push(labelEntry);
                parentId = labelEntry.id;
            }
            reserveSessionWrite(newSessionFile);
            // Materialize the branched entries while the previous backing is still
            // readable, then clear: re-externalizing tokenized entries after clear()
            // would bake sentinel tokens into the new branched JSONL.
            const branchedEntries = this._materializeEntries([...pathWithoutLabels, ...labelEntries]);
            const previousBlobsDir = this.residentStore.resolvedBlobsDir();
            this.residentStore.clear();
            if (previousBlobsDir) {
                this._removeBlobsDir(previousBlobsDir);
            }
            this.mirrorTrimmed = false;
            this.sessionId = newSessionId;
            this.sessionFile = newSessionFile;
            this.fileEntries = [header, ...branchedEntries.map((entry) => this.residentStore.externalize(entry))];
            this._buildIndex();
            this.mutationCount++;
            // Use the same rule as _persist(): write now if the branched path already
            // has a conversation, otherwise let _persist() create the file later.
            if (this._hasConversation()) {
                this._rewriteFile();
                this.flushed = true;
            }
            else {
                this.flushed = false;
            }
            return newSessionFile;
        }
        // In-memory mode: replace current session with the path + labels
        const labelEntries = [];
        let parentId = pathWithoutLabels[pathWithoutLabels.length - 1]?.id || null;
        for (const { targetId, label, timestamp: labelTimestamp } of labelsToWrite) {
            const labelEntry = {
                type: "label",
                id: generateId(new Set([...pathEntryIds, ...labelEntries.map((e) => e.id)])),
                parentId,
                timestamp: labelTimestamp,
                targetId,
                label,
            };
            labelEntries.push(labelEntry);
            parentId = labelEntry.id;
        }
        const branchedEntries = this._materializeEntries([...pathWithoutLabels, ...labelEntries]);
        this.residentStore.clear();
        this.fileEntries = [header, ...branchedEntries.map((entry) => this.residentStore.externalize(entry))];
        this.sessionId = newSessionId;
        this._buildIndex();
        this.mutationCount++;
        return undefined;
    }
    /**
     * Create a new session.
     * @param cwd Working directory (stored in session header)
     * @param sessionDir Optional session directory. If omitted, uses default (~/.senpi/agent/sessions/<encoded-cwd>/).
     */
    static create(cwd, sessionDir, options) {
        const dir = sessionDir ? normalizePath(sessionDir) : getDefaultSessionDir(cwd);
        return new SessionManager(cwd, dir, undefined, true, options);
    }
    /**
     * Open a specific session file.
     * @param path Path to session file
     * @param sessionDir Optional session directory for /new or /branch. If omitted, derives from file's parent.
     * @param cwdOverride Optional cwd override instead of the session header cwd.
     * @param options Applied only when this open CREATES the session (the path does not exist
     * yet, or exists and is empty). An existing session file keeps the id in its header.
     */
    static open(path, sessionDir, cwdOverride, options) {
        const resolvedPath = resolvePath(path);
        reserveSessionWrite(resolvedPath);
        let header = null;
        let preloadedFileEntries;
        if (cwdOverride === undefined && existsSync(resolvedPath)) {
            try {
                header = readSessionHeader(resolvedPath);
            }
            catch (error) {
                if (!(error instanceof SessionHeaderScanLimitError))
                    throw error;
                // The bounded scan is only a discovery optimization. A full load remains
                // authoritative for legacy files with very large headers or prefixes.
                preloadedFileEntries = loadEntriesFromFile(resolvedPath);
                const firstEntry = preloadedFileEntries[0];
                header = firstEntry?.type === "session" ? firstEntry : null;
            }
        }
        // This process opens the session for append; normalize a final unterminated
        // JSONL entry here, never from read-only loadEntriesFromFile callers.
        if (existsSync(resolvedPath)) {
            const content = readFileSync(resolvedPath);
            if (content.length > 0 && content[content.length - 1] !== 10)
                appendFileSync(resolvedPath, "\n");
        }
        const cwd = cwdOverride ?? (header ? getSessionHeaderCwd(header) : undefined) ?? process.cwd();
        // If no sessionDir provided, derive from file's parent directory
        const dir = sessionDir ? normalizePath(sessionDir) : resolve(resolvedPath, "..");
        return new SessionManager(cwd, dir, resolvedPath, true, options, preloadedFileEntries);
    }
    /**
     * Continue the most recent session, or create new if none.
     * @param cwd Working directory
     * @param sessionDir Optional session directory. If omitted, uses default (~/.senpi/agent/sessions/<encoded-cwd>/).
     */
    static continueRecent(cwd, sessionDir) {
        const dir = sessionDir ? normalizePath(sessionDir) : getDefaultSessionDir(cwd);
        const filterCwd = sessionDir !== undefined && dir !== getDefaultSessionDirPath(cwd);
        const mostRecent = findMostRecentSession(dir, filterCwd ? cwd : undefined);
        if (mostRecent) {
            return new SessionManager(cwd, dir, mostRecent, true);
        }
        return new SessionManager(cwd, dir, undefined, true);
    }
    /** Create an in-memory session (no file persistence), optionally from entries held outside the filesystem. */
    static inMemory(cwd = process.cwd(), options, entries) {
        return new SessionManager(cwd, "", undefined, false, options, entries);
    }
    /**
     * Fork a session from another project directory into the current project.
     * Creates a new session in the target cwd with the full history from the source session.
     * @param sourcePath Path to the source session file
     * @param targetCwd Target working directory (where the new session will be stored)
     * @param sessionDir Optional session directory. If omitted, uses default for targetCwd.
     */
    static forkFrom(sourcePath, targetCwd, sessionDir, options) {
        const resolvedSourcePath = resolvePath(sourcePath);
        const resolvedTargetCwd = resolvePath(targetCwd);
        const sourceEntries = loadEntriesFromFile(resolvedSourcePath);
        if (sourceEntries.length === 0) {
            throw new Error(`Cannot fork: source session file is empty or invalid: ${resolvedSourcePath}`);
        }
        const sourceHeader = sourceEntries.find((e) => e.type === "session");
        if (!sourceHeader) {
            throw new Error(`Cannot fork: source session has no header: ${resolvedSourcePath}`);
        }
        const dir = sessionDir ? normalizePath(sessionDir) : getDefaultSessionDir(resolvedTargetCwd);
        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
        }
        // Create new session file with new ID but forked content
        if (options?.id !== undefined) {
            assertValidSessionId(options.id);
        }
        const newSessionId = options?.id ?? createSessionId();
        const timestamp = new Date().toISOString();
        const fileTimestamp = timestamp.replace(/[:.]/g, "-");
        const newSessionFile = join(dir, `${fileTimestamp}_${newSessionId}.jsonl`);
        // Write new header pointing to source as parent, with updated cwd
        const newHeader = {
            type: "session",
            version: CURRENT_SESSION_VERSION,
            id: newSessionId,
            timestamp,
            cwd: resolvedTargetCwd,
            parentSession: resolvedSourcePath,
        };
        reserveSessionWrite(newSessionFile);
        writeFileSync(newSessionFile, `${JSON.stringify(newHeader)}\n`, { flag: "wx" });
        // Copy all non-header entries from source
        for (const entry of sourceEntries) {
            if (entry.type !== "session") {
                appendFileSync(newSessionFile, `${JSON.stringify(entry)}\n`);
            }
        }
        return new SessionManager(resolvedTargetCwd, dir, newSessionFile, true);
    }
    /**
     * Find an exact session ID without loading transcript bodies.
     * @param cwd Working directory (used to compute default session directory)
     * @param id Exact session ID
     * @param sessionDir Optional session directory. If omitted, uses default (~/.pi/agent/sessions/<encoded-cwd>/).
     */
    static findById(cwd, id, sessionDir) {
        const dir = sessionDir ? normalizePath(sessionDir) : getDefaultSessionDir(cwd);
        const filterCwd = sessionDir !== undefined && dir !== getDefaultSessionDirPath(cwd);
        const resolvedCwd = resolvePath(cwd);
        try {
            for (const file of readdirSync(dir)) {
                if (!file.endsWith(".jsonl"))
                    continue;
                const path = join(dir, file);
                const header = readSessionHeaderForDiscovery(path);
                if (header?.id !== id)
                    continue;
                if (filterCwd && !sessionCwdMatches(getSessionHeaderCwd(header), resolvedCwd))
                    continue;
                return path;
            }
        }
        catch {
            // Exact session discovery is best-effort, matching list().
        }
        return undefined;
    }
    /**
     * List all sessions for a directory.
     * @param cwd Working directory (used to compute default session directory)
     * @param sessionDir Optional session directory. If omitted, uses default (~/.senpi/agent/sessions/<encoded-cwd>/).
     * @param onProgress Optional callback for progress updates (loaded, total)
     */
    static async list(cwd, sessionDir, onProgress, signal) {
        const dir = sessionDir ? normalizePath(sessionDir) : getDefaultSessionDir(cwd);
        const filterCwd = sessionDir !== undefined && dir !== getDefaultSessionDirPath(cwd);
        const resolvedCwd = resolvePath(cwd);
        const includeSession = (session) => !filterCwd || sessionCwdMatches(session.cwd, resolvedCwd);
        const progress = onProgress
            ? (loaded, total, partialSessions) => onProgress(loaded, total, partialSessions?.filter(includeSession))
            : undefined;
        const sessions = (await listSessionsFromDir(dir, progress, signal)).filter(includeSession);
        return sortSessionInfos(sessions);
    }
    static async listAll(sessionDirOrOnProgress, onProgressOrSignal, signal) {
        const customSessionDir = typeof sessionDirOrOnProgress === "string" ? normalizePath(sessionDirOrOnProgress) : undefined;
        const progress = typeof sessionDirOrOnProgress === "function"
            ? sessionDirOrOnProgress
            : typeof onProgressOrSignal === "function"
                ? onProgressOrSignal
                : undefined;
        const abortSignal = typeof sessionDirOrOnProgress === "string" || typeof onProgressOrSignal === "function"
            ? signal
            : (onProgressOrSignal ?? signal);
        abortSignal?.throwIfAborted();
        if (customSessionDir) {
            return sortSessionInfos(await listSessionsFromDir(customSessionDir, progress, abortSignal));
        }
        const sessionsDir = getSessionsDir();
        try {
            if (!existsSync(sessionsDir))
                return [];
            const entries = await readdir(sessionsDir, { withFileTypes: true });
            const dirs = entries
                .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
                .map((entry) => join(sessionsDir, entry.name));
            // Count total files first for accurate progress
            let totalFiles = 0;
            const dirFiles = [];
            for (const dir of dirs) {
                try {
                    const files = (await readdir(dir)).filter((f) => f.endsWith(".jsonl"));
                    dirFiles.push(files.map((f) => join(dir, f)));
                    totalFiles += files.length;
                }
                catch {
                    dirFiles.push([]);
                }
            }
            // Process each directory through its own summary index, with progress over all files
            let loaded = 0;
            const partialSessions = [];
            const onLoaded = (info) => {
                loaded++;
                if (info)
                    partialSessions.push(info);
                const publish = loaded === 1 || loaded % ALL_SESSION_LIST_PUBLISH_INTERVAL === 0 || loaded === totalFiles;
                progress?.(loaded, totalFiles, publish ? sortSessionInfos([...partialSessions]) : undefined);
            };
            const sessions = [];
            for (const [index, dir] of dirs.entries()) {
                sessions.push(...(await listSessionFilesInDir(dir, dirFiles[index] ?? [], onLoaded, abortSignal)));
            }
            return sortSessionInfos(sessions);
        }
        catch {
            abortSignal?.throwIfAborted();
            return [];
        }
    }
}
//# sourceMappingURL=session-manager.js.map
