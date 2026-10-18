import { WakeScheduler, watchInbox } from "../interactive/session-control-wake.js";
export class HostSessionControl {
    constructor(session, socket, report) {
        this.disposed = false;
        this.session = session;
        this.socket = socket;
        this.report = report;
    }
    async register(options) {
        this.releaseActive();
        if (this.disposed || this.socket === undefined)
            return { status: "unsupported", reason: "unsupported_mode" };
        const { session } = this;
        const scheduler = new WakeScheduler(async (event) => {
            await session.extensionRunner.emit(event);
            return (await options.drain(event)) ?? { admitted: [] };
        }, (error) => this.report(`control drain failed: ${errorText(error)}`));
        const wake = (reason) => void scheduler.request(reason);
        const unsubscribeIdle = session.subscribe((event) => {
            if (event.type === "agent_idle")
                wake("idle");
        });
        const unsubscribeEmitted = session.externalAdmission.onEmitted(() => wake("emitted"));
        let stopInbox;
        const registration = {
            scheduler,
            release: () => {
                unsubscribeIdle();
                unsubscribeEmitted();
                stopInbox?.();
                scheduler.dispose();
            },
        };
        try {
            stopInbox = await watchInbox(options.inboxDir, () => wake("inbox"), (error) => this.report(`control inbox watch failed: ${errorText(error)}`));
        }
        catch (error) {
            registration.release();
            return { status: "failed", reason: errorText(error) };
        }
        // A rebind may dispose this host while the watch arms; a registration it outlived stays inert.
        if (this.disposed) {
            registration.release();
            return { status: "unsupported", reason: "unsupported_mode" };
        }
        this.releaseActive();
        this.active = registration;
        // Anything that reached the inbox before the watch was armed is picked up by this first pass.
        wake("inbox");
        return {
            status: "registered",
            socket: this.socket,
            dispose: async () => {
                if (this.active === registration)
                    this.releaseActive();
            },
        };
    }
    /** The `wake` command: one drain pass covering `deliveryIds`, answered with what it admitted. */
    async wake(deliveryIds) {
        const active = this.active;
        if (active !== undefined)
            return active.scheduler.request("command", deliveryIds);
        const ids = deliveryIds === undefined || deliveryIds.length === 0 ? {} : { delivery_ids: deliveryIds };
        await this.session.extensionRunner.emit({
            type: "session_control_wake",
            reason: "command",
            reasons: ["command"],
            ...ids,
        });
        return { admitted: [] };
    }
    /** Synchronous so a rebind never gains an await: every edge source stops here. */
    dispose() {
        this.disposed = true;
        this.releaseActive();
    }
    releaseActive() {
        const active = this.active;
        this.active = undefined;
        active?.release();
    }
}
function errorText(error) {
    return error instanceof Error ? error.message : String(error);
}
//# sourceMappingURL=host-session-control.js.map
