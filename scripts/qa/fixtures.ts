// A real disposable child exercising transport and lifecycle, not an AI provider.
export const socketChild = `
import { createServer } from "node:net";
import { chmodSync } from "node:fs";
const send = (event, data = {}) => console.log(JSON.stringify({ event, ...data }));
const socket = process.env.HERDR_SOCKET;
const server = createServer(connection => {
  connection.on("data", bytes => {
    if (bytes.toString() === "ping") connection.end("pong");
  });
});
process.on("SIGTERM", () => {
  send("terminated", { pid: process.pid });
  server.close(() => process.exit(0));
});
server.listen(socket, () => {
  chmodSync(socket, 0o600);
  send("ready", { pid: process.pid, socket, home: process.env.HOME });
});
let input = "";
process.stdin.on("data", bytes => {
  input += bytes.toString();
  let newline;
  while ((newline = input.indexOf("\\n")) !== -1) {
    const command = input.slice(0, newline);
    input = input.slice(newline + 1);
    if (command === "emit") send("ack");
    if (command === "exit") server.close(() => process.exit(0));
    if (command === "malformed") console.log("{broken");
  }
});
`;

export const malformedChild = 'console.log("{broken"); process.stdin.resume();';
export const quietChild = "process.stdin.resume();";
