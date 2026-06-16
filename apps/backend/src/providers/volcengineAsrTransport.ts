import { WebSocket } from "ws";

export type VolcengineAsrConnectOptions = {
  endpoint: string;
  headers: Record<string, string>;
};

export type VolcengineAsrTransportCallbacks = {
  onMessage: (data: Buffer) => void;
  onError: (error: Error) => void;
  onClose: (code: number, reason: string) => void;
};

export interface VolcengineAsrTransport {
  send(data: Buffer): void;
  close(): void;
}

export type VolcengineAsrTransportFactory = (
  options: VolcengineAsrConnectOptions,
  callbacks: VolcengineAsrTransportCallbacks,
) => VolcengineAsrTransport;

export const connectVolcengineAsrTransport: VolcengineAsrTransportFactory = (
  options,
  callbacks,
) => {
  const socket = new WebSocket(options.endpoint, { headers: options.headers });
  socket.binaryType = "nodebuffer";

  let open = false;
  const queue: Buffer[] = [];

  socket.on("open", () => {
    open = true;
    for (const buffered of queue) {
      socket.send(buffered);
    }
    queue.length = 0;
  });
  socket.on("message", (data: WebSocket.RawData, _isBinary: boolean) => {
    callbacks.onMessage(data as Buffer);
  });
  socket.on("error", (error: Error) => {
    callbacks.onError(error);
  });
  socket.on("close", (code: number, reason: Buffer) => {
    callbacks.onClose(code, reason.toString("utf8"));
  });

  return {
    send(data: Buffer): void {
      if (open && socket.readyState === socket.OPEN) {
        socket.send(data);
      } else {
        queue.push(data);
      }
    },
    close(): void {
      socket.close();
    },
  };
};
