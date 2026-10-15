import { loadPluginRuntime, PluginRuntimeError } from "../service/plugin-runtime";
import { serveDomainWorker, WorkerError } from "../service/worker";
import { hasProcessConsumer } from "./observations";
import type { ResourcePlan } from "../install/resources";

/** A private source composition, never selected by a browser request. */
const standaloneRuntime: typeof loadPluginRuntime = async (context, configurationPath) => {
  const result = await loadPluginRuntime(context, configurationPath);
  if (result.kind !== "configured") return result;
  const { profile, profiles = [], ...runner } = result.runner;
  const all = [...(profile ? [profile] : []), ...profiles];
  return { ...result, runner: { ...runner, profiles: all.map(profile => ({
    ...profile,
    observe: (plan: ResourcePlan) => {
      const before = hasProcessConsumer(plan.contract.installation.executableRealpath);
      const observed = profile.observe(plan);
      const after = hasProcessConsumer(plan.contract.installation.executableRealpath);
      if ((before || after) && typeof observed === "object" && observed !== null)
        return { ...observed, outsideConsumersKnown: false };
      return observed;
    },
  })) } };
};

if (import.meta.main) {
  try {
    const directory = process.argv[3];
    if (process.argv[2] !== "--worker" || !directory?.startsWith("/")) throw new WorkerError("invalid_command");
    // Standalone never imports a caller's executable factory. A retained native
    // restart configuration may use the explicitly selected Herdr socket.
    delete process.env["HERDR_CLI_UPDATER_RUNNER_FACTORY"];
    const worker = await serveDomainWorker(directory, undefined, undefined, undefined, standaloneRuntime);
    process.send?.(worker.owner);
    await worker.closed;
  } catch (error) {
    if (error instanceof PluginRuntimeError) process.send?.({ runtimeError: error.reason });
    console.error(error instanceof PluginRuntimeError ? `runtime_${error.reason}`
      : error instanceof WorkerError ? error.code : "worker_unavailable");
    process.exitCode = 1;
  }
}
