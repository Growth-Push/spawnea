import type { Socket } from 'node:net';
import type { Readable, Writable } from 'node:stream';

export interface McpBridgeIo {
  stdin: Readable;
  stdout: Writable;
  reportConnectionError(error: Error): void;
  setExitCode(code: number): void;
}

export function attachMcpBridgeSocket(
  socket: Socket,
  token: string,
  io: McpBridgeIo,
): () => void {
  let connectionFailed = false;

  socket.once('connect', () => {
    const sessionId = process.env.SPAWNEA_SESSION_ID;
    if (!sessionId) {
      io.reportConnectionError(new Error('SPAWNEA_SESSION_ID is required for scoped MCP access'));
      socket.destroy();
      return;
    }
    socket.write(`${JSON.stringify({ type: 'spawnea-auth', token, sessionId })}\n`);
    io.stdin.pipe(socket);
    socket.pipe(io.stdout);
    io.stdin.resume();
  });
  socket.once('error', (error) => {
    connectionFailed = true;
    io.reportConnectionError(error);
  });
  socket.once('close', () => {
    if (!io.stdin.destroyed) io.stdin.pause();
    // Setting exitCode preserves the one-shot lifecycle while allowing pending
    // stdout writes to drain before the Node.js process terminates naturally.
    io.setExitCode(connectionFailed ? 1 : 0);
  });

  return () => {
    io.stdin.unpipe(socket);
    socket.end();
  };
}
