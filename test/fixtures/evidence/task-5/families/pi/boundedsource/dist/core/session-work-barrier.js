/**
 * Re-sample rounds allowed before the loop starts yielding to the event loop.
 * Normal sessions settle within a couple of rounds, so a small budget keeps the
 * fast path free of macrotask hops while still catching a runaway queue.
 */
const SETTLE_ROUNDS_BEFORE_YIELD = 16;
/**
 * Yields to a real event-loop turn between re-sample rounds. Awaiting only
 * promises keeps work on the microtask queue, which starves timers and IO and
 * pins a core at 100% CPU.
 *
 * A `MessageChannel` message is a genuine macrotask that mocked timers do not
 * replace, so the loop keeps yielding under `vi.useFakeTimers()`. `setTimeout`
 * and `setImmediate` are both stubbed there and would stall every caller that
 * drives retry/compaction recovery on a mocked clock; `process.nextTick` runs
 * ahead of the microtask drain and would not relieve the starvation at all.
 */
function yieldToEventLoop() {
    return new Promise((resolve) => {
        const channel = new MessageChannel();
        channel.port1.onmessage = () => {
            channel.port1.close();
            channel.port2.close();
            resolve();
        };
        channel.port2.postMessage(undefined);
    });
}
export class SessionWorkBarrier {
    constructor() {
        this.activeWork = undefined;
        this.activeWorkResolve = undefined;
        this.activeWorkDepth = 0;
    }
    get hasActiveWork() {
        return this.activeWork !== undefined;
    }
    begin() {
        if (!this.activeWork) {
            let resolveWork;
            this.activeWork = new Promise((resolve) => {
                resolveWork = resolve;
            });
            if (!resolveWork) {
                throw new Error("Session work resolver was not initialized");
            }
            this.activeWorkResolve = resolveWork;
        }
        this.activeWorkDepth++;
        let finished = false;
        return () => {
            if (finished) {
                return;
            }
            finished = true;
            this.activeWorkDepth = Math.max(0, this.activeWorkDepth - 1);
            if (this.activeWorkDepth > 0) {
                return;
            }
            const resolveWork = this.activeWorkResolve;
            this.activeWork = undefined;
            this.activeWorkResolve = undefined;
            resolveWork?.();
        };
    }
    async waitForSettled(getEventQueue) {
        for (let round = 0;; round++) {
            const eventQueue = getEventQueue();
            const work = this.activeWork;
            await eventQueue;
            if (work) {
                await work;
            }
            if (getEventQueue() === eventQueue && !this.activeWork) {
                return;
            }
            // The queue moved under us. The first rounds re-sample immediately so a
            // continuation scheduled during this turn is still observed as pending —
            // that tight re-check is what keeps queued work from being reported as
            // settled. Once the queue proves it is not converging, hand control back
            // to the event loop so a session that re-chains already-resolved promises
            // cannot pin a core at 100% CPU.
            if (round >= SETTLE_ROUNDS_BEFORE_YIELD) {
                await yieldToEventLoop();
            }
        }
    }
}
//# sourceMappingURL=session-work-barrier.js.map
