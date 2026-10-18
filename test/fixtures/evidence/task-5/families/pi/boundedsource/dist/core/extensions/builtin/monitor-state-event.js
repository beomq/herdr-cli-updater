export const TERMINAL_MONITOR_STATE_EVENT = "terminal_monitor_state";
export const TERMINAL_MONITOR_ENDED_EVENT = "terminal_monitor_ended";
export const WAKE_SOURCE_STATE_EVENT = "wake_source_state";
export const CONTINUATION_HOLD_STATE_EVENT = "continuation_hold_state";
/**
 * Deliberately validates only the shared cross-package fields. Emitters may add
 * source-specific details such as `channels` or `monitors`.
 */
export function isWakeSourceStateEvent(data) {
    return (typeof data === "object" &&
        data !== null &&
        "source" in data &&
        typeof data.source === "string" &&
        data.source.length > 0 &&
        "activeCount" in data &&
        typeof data.activeCount === "number" &&
        Number.isFinite(data.activeCount));
}
export function isContinuationHoldStateEvent(data) {
    return (typeof data === "object" &&
        data !== null &&
        "source" in data &&
        typeof data.source === "string" &&
        data.source.length > 0 &&
        "active" in data &&
        typeof data.active === "boolean");
}
export function isTerminalMonitorStateEvent(data) {
    return (typeof data === "object" &&
        data !== null &&
        "activeCount" in data &&
        typeof data.activeCount === "number" &&
        Number.isInteger(data.activeCount) &&
        data.activeCount >= 0);
}
export function isTerminalMonitorEndedEvent(data) {
    return (typeof data === "object" &&
        data !== null &&
        "id" in data &&
        typeof data.id === "string" &&
        "description" in data &&
        typeof data.description === "string" &&
        "startedAtMs" in data &&
        typeof data.startedAtMs === "number" &&
        Number.isFinite(data.startedAtMs) &&
        "endedAtMs" in data &&
        typeof data.endedAtMs === "number" &&
        Number.isFinite(data.endedAtMs) &&
        "exitCode" in data &&
        (data.exitCode === null || (typeof data.exitCode === "number" && Number.isInteger(data.exitCode))) &&
        "fireCount" in data &&
        typeof data.fireCount === "number" &&
        Number.isInteger(data.fireCount) &&
        data.fireCount >= 0 &&
        "reason" in data &&
        (data.reason === "exit" || data.reason === "timeout" || data.reason === "killed" || data.reason === "disposed"));
}
//# sourceMappingURL=monitor-state-event.js.map
