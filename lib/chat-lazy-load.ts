export const VISIBLE_PAGE_SIZE = 50;
// Server-side entry cap for one upward page (`/context?before=…&tail=…`).
// Bounded pages keep long-session paging from shipping the whole branch.
export const LOAD_OLDER_PAGE_TAIL = 200;
// Hard ceiling on entries fetched to restore a saved position automatically.
// Older history remains reachable by scrolling and paging it in explicitly.
export const RESTORE_ENTRY_BUDGET = 1500;
// Row shells kept while following the live tail.
export const TAIL_RENDER_WINDOW = 300;
export const CHAT_SCROLL_TAIL_TOLERANCE = 8;
export const CHAT_SCROLL_REATTACH_TOLERANCE = 96;

/**
 * Next render-window size for a changed `loadedCount`. While attached to the
 * tail the window slides: it stays at most TAIL_RENDER_WINDOW rows anchored
 * at the newest message, dropping older rows off the top (they stay loaded
 * server-side; the sentinel re-pages them). While detached (reading older
 * content) the window only grows to keep every loaded row visible, so
 * prepended pages are never sliced off the top.
 */
export function getNextWindowCount(currentVisibleCount: number, loadedCount: number, attachedToTail: boolean): number {
  return attachedToTail
    ? Math.min(loadedCount, TAIL_RENDER_WINDOW)
    : Math.max(currentVisibleCount, loadedCount);
}

export function getVisibleRenderWindow(totalCount: number, visibleCount: number): {
  startIndex: number;
  hasMore: boolean;
} {
  const clampedVisibleCount = Math.min(Math.max(visibleCount, 0), Math.max(totalCount, 0));
  const startIndex = Math.max(0, totalCount - clampedVisibleCount);
  return { startIndex, hasMore: startIndex > 0 };
}

export function getNextVisibleCount(currentVisibleCount: number, pageSize = VISIBLE_PAGE_SIZE): number {
  return currentVisibleCount + pageSize;
}

export function captureScrollDistance(scrollHeight: number, scrollTop: number): number {
  return scrollHeight - scrollTop;
}

export function restoreScrollTop(scrollHeight: number, savedDistance: number): number {
  return Math.max(0, scrollHeight - savedDistance);
}

export function isScrollAtTail(
  scrollTop: number,
  clientHeight: number,
  scrollHeight: number,
  tolerance = CHAT_SCROLL_TAIL_TOLERANCE,
): boolean {
  return scrollTop + clientHeight >= scrollHeight - tolerance;
}

export function getLiveFollowAttached(
  wasAttached: boolean,
  previousScrollTop: number,
  scrollTop: number,
  clientHeight: number,
  scrollHeight: number,
  reattachTolerance = CHAT_SCROLL_REATTACH_TOLERANCE,
): boolean {
  if (isScrollAtTail(scrollTop, clientHeight, scrollHeight)) return true;
  if (scrollTop < previousScrollTop) return false;
  if (
    !wasAttached
    && scrollTop > previousScrollTop
    && isScrollAtTail(scrollTop, clientHeight, scrollHeight, reattachTolerance)
  ) return true;
  return wasAttached;
}

export function shouldShowScrollToLatest(
  scrollTop: number,
  clientHeight: number,
  scrollHeight: number,
  tolerance = CHAT_SCROLL_TAIL_TOLERANCE,
): boolean {
  if (scrollHeight <= clientHeight) return false;
  return !isScrollAtTail(scrollTop, clientHeight, scrollHeight, tolerance);
}

export function getPromptAnchorSpacerHeight(
  targetTop: number,
  contentEnd: number,
  clientHeight: number,
): number {
  const clampedTargetTop = Math.max(0, targetTop);
  if (clampedTargetTop === 0) return 0;

  return Math.max(0,
    Math.ceil(clampedTargetTop) + clientHeight - Math.max(0, contentEnd),
  );
}
