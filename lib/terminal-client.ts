export async function terminalRequest(path: string, options?: RequestInit): Promise<{ id?: string; cwd?: string }> {
  const response = await fetch(path, { ...options, signal: AbortSignal.timeout(15_000) });
  const data = await response.json().catch(() => {
    throw new Error(`Terminal request failed (HTTP ${response.status}): server returned an empty or invalid JSON response. Check the omp-frond server log.`);
  });
  if (!data || typeof data !== "object") throw new Error(`Terminal request failed (HTTP ${response.status}): invalid JSON response. Check the omp-frond server log.`);
  if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
  return data;
}

// xterm parses writes asynchronously and emits protocol replies through onData.
export function createTerminalReplayGuard() {
  let awaitingHistory = false;
  let drawingHistory = 0;
  return {
    open(replay: boolean) {
      awaitingHistory = replay;
    },
    write(data: string, write: (data: string, done?: () => void) => void) {
      const history = awaitingHistory;
      awaitingHistory = false;
      if (history && data) {
        drawingHistory += 1;
        write(data, () => { drawingHistory -= 1; });
      } else {
        write(data);
      }
    },
    suppressingInput() {
      return drawingHistory > 0;
    },
  };
}

export function createTerminalWriter(id: string, onError: (error: Error) => void) {
  let pending = Promise.resolve();
  let stopped = false;
  let bufferedInput: { type: "input"; data: string } | null = null;
  const enqueue = (body: Record<string, unknown>) => {
    if (stopped) return;
    pending = pending.then(async () => {
      if (stopped) return;
      if (body === bufferedInput) bufferedInput = null;
      await terminalRequest(`/api/terminal/${encodeURIComponent(id)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    }).catch((error: Error) => {
      // Delivery is ambiguous after a network error. Never replay shell input.
      stopped = true;
      onError(error);
    });
  };
  return {
    write(data: string) {
      if (stopped) return;
      for (const chunk of data.match(/[\s\S]{1,32768}/gu) ?? []) {
        if (bufferedInput && bufferedInput.data.length + chunk.length <= 65536) bufferedInput.data += chunk;
        else {
          bufferedInput = { type: "input", data: chunk };
          enqueue(bufferedInput);
        }
      }
    },
    resize(cols: number, rows: number) {
      bufferedInput = null;
      enqueue({ type: "resize", cols, rows });
    },
    stop() { stopped = true; bufferedInput = null; return pending; },
  };
}
