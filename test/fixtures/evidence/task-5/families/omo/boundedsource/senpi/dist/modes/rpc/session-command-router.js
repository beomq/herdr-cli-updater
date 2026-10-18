import { VERSION } from "../../config.js";
import { ACCEPT_EDITS_PERMISSION_PRESET_CAPABILITY } from "../../core/extensions/builtin/permission-system/config.js";
import { buildRpcSessionState } from "./connection-handler.js";
import { AUTO_TITLE_PER_SESSION_CAPABILITY, AUTO_TITLE_SESSIONS_CAPABILITY, DURABLE_SESSION_ID_CAPABILITY, MEDIA_PLACEHOLDERS_CAPABILITY, PROMPT_SURFACE_CAPABILITY, PROMPT_SURFACE_CHAT_CAPABILITY, RETAIN_ON_DISCONNECT_CAPABILITY, SESSION_CONTEXT_CAPABILITY, SESSION_KIND_CAPABILITY, WARM_CAPABILITY, } from "./custom-capability.js";
import { answerWarm } from "./host-warm.js";
import { protocolIdentity } from "./protocol-identity.js";
import { sessionAutoTitleError, sessionContextError, sessionKindError, sessionPromptSurfaceError, } from "./rpc-input-validation.js";
import { RPC_ERROR_INVALID_LAUNCH_PROFILE, RPC_ERROR_INVALID_SESSION_CONTEXT, RPC_ERROR_INVALID_SESSION_KIND, RPC_ERROR_MISSING_SESSION_ID, RPC_ERROR_OPEN_FAILED, RPC_ERROR_SESSION_CLOSING, RPC_ERROR_UNKNOWN_SESSION, } from "./rpc-types.js";
import { runWithSessionAttribution } from "./session-attribution.js";
import { createRpcSessionBinding } from "./session-binding.js";
import { readDrainVerdicts } from "./session-drain.js";
import { RpcSessionRegistryError } from "./session-registry.js";
import { releaseSession } from "./session-release.js";
import { selectSweepEvictions } from "./session-sweep.js";
/** How often a draining host re-checks whether the work it is waiting for has settled. */
const DRAIN_SWEEP_MS = 50;
function error(id, command, code, data) {
    // `errorData` carries what a client has to ACT on (who holds a path, when to retry); the
    // stable code stays the string every existing client already switches on.
    return {
        id,
        type: "response",
        command,
        success: false,
        error: code,
        ...(data && { errorCode: code, errorData: data }),
    };
}
/** Routes control messages and enforces a routing handle for every session command. */
export class SessionCommandRouter {
    constructor(registry, writer, defaults, createBinding = createRpcSessionBinding, connectionOptions = {}, idle) {
        this.bindings = new Map();
        /** Session handles opened by each connection, with one count per attachment. */
        this.sessionsByConnection = new Map();
        /** Opens currently awaiting runtime/binding setup, keyed by connection. */
        this.opensByConnection = new Map();
        /** Connections whose socket has already been detached. */
        this.releasedConnections = new Set();
        this.pendingCapabilities = new Map();
        this.finalizations = new Map();
        this.draining = false;
        this.handoffParks = 0;
        this.drainExitRequested = false;
        this.handoffClosed = new Set();
        this.activeRequests = new Map();
        /** Called after any request for that session settles; a release waits here for the others to finish. */
        this.requestSettledListeners = new Map();
        /** Halves the idle window while the host reports memory pressure; never refuses work. */
        this.memoryPressure = false;
        this.registry = registry;
        this.writer = writer;
        this.defaults = defaults;
        this.createBinding = createBinding;
        this.connectionOptions = connectionOptions;
        this.idleNow = idle?.now ?? Date.now;
        this.idleEvictionMs = idle?.idleEvictionMs ?? Number.POSITIVE_INFINITY;
        this.emptyExitMs = idle?.emptyExitMs ?? Number.POSITIVE_INFINITY;
        this.onEmptyExit = idle?.onEmptyExit;
        this.onHandoffParked = idle?.onHandoffParked;
        this.canExitWhenEmpty = idle?.canExitWhenEmpty;
        if (Number.isFinite(this.idleEvictionMs) || Number.isFinite(this.emptyExitMs)) {
            // Unref'd: occupancy hygiene must never be the reason the event loop stays open.
            const tickMs = Math.max(20, Math.min(5_000, Math.min(this.idleEvictionMs, this.emptyExitMs) / 4));
            this.sweepTimer = setInterval(() => this.sweepIdleSessions(), tickMs);
            this.sweepTimer.unref?.();
        }
    }
    /** Live sessions the host holds, including ones opening or closing. */
    get sessionCount() {
        return this.registry.size;
    }
    /**
     * Park attached and detached sessions once turns and requests settle. Durable wake sources
     * resume on reopen, unlike active work. Repeated requests (including grace expiry) rescan
     * without announcing again or aborting a turn.
     */
    beginDrain() {
        this.draining = true;
        this.stopSweep();
        // Armed BEFORE the first pass, so a pass that fails is retried instead of ending the drain
        // (senpi#2285). Unref'd: a draining host must never be the reason the event loop stays open.
        if (this.drainTimer === undefined && !this.drainExitRequested) {
            this.drainTimer = setInterval(() => this.sweepDrain(), DRAIN_SWEEP_MS);
            this.drainTimer.unref?.();
        }
        this.sweepDrain();
    }
    /** One drain pass: park what has settled, and exit once the host holds nothing. */
    sweepDrain() {
        // An accepted open can still be constructing a runtime or binding.
        if (this.activeRequests.has(undefined))
            return;
        // A pass that failed as a whole is retried by the drain timer armed before it (senpi#2285).
        const verdicts = readDrainVerdicts(this.registry, (sessionId) => this.activeRequests.has(sessionId));
        if (!verdicts)
            return;
        for (const sessionId of verdicts.gone)
            this.parkForHandoff(sessionId, "session_dir_removed");
        for (const sessionId of verdicts.park)
            this.parkForHandoff(sessionId, "handoff_parked");
        if (this.registry.size > 0 || this.handoffParks > 0 || this.finalizations.size > 0)
            return;
        if (this.drainTimer !== undefined) {
            clearInterval(this.drainTimer);
            this.drainTimer = undefined;
        }
        this.stopSweep();
        if (this.drainExitRequested)
            return;
        this.drainExitRequested = true;
        this.onEmptyExit?.();
    }
    parkForHandoff(sessionId, reason) {
        this.handoffClosed.add(sessionId);
        this.handoffParks++;
        void this.evictIdleSession(sessionId, reason)
            .catch((cause) => {
            process.stderr.write(`senpi rpc handoff park ${sessionId} failed: ${String(cause)}\n`);
        })
            .finally(() => {
            this.handoffParks--;
            this.sweepDrain();
        });
    }
    /**
     * Raised by the host's memory sampler. Under pressure idle sessions are parked at
     * HALF the configured window, which returns their memory to the process sooner.
     * Deliberately the only lever: the host never refuses or kills a session for memory.
     */
    setMemoryPressure(pressure) {
        this.memoryPressure = pressure;
    }
    /**
     * Every routed command runs inside its session's attribution scope, so a stall the
     * loop-lag watchdog observes right after this dispatch can name the session that
     * caused it - and anything the command starts inherits the attribution.
     */
    handle(command) {
        const sessionId = "sessionId" in command ? command.sessionId : undefined;
        // A parked handle is answered by its terminal record and connection close, never unknown_session.
        if (this.draining && sessionId !== undefined && this.handoffClosed.has(sessionId))
            return Promise.resolve(undefined);
        if (this.draining && command.type === "open_session")
            return Promise.resolve(error(command.id, command.type, "host_draining"));
        // A warm holds no session and no path, so it stays out of the accounting a drain waits on (senpi#2314).
        if (command.type === "warm")
            return answerWarm(command, {
                draining: this.draining,
                warm: this.registry.warm,
                cwd: this.defaults.cwd,
                hostContext: this.defaults.hostContext,
            });
        this.activeRequests.set(sessionId, (this.activeRequests.get(sessionId) ?? 0) + 1);
        return runWithSessionAttribution({ sessionId }, () => this.dispatch(command)).finally(() => {
            const remaining = (this.activeRequests.get(sessionId) ?? 1) - 1;
            if (remaining > 0)
                this.activeRequests.set(sessionId, remaining);
            else
                this.activeRequests.delete(sessionId);
            if (sessionId !== undefined)
                for (const listener of this.requestSettledListeners.get(sessionId) ?? [])
                    listener();
            if (this.draining)
                this.sweepDrain();
        });
    }
    async dispatch(command) {
        if (command.type === "get_protocol_info") {
            const capabilities = new Set([
                "multi_session",
                AUTO_TITLE_SESSIONS_CAPABILITY,
                MEDIA_PLACEHOLDERS_CAPABILITY,
                // Host capabilities, not client opt-ins: only a multi-session host owns the
                // attachment refcount `open_session.retain_on_disconnect` detaches from, the
                // per-session launch profile `context`/`auto_title` travel on, and the session
                // listing `kind` filters.
                RETAIN_ON_DISCONNECT_CAPABILITY,
                SESSION_CONTEXT_CAPABILITY,
                SESSION_KIND_CAPABILITY,
                AUTO_TITLE_PER_SESSION_CAPABILITY,
                // Only a multi-session host can refuse a duplicate durable id, because only it
                // sees every live session's identity.
                DURABLE_SESSION_ID_CAPABILITY,
                // Every session's prompt is built from its own launch profile, so one host serves both surfaces.
                PROMPT_SURFACE_CAPABILITY,
                PROMPT_SURFACE_CHAT_CAPABILITY,
                ACCEPT_EDITS_PERMISSION_PRESET_CAPABILITY,
                // Only an in-process runtime shares the loop a warm loads into (senpi#2314).
                ...(this.registry.warm ? [WARM_CAPABILITY] : []),
                ...(this.connectionOptions?.capabilities ?? []),
            ]);
            return {
                id: command.id,
                type: "response",
                command: "get_protocol_info",
                success: true,
                data: {
                    protocolVersion: 1,
                    serverVersion: VERSION,
                    capabilities: [...capabilities],
                    mode: "multi",
                    ...protocolIdentity(),
                    memory_pressure: this.memoryPressure,
                },
            };
        }
        if (command.type === "list_sessions") {
            // Worker sessions are machine-driven work: a client sees them only by asking, and
            // the opaque context blob travels only on that listing, never to every connection.
            const rows = this.registry.list();
            const sessions = command.include_workers === true
                ? rows
                : rows.filter((row) => row.kind !== "worker").map(({ context: _context, ...row }) => row);
            return {
                id: command.id,
                type: "response",
                command: "list_sessions",
                success: true,
                data: { sessions },
            };
        }
        if (command.type === "open_session")
            return this.openWithBarrier(command);
        if (command.type === "close_session")
            return this.close(command);
        if (command.type === "release_session")
            return releaseSession({
                draining: () => this.draining,
                hostInstance: this.defaults.hostContext?.host_instance,
                lookup: (sessionId) => this.registry.getForCommand(sessionId, "release_session"),
                code: (cause) => this.code(cause),
                // The release is itself one of the session's in-flight requests.
                otherRequests: (sessionId) => Math.max(0, (this.activeRequests.get(sessionId) ?? 1) - 1),
                otherRequestsSettled: (sessionId) => this.otherRequestsSettled(sessionId),
                pendingPrompts: (sessionId) => this.bindings.get(sessionId)?.pendingPrompts?.() ?? [],
                tearDown: (sessionId, sessionPath) => this.tearDownReleased(sessionId, sessionPath),
            }, command);
        if (command.type === "set_client_info" && !command.sessionId) {
            const connection = this.writer.currentConnection();
            if (connection !== undefined) {
                this.pendingCapabilities.set(connection, command.capabilities ?? []);
                this.writer.setConnectionCapabilities(connection, command.capabilities ?? []);
            }
            return { id: command.id, type: "response", command: "set_client_info", success: true };
        }
        if (!command.sessionId)
            return error(command.id, command.type, RPC_ERROR_MISSING_SESSION_ID);
        try {
            this.registry.getForCommand(command.sessionId, command.type);
            const binding = this.bindings.get(command.sessionId);
            if (!binding)
                return error(command.id, command.type, RPC_ERROR_UNKNOWN_SESSION);
            await binding.handle(command);
            return undefined;
        }
        catch (cause) {
            return error(command.id, command.type, this.code(cause));
        }
    }
    async dispose() {
        this.drainExitRequested = true;
        this.stopSweep();
        if (this.drainTimer !== undefined)
            clearInterval(this.drainTimer);
        await Promise.all([...this.bindings.entries()].map(async ([sessionId, binding]) => {
            const claim = this.tryClaimClose(sessionId, { drainAttachments: true });
            if (!claim)
                return;
            if (claim.finalizer) {
                await this.finalizeClose(sessionId, binding, () => this.writer.closeSession(sessionId, { type: "response", command: "close_session", success: true, data: {} }, "host_shutdown"));
            }
            else
                await this.finalizations.get(sessionId)?.promise;
            this.writer.forgetSession(sessionId);
        }));
        this.bindings.clear();
    }
    /**
     * One occupancy sweep. Evicts what `selectSweepEvictions` decides: open sessions idle
     * longer than idleEvictionMs, and unattached sessions whose transcript directory is
     * gone. While the host reports memory pressure the window is HALVED, so an
     * idle session's memory returns to the process sooner. Fires onEmptyExit once the
     * registry has STAYED empty for emptyExitMs with the exit permitted; any live session
     * or connected client resets that window. Runs on an unref'd interval and is safe to
     * call directly.
     */
    sweepIdleSessions() {
        const now = this.idleNow();
        const idleEvictionMs = this.memoryPressure ? this.idleEvictionMs / 2 : this.idleEvictionMs;
        const verdicts = selectSweepEvictions(this.registry, now, idleEvictionMs);
        for (const sessionId of verdicts.orphaned)
            void this.evictIdleSession(sessionId, "session_dir_removed");
        for (const sessionId of verdicts.idle)
            void this.evictIdleSession(sessionId);
        if (Number.isFinite(this.emptyExitMs)) {
            if (this.registry.size === 0 && (this.canExitWhenEmpty?.() ?? true)) {
                if (this.emptySince === undefined)
                    this.emptySince = now;
                else if (now - this.emptySince >= this.emptyExitMs) {
                    this.stopSweep();
                    this.onEmptyExit?.();
                }
            }
            else {
                this.emptySince = undefined;
            }
        }
    }
    /**
     * Idle-session eviction: the same refcounted close sequence as an explicit
     * close_session, draining every attachment because eviction ends the shared
     * session, not one client's claim. Races with concurrent lifecycle paths are
     * tolerated the same way releaseOwnedSession tolerates them.
     *
     * Evicting a RETAINED session is a PARK, not a close: that session was opened to
     * outlive its clients, so the terminal record names the file it reopens by
     * (`session_parked`) instead of reporting a close nobody requested. The teardown
     * itself is identical - retention never outlives the idle window.
     */
    async evictIdleSession(sessionId, reason) {
        // Read before the claim: the entry is gone once the teardown completes, and a park
        // record without the session's path would not be actionable (so a retained session
        // with no file to reopen by ends as an ordinary close).
        const retained = this.registry.peek(sessionId);
        const parkedPath = retained?.retainOnDisconnect === true || reason === "handoff_parked" ? retained?.sessionPath : undefined;
        // A drain releases every session's connections the same way, parked or gone (senpi#2285).
        const handoff = reason === "handoff_parked" || (reason === "session_dir_removed" && this.draining);
        const owners = handoff
            ? [...this.sessionsByConnection].filter(([, owned]) => owned.has(sessionId)).map(([connection]) => connection)
            : [];
        // A failed claim means an explicit close raced us and owns the entry now.
        const claim = this.tryClaimClose(sessionId, { drainAttachments: true });
        if (!claim)
            return;
        const binding = this.bindings.get(sessionId);
        binding?.cancelPendingExtensionUiRequests?.();
        if (!handoff)
            this.forgetSessionOwnership(sessionId);
        if (claim.finalizer) {
            await this.finalizeClose(sessionId, binding, () => 
            // A drain names ITS reason on the close record. An idle sweep of a RETAINED
            // session parks instead: the file reopens by path. Anything else is a close.
            parkedPath !== undefined && reason === undefined
                ? this.writer.parkSession(sessionId, parkedPath)
                : this.writer.closeSession(sessionId, { type: "response", command: "close_session", success: true, data: {} }, reason ?? "idle_evicted", reason === "handoff_parked" ? parkedPath : undefined));
        }
        else {
            await this.finalizations.get(sessionId)?.promise;
        }
        if (handoff) {
            this.forgetSessionOwnership(sessionId);
            await this.onHandoffParked?.(owners.filter((connection) => !this.sessionsByConnection.has(connection)));
        }
        // The runtime is disposed and routing handles are unique per process
        // epoch, so nothing can emit under this id again: drop the writer's
        // per-session bookkeeping instead of retaining it for the host's life.
        this.writer.forgetSession(sessionId);
    }
    /** Resolves once the only request in flight for `sessionId` is the caller's own. */
    otherRequestsSettled(sessionId) {
        return new Promise((resolve) => {
            const listeners = this.requestSettledListeners.get(sessionId) ?? new Set();
            const check = () => {
                if ((this.activeRequests.get(sessionId) ?? 0) > 1)
                    return;
                listeners.delete(check);
                if (listeners.size === 0)
                    this.requestSettledListeners.delete(sessionId);
                resolve();
            };
            listeners.add(check);
            this.requestSettledListeners.set(sessionId, listeners);
            check();
        });
    }
    /**
     * The park teardown of `evictIdleSession`, claimed synchronously and sealed as released: every
     * attachment is drained, the runtime disposed and the path reservation freed before this resolves.
     */
    async tearDownReleased(sessionId, sessionPath) {
        const claim = this.tryClaimClose(sessionId, { drainAttachments: true });
        if (!claim)
            return false;
        const binding = this.bindings.get(sessionId);
        binding?.cancelPendingExtensionUiRequests?.();
        this.forgetSessionOwnership(sessionId);
        if (claim.finalizer)
            await this.finalizeClose(sessionId, binding, () => this.writer.releaseSession(sessionId, sessionPath));
        else
            await this.finalizations.get(sessionId)?.promise;
        this.writer.forgetSession(sessionId);
        return true;
    }
    /** Drops per-connection records for a handle the host closed on its own. */
    forgetSessionOwnership(sessionId) {
        for (const [connection, owned] of this.sessionsByConnection) {
            owned.delete(sessionId);
            if (owned.size === 0)
                this.sessionsByConnection.delete(connection);
        }
    }
    stopSweep() {
        if (this.sweepTimer === undefined)
            return;
        clearInterval(this.sweepTimer);
        this.sweepTimer = undefined;
    }
    openWithBarrier(command) {
        const owner = this.writer.currentConnection();
        if (owner === undefined)
            return this.open(command);
        let resolveBarrier;
        const barrier = new Promise((resolve) => {
            resolveBarrier = resolve;
        });
        const opens = this.opensByConnection.get(owner) ?? new Set();
        // Every open already accepted anywhere on this host, not just on this connection: the
        // in-process runtime serves them on ONE loop, so the wait this caller faces is the total.
        let inFlight = 0;
        for (const pending of this.opensByConnection.values())
            inFlight += pending.size;
        opens.add(barrier);
        this.opensByConnection.set(owner, opens);
        // Before the open reaches the loop: a client that later hits its deadline can then say
        // where it was queued instead of reporting a bare timeout (senpi#1844).
        if (command.id !== undefined)
            this.writer.sendOpenQueued(owner, {
                type: "queued",
                for_request: command.id,
                position: inFlight + 1,
                in_flight: inFlight,
            });
        return this.open(command, owner).finally(() => {
            resolveBarrier();
            opens.delete(barrier);
            if (opens.size === 0)
                this.opensByConnection.delete(owner);
        });
    }
    async open(command, owner) {
        // The opaque per-session inputs are parsed HERE, at the wire boundary, so the
        // registry, the runtime and the extensions downstream receive values already
        // proven to satisfy every documented cap.
        const kindError = sessionKindError(command.kind);
        if (kindError)
            return error(command.id, "open_session", `${RPC_ERROR_INVALID_SESSION_KIND}: ${kindError}`);
        const contextError = sessionContextError(command.context);
        if (contextError)
            return error(command.id, "open_session", `${RPC_ERROR_INVALID_SESSION_CONTEXT}: ${contextError}`);
        const autoTitleError = sessionAutoTitleError(command.auto_title);
        if (autoTitleError)
            return error(command.id, "open_session", `${RPC_ERROR_INVALID_LAUNCH_PROFILE}: ${autoTitleError}`);
        const promptSurfaceError = sessionPromptSurfaceError(command.promptSurface);
        if (promptSurfaceError)
            return error(command.id, "open_session", `${RPC_ERROR_INVALID_LAUNCH_PROFILE}: ${promptSurfaceError}`);
        let opened;
        try {
            opened = await this.registry.openSession({
                cwd: command.cwd ?? this.defaults.cwd,
                sessionPath: command.sessionPath,
                permissionPreset: command.permissionPreset ?? this.defaults.permissionPreset,
                creationModel: command.provider && command.modelId
                    ? { provider: command.provider, modelId: command.modelId }
                    : this.defaults.creationModel,
                initialThinkingLevel: command.thinkingLevel ?? this.defaults.initialThinkingLevel,
                sessionKind: command.kind,
                sessionContext: this.defaults.hostContext
                    ? { ...command.context, ...this.defaults.hostContext }
                    : command.context,
                ...(command.durableSessionId !== undefined ? { durableSessionId: command.durableSessionId } : {}),
                ...(typeof command.auto_title === "boolean" ? { autoTitle: command.auto_title } : {}),
                ...(command.promptSurface !== undefined ? { promptSurface: command.promptSurface } : {}),
            }, 
            // Host lifecycle policy, deliberately outside the immutable launch profile.
            { retainOnDisconnect: command.retain_on_disconnect === true });
            const openedSession = opened;
            const entry = this.registry.getForCommand(openedSession.sessionId, "open_session");
            this.writer.setSessionKind(openedSession.sessionId, entry.kind);
            if (owner !== undefined) {
                if (!this.writer.hasRegisteredConnectionCapabilities(owner))
                    this.writer.setConnectionCapabilities(owner, this.pendingCapabilities.get(owner) ?? this.connectionOptions?.capabilities ?? []);
                this.writer.attachConnectionToSession(owner, openedSession.sessionId);
            }
            // A client that dies without close_session (terminal closed, SIGKILL, dropped
            // SSH) still holds this handle's attachment and its path reservation. Remember
            // which connection owns it so releaseConnection() can close exactly that.
            if (owner !== undefined) {
                const owned = this.sessionsByConnection.get(owner) ?? new Map();
                owned.set(openedSession.sessionId, (owned.get(openedSession.sessionId) ?? 0) + 1);
                this.sessionsByConnection.set(owner, owned);
            }
            if (!this.bindings.has(openedSession.sessionId)) {
                this.bindings.set(openedSession.sessionId, await this.createBinding(openedSession.sessionId, entry, this.writer, () => void this.close({ type: "close_session", sessionId: openedSession.sessionId }), {
                    ...this.connectionOptions,
                    capabilities: owner !== undefined
                        ? (this.pendingCapabilities.get(owner) ?? this.connectionOptions?.capabilities ?? [])
                        : this.connectionOptions?.capabilities,
                    clientInfo: {
                        setCapabilities: (connectionId, capabilities) => {
                            if (connectionId !== undefined) {
                                this.writer.setConnectionCapabilities(connectionId, capabilities);
                                this.pendingCapabilities.set(connectionId, [...capabilities]);
                            }
                        },
                        connectionId: () => this.writer.currentConnection(),
                    },
                }));
                if (entry.worker)
                    entry.worker.bindingReady = true;
                // Wake the drain sweep the moment a session settles, so a handoff parks it
                // without waiting for the next timer tick. Both hooks are OPTIONAL: an
                // embedder's runtime and the suite's fakes implement the session surface
                // they need and nothing more, and an open must never fail because a
                // settle notification is unavailable - the periodic sweep still parks it.
                const settled = () => {
                    if (this.draining)
                        queueMicrotask(() => this.sweepDrain());
                };
                if (typeof entry.worker?.subscribeSettled === "function")
                    entry.worker.subscribeSettled(settled);
                else if (typeof entry.runtime?.session.subscribe === "function")
                    entry.runtime.session.subscribe((event) => {
                        if (event.type === "agent_settled" || event.type === "agent_idle")
                            settled();
                    });
                if (entry.worker)
                    void entry.worker.exited.then(async () => {
                        await this.finalizations.get(openedSession.sessionId)?.promise;
                        this.bindings.delete(openedSession.sessionId);
                        this.forgetSessionOwnership(openedSession.sessionId);
                        this.writer.forgetSession(openedSession.sessionId);
                    });
            }
            if (!this.draining && owner !== undefined && this.releasedConnections.has(owner)) {
                this.releaseOwnerAttachment(owner, openedSession.sessionId);
                await this.releaseOwnedSession(openedSession.sessionId);
            }
            const state = entry.worker?.snapshot?.state ?? (entry.runtime ? buildRpcSessionState(entry.runtime.session) : undefined);
            if (!state)
                throw new Error("Session state was not created");
            this.writer.enqueue(opened.sessionId, {
                id: command.id,
                type: "response",
                command: "open_session",
                success: true,
                data: {
                    sessionId: opened.sessionId,
                    state,
                    ...(opened.attached ? { attached: true } : {}),
                },
            });
            return undefined;
        }
        catch (cause) {
            if (opened) {
                try {
                    await this.registry.close(opened.sessionId);
                }
                catch {
                    /* The open rollback has already removed the entry. */
                }
            }
            return error(command.id, "open_session", this.code(cause), this.detail(cause));
        }
    }
    /**
     * Releases every session a dropped connection still owned. Each handle goes through
     * the same refcounted close as an explicit close_session, so a session another
     * connection is still attached to keeps running and only the last owner tears it down.
     */
    async releaseConnection(connectionId) {
        this.releasedConnections.add(connectionId);
        this.writer.clearConnectionCapabilities(connectionId);
        for (const sessionId of this.sessionsByConnection.get(connectionId)?.keys() ?? [])
            this.writer.detachConnectionFromSession(connectionId, sessionId);
        const opens = this.opensByConnection.get(connectionId);
        const owned = this.sessionsByConnection.get(connectionId);
        this.sessionsByConnection.delete(connectionId);
        if (this.draining) {
            // Drain owns teardown now, even when a client reacts to the announcement early.
            // Its attachment-draining claim releases these counts once work settles.
            if (opens)
                await Promise.all([...opens]);
            this.releasedConnections.delete(connectionId);
            return;
        }
        if (owned === undefined) {
            if (opens)
                await Promise.all([...opens]);
            this.releasedConnections.delete(connectionId);
            return;
        }
        await Promise.all([...owned].map(async ([sessionId, count]) => {
            for (let attachment = 0; attachment < count; attachment++) {
                // Headless completion contract: a turn survives its client's death and
                // runs to settlement (the host lifecycle keeps the process alive on
                // active turns even with zero connections). Releasing mid-turn aborts
                // the run and seals the session before agent_settled reaches the
                // lifecycle observer, leaking the busy counter so the host never
                // idle-exits. Defer - never skip - the release until the turn settles,
                // so the dropped owner's reservation still frees afterwards.
                //
                // A retained session is never closed by a drop, so it has nothing to defer:
                // release the attachment now - the client is already gone and must not keep
                // counting - and let the turn run to settlement on its own.
                const live = this.registry.peek(sessionId);
                const retained = live?.retainOnDisconnect === true;
                const session = live?.state === "open" ? live.runtime?.session : undefined;
                if (!retained && live?.state === "open" && live.worker?.snapshot?.streaming) {
                    const unsubscribe = live.worker.subscribeSettled(() => {
                        unsubscribe();
                        void this.releaseOwnedSession(sessionId).catch((cause) => {
                            process.stderr.write(`senpi rpc deferred worker release ${sessionId} failed: ${String(cause)}\n`);
                        });
                    });
                    continue;
                }
                if (!retained && session?.isStreaming) {
                    let released = false;
                    const unsubscribe = session.subscribe((event) => {
                        if (event.type !== "agent_settled" && event.type !== "agent_idle")
                            return;
                        if (released)
                            return;
                        released = true;
                        unsubscribe();
                        void this.releaseOwnedSession(sessionId).catch((cause) => {
                            process.stderr.write(`senpi rpc deferred release for session ${sessionId} failed: ${String(cause)}\n`);
                        });
                    });
                    continue;
                }
                await this.releaseOwnedSession(sessionId);
            }
        }));
        if (opens)
            await Promise.all([...opens]);
        this.releasedConnections.delete(connectionId);
    }
    /**
     * One owned handle's refcounted close: the same sequence as an explicit
     * close_session, tolerant of races with other lifecycle paths (an entry
     * already closed or claimed elsewhere is simply skipped), except that it claims
     * a DETACH: a retained entry keeps running at zero attachments instead of
     * closing, so this path releases the client's claim without ending the session.
     * Disposal, pending
     * extension-UI cancellation and binding removal happen only when this was the
     * LAST attachment (the entry transitioned to "closing"): surviving
     * attachments keep the shared binding and their event stream.
     */
    async releaseOwnedSession(sessionId) {
        const live = this.registry.peek(sessionId);
        const parks = live?.state === "open" && live.retainOnDisconnect === true && live.attachments === 1;
        // A failed claim means the entry is already closed or owned by another path.
        // A retained entry answers the detach by staying open: no finalizer, nothing to join.
        const claim = this.tryClaimClose(sessionId, { drainAttachments: false, detach: true });
        if (!claim)
            return;
        if (!claim.finalizer) {
            if (parks && live.runtime) {
                live.lifecycleMutex = live.lifecycleMutex.then(() => live.runtime?.emitAttachmentEvent("session_parked"));
                await live.lifecycleMutex;
            }
            await this.finalizations.get(sessionId)?.promise;
            return;
        }
        const binding = this.bindings.get(sessionId);
        // Pending UI requests are session-owned, not connection-owned: a question
        // asked through one connection stays answerable by every other attachment.
        // Cancel them only here, where the refcount has already decided the session
        // is being torn down, never on any owner drop.
        binding?.cancelPendingExtensionUiRequests?.();
        await this.finalizeClose(sessionId, binding);
    }
    /**
     * Releases one attachment (or every attachment when draining) and reports
     * whether this caller became the finalizer. The join token is installed inside
     * the registry callback, before any await, so a close that lands between the
     * claim and finalizeClose() always finds a token to wait on instead of
     * answering ahead of the terminal records.
     */
    claimClose(sessionId, options) {
        let finalizer = true;
        const onRole = (isFinalizer) => {
            finalizer = isFinalizer;
            if (isFinalizer && !this.finalizations.has(sessionId))
                this.finalizations.set(sessionId, this.createFinalization());
        };
        let entry = this.registry.beginClose(sessionId, onRole, { detach: options.detach });
        while (options.drainAttachments && entry.state === "open")
            entry = this.registry.beginClose(sessionId, onRole);
        return { finalizer: finalizer && entry.state === "closing" };
    }
    /** claimClose() for lifecycle paths that treat a lost race as "nothing to do". */
    tryClaimClose(sessionId, options) {
        try {
            return this.claimClose(sessionId, options);
        }
        catch {
            return undefined;
        }
    }
    async close(command) {
        const response = {
            id: command.id,
            type: "response",
            command: "close_session",
            success: true,
            data: {},
        };
        // A close releases the CALLER's attachment, and routing handles are public on a
        // shared host (`list_sessions` publishes every one of them), so ownership - not
        // knowledge of the handle - authorizes it: a connection that never attached holds
        // no attachment, and answering it would release another client's claim and could
        // tear down a session it never opened. A host with no per-connection identity
        // (stdio) has no ownership to check and keeps answering every close as before.
        const owner = this.writer.currentConnection();
        if (owner !== undefined && this.sessionsByConnection.get(owner)?.has(command.sessionId) !== true)
            return error(command.id, "close_session", RPC_ERROR_UNKNOWN_SESSION);
        const reply = this.writer.reserveCloseResponse(command.sessionId, response);
        if (!reply)
            return undefined;
        // Admission and claiming are synchronous, before any teardown await. A
        // saturated requester neither releases an attachment nor joins a promise.
        let claim;
        try {
            claim = this.claimClose(command.sessionId, { drainAttachments: false });
        }
        catch (cause) {
            reply.release();
            return error(command.id, "close_session", this.code(cause));
        }
        try {
            if (owner !== undefined)
                this.releaseOwnerAttachment(owner, command.sessionId);
            if (claim.finalizer) {
                await this.finalizeClose(command.sessionId, this.bindings.get(command.sessionId), () => reply.complete(true, "client_close"));
            }
            else {
                await this.finalizations.get(command.sessionId)?.promise;
                reply.complete(false);
            }
            return undefined;
        }
        finally {
            reply.release();
        }
    }
    /** Detaches the closing connection from the session's record fanout. */
    releaseOwnerAttachment(owner, sessionId) {
        this.writer.detachConnectionFromSession(owner, sessionId);
        const owned = this.sessionsByConnection.get(owner);
        const count = owned?.get(sessionId);
        if (!owned || count === undefined)
            return;
        if (count === 1)
            owned.delete(sessionId);
        else
            owned.set(sessionId, count - 1);
        if (owned.size === 0)
            this.sessionsByConnection.delete(owner);
    }
    /**
     * Runs the finalizer side of a close for a handle whose beginClose() made this
     * caller the owner: dispose the binding, complete the registry teardown, emit
     * the terminal records, then release joiners. Every step is guarded so the join
     * token always resolves and a failing binding yields one logged line, never a
     * second response or an escaped rejection.
     */
    async finalizeClose(sessionId, binding, terminal) {
        const finalization = this.finalizations.get(sessionId) ?? this.createFinalization();
        this.finalizations.set(sessionId, finalization);
        try {
            try {
                await binding?.dispose();
            }
            catch (cause) {
                process.stderr.write(`senpi rpc binding dispose for session ${sessionId} failed: ${String(cause)}\n`);
            }
            this.bindings.delete(sessionId);
            try {
                await this.registry.closeMarked(sessionId);
            }
            catch (cause) {
                process.stderr.write(`senpi rpc close for session ${sessionId} failed: ${String(cause)}\n`);
            }
            // closeMarked may return at the grace deadline while ownership remains;
            // terminal records must still observe the exit callback's registry removal.
            await this.registry.peek(sessionId)?.closeCompletion;
            terminal?.();
        }
        finally {
            finalization.resolve();
            this.finalizations.delete(sessionId);
        }
    }
    createFinalization() {
        let resolveFinalization;
        const promise = new Promise((resolve) => {
            resolveFinalization = resolve;
        });
        return { promise, resolve: () => resolveFinalization?.() };
    }
    /** The machine-readable half of a refusal, when the registry attached one. */
    detail(cause) {
        return cause instanceof RpcSessionRegistryError ? cause.detail : undefined;
    }
    code(cause) {
        if (cause instanceof RpcSessionRegistryError) {
            return cause.code === RPC_ERROR_OPEN_FAILED ? cause.message : cause.code;
        }
        if (cause instanceof Error && [RPC_ERROR_UNKNOWN_SESSION, RPC_ERROR_SESSION_CLOSING].includes(cause.message)) {
            return cause.message;
        }
        return cause instanceof Error && cause.message
            ? `${RPC_ERROR_OPEN_FAILED}: ${cause.message}`
            : RPC_ERROR_UNKNOWN_SESSION;
    }
}
//# sourceMappingURL=session-command-router.js.map
