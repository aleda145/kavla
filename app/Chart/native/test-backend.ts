import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { ExecuteArrow } from "./coordinator.ts";

export type Reply = {
  id: number;
  ipc?: string;
  error?: string;
  queryMs: number;
  serializationMs?: number;
  rowCount?: number;
};
export function testBackend() {
  const child = spawn(process.env.KAVLA_VIZ_BRIDGE ?? "/tmp/kavla-viz-bridge", [], {
    stdio: ["pipe", "pipe", "inherit"],
  });
  let id = 0;
  let executions = 0;
  let last: Reply | null = null;
  const pending = new Map<number, { resolve: (r: Reply) => void; reject: (e: Error) => void }>();
  child.on("error", (error) => pending.forEach((p) => p.reject(error)));
  child.on("exit", (code) => pending.forEach((p) => p.reject(new Error(`Backend bridge exited (${code})`))));
  createInterface({ input: child.stdout }).on("line", (line) => {
    const response = JSON.parse(line) as Reply;
    last = response;
    const promise = pending.get(response.id);
    pending.delete(response.id);
    if (response.error) promise?.reject(new Error(response.error));
    else promise?.resolve(response);
  });
  const request = (args: Record<string, unknown>) =>
    new Promise<Reply>((resolve, reject) => {
      const requestId = ++id;
      pending.set(requestId, { resolve, reject });
      child.stdin.write(JSON.stringify({ ...args, id: requestId }) + "\n");
    });
  const execute: ExecuteArrow = async (sql, signal) => {
    signal.throwIfAborted();
    executions++;
    const reply = await request({ sql });
    signal.throwIfAborted();
    return new Uint8Array(Buffer.from(reply.ipc!, "base64"));
  };
  return {
    execute,
    request,
    get executions() {
      return executions;
    },
    get last() {
      return last;
    },
    close: () => child.stdin.end(),
  };
}
