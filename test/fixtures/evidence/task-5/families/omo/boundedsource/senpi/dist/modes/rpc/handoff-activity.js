import { isSessionBusySnapshot } from "../../core/session-activity.js";
/** Handoff preserves turns and requests, but durable wake sources resume when the file is reopened. */
export function isHandoffBusy(snapshot) {
    return isSessionBusySnapshot({ ...snapshot, hasActiveWakeSource: false });
}
//# sourceMappingURL=handoff-activity.js.map
