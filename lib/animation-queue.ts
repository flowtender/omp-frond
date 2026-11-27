export interface AnimationQueue {
  enqueue(start: () => Promise<unknown> | undefined): void;
}

/** Starts the next visual step only after the current step settles or is cancelled. */
export function createAnimationQueue(): AnimationQueue {
  const pending: Array<() => Promise<unknown> | undefined> = [];
  let running = false;
  const advance = () => {
    for (let start = pending.shift(); start; start = pending.shift()) {
      const finished = start();
      if (finished) {
        void finished.then(advance, advance);
        return;
      }
    }
    running = false;
  };
  return {
    enqueue(start: () => Promise<unknown> | undefined) {
      pending.push(start);
      if (running) return;
      running = true;
      advance();
    },
  };
}
