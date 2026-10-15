// A task-owned IPC child. It never reads user configuration or starts an agent.
process.on("message", message => {
  if (message === "stop") process.exit(0);
});
process.send?.({ session: process.argv[2], version: process.argv[3] });
