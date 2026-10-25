import { describe, expect, it } from "vitest";
import { changeStream } from "./sse";

async function readAll(response: Response): Promise<string> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return out;
    out += decoder.decode(value);
  }
}

describe("changeStream", () => {
  it("sends the state only when it changes, and ends once it is final", async () => {
    const states = ["paid", "paid", "accepted", "accepted", "ready", "completed"];
    let i = 0;
    const response = changeStream({
      load: () => Promise.resolve({ status: states[Math.min(i++, states.length - 1)]! }),
      key: (s) => s.status,
      isFinal: (s) => s.status === "completed",
      signal: new AbortController().signal,
      intervalMs: 1,
    });
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const body = await readAll(response);
    const events = body
      .split("\n\n")
      .filter((e) => e.startsWith("event: update"))
      .map((e) => (JSON.parse(e.split("data: ")[1]!) as { status: string }).status);
    expect(events).toEqual(["paid", "accepted", "ready", "completed"]);
    expect(body.startsWith("retry: 1500")).toBe(true);
  });

  it("stops when the client goes away", async () => {
    const controller = new AbortController();
    let loads = 0;
    const response = changeStream({
      load: () => {
        loads += 1;
        if (loads === 3) controller.abort();
        return Promise.resolve({ n: loads });
      },
      signal: controller.signal,
      intervalMs: 1,
    });
    await readAll(response);
    expect(loads).toBe(3);
  });
});
