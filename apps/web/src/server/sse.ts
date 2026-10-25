import "server-only";
import { logger } from "./logger";

/*
 * Server-sent events for live screens (staff queue, order tracking).
 *
 * The stream reloads its data every `intervalMs` and sends it only when it changed, so screens
 * update within a couple of seconds of any change, whichever server instance made it, without a
 * message broker. Each stream ends after `maxMs` (well within the platform's function limit); the
 * browser's EventSource reconnects by itself, and screens fall back to polling if it can't.
 */

export interface ChangeStreamOptions<T> {
  /** Loads the current state. */
  load: () => Promise<T>;
  /** What counts as a change (default: the JSON of the state). */
  key?: (value: T) => string;
  /** Stop once the state can't change any more (e.g. a finished order). */
  isFinal?: (value: T) => boolean;
  signal: AbortSignal;
  intervalMs?: number;
  maxMs?: number;
  heartbeatMs?: number;
}

const encoder = new TextEncoder();

export function changeStream<T>({
  load,
  key = (v) => JSON.stringify(v),
  isFinal = () => false,
  signal,
  intervalMs = 2000,
  maxMs = 240_000,
  heartbeatMs = 15_000,
}: ChangeStreamOptions<T>): Response {
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const started = Date.now();
      let last: string | null = null;
      let lastWrite = Date.now();
      const write = (chunk: string) => {
        controller.enqueue(encoder.encode(chunk));
        lastWrite = Date.now();
      };
      // Reconnect quickly when the stream ends on purpose.
      write("retry: 1500\n\n");
      try {
        while (!signal.aborted && Date.now() - started < maxMs) {
          const value = await load();
          const current = key(value);
          if (current !== last) {
            last = current;
            write(`event: update\ndata: ${JSON.stringify(value)}\n\n`);
          } else if (Date.now() - lastWrite >= heartbeatMs) {
            // Keeps proxies from closing an idle connection.
            write(": ping\n\n");
          }
          if (isFinal(value)) break;
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, intervalMs);
            signal.addEventListener(
              "abort",
              () => {
                clearTimeout(timer);
                resolve();
              },
              { once: true },
            );
          });
        }
      } catch (err) {
        if (!signal.aborted) logger().warn({ err }, "live stream stopped");
      }
      try {
        controller.close();
      } catch {
        // Already closed by the client.
      }
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
