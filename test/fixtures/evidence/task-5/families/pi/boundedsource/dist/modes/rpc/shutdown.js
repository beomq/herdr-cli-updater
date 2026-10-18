/** Process shutdown entry shared by EOF, signals and transport failures. */
export function createRpcShutdown(dispose, exit) {
    let pending;
    let code = 0;
    return (exitCode = 0, signal) => {
        if (code === 0)
            code = exitCode;
        if (pending)
            return pending;
        pending = (async () => {
            await dispose(signal);
            return exit(code);
        })();
        return pending;
    };
}
//# sourceMappingURL=shutdown.js.map
