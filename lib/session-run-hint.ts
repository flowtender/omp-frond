/**
 * The sidebar's running poll for the session an open chat shows, and what the
 * chat should do when that changes. Pure, so the rules are testable without
 * React: the hook supplies what this device already knows about the session.
 */
export interface RunHint {
  sessionId: string;
  running: boolean;
  /**
   * The session row's modified time and message count. A run that starts and
   * ends between two polls leaves no running state behind, but it does change
   * this. Null while the row's details are still hydrating, because hydration
   * alone is not activity.
   */
  activity: string | null;
}

export interface LocalRunState {
  /** A live event stream for this session is attached. */
  attached: boolean;
  /** This device has a run of the session in flight. */
  localRunning: boolean;
  /** This device has a prompt on its way to the session. */
  promptPending: boolean;
}

/**
 * - `follow`: connect to the run that is in progress. History is already loaded.
 * - `reload-and-follow`: a run started while this chat showed the session, or
 *   the session changed while a run is in progress. Reload history first so
 *   messages other devices sent are included, then connect.
 * - `reload`: a run ended, or the session changed while idle, while this device
 *   was not attached to it. Reload history for what other devices wrote.
 * - `none`: nothing to do.
 */
export type RunHintAction = "none" | "follow" | "reload" | "reload-and-follow";

export function runHintAction(previous: RunHint | null, current: RunHint, local: LocalRunState): RunHintAction {
  // The first observation is the mount's: its load already follows a run in progress.
  if (!previous) return "none";
  const sameSession = previous.sessionId === current.sessionId;
  const busyHere = local.attached || local.localRunning || local.promptPending;
  // An attached stream already delivers the run's end and its messages.
  if (busyHere) return "none";
  const activityChanged = sameSession
    && previous.activity !== null
    && current.activity !== null
    && previous.activity !== current.activity;
  if (current.running) {
    if (!sameSession) return "follow";
    if (!previous.running) return "reload-and-follow";
    // Still running and not attached: an earlier connect failed, so try again.
    // A changed row means messages moved while this view was not following.
    return activityChanged ? "reload-and-follow" : "follow";
  }
  if (sameSession && (previous.running || activityChanged)) return "reload";
  return "none";
}
