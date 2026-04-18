const HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;
const RESERVED = new Set([
  "home",
  "explore",
  "notifications",
  "messages",
  "i",
  "settings",
  "search",
  "compose",
  "login",
  "signup"
]);

const JP_FOLLOWING = "\u30d5\u30a9\u30ed\u30fc\u4e2d";
const JP_UNFOLLOW = "\u30d5\u30a9\u30ed\u30fc\u89e3\u9664";
const JP_FOLLOWS_YOU = "\u30d5\u30a9\u30ed\u30fc\u3055\u308c\u3066\u3044\u307e\u3059";
const USER_ROW_SELECTORS = ['[data-testid="UserCell"]', '[data-testid="cellInnerDiv"]'].join(", ");
const LIST_LOADING_SELECTORS = ['[role="progressbar"]', '[data-testid="primaryColumn"] [aria-busy="true"]'].join(", ");
const SCAN_INITIAL_WAIT_MS = 450;
const SCAN_SCROLL_MIN_WAIT_MS = 420;
const SCAN_SCROLL_MAX_EXTRA_WAIT_MS = 780;

let stopNow = false;

function parseHandleFromPath(path: string): string | null {
  const clean = path.split("?")[0].split("#")[0];
  const first = clean.split("/").filter(Boolean)[0];
  if (!first) return null;
  if (!HANDLE_RE.test(first)) return null;
  if (RESERVED.has(first.toLowerCase())) return null;
  return first;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomDelay(minMs: number, maxMs: number): number {
  const min = Math.min(minMs, maxMs);
  const max = Math.max(minMs, maxMs);
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function normalized(text: string): string {
  return text.trim().toLowerCase();
}

function queryUserRows(): HTMLElement[] {
  const strictRows = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="UserCell"]'));
  if (strictRows.length > 0) return strictRows;
  return Array.from(document.querySelectorAll<HTMLElement>(USER_ROW_SELECTORS));
}

async function waitForUserCells(timeoutMs = 15000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (queryUserRows().length > 0) {
      return;
    }
    await sleep(150);
  }
  throw new Error("ユーザー一覧を検出できませんでした。following/followersページを開いて再実行してください。");
}

function isListLoading(): boolean {
  return document.querySelector(LIST_LOADING_SELECTORS) !== null;
}

async function waitAfterScanScroll(): Promise<void> {
  await sleep(SCAN_SCROLL_MIN_WAIT_MS);
  const started = Date.now();
  while (isListLoading() && Date.now() - started < SCAN_SCROLL_MAX_EXTRA_WAIT_MS) {
    await sleep(120);
  }
}

function collectVisibleHandles(out: Set<string>): number {
  const before = out.size;
  const rows = queryUserRows();
  for (const row of rows) {
    const links = row.querySelectorAll<HTMLAnchorElement>('a[href^="/"]');
    links.forEach((a) => {
      const href = a.getAttribute("href");
      if (!href) return;
      const handle = parseHandleFromPath(href);
      if (handle) out.add(handle);
    });
  }

  if (rows.length === 0) {
    const anchors = document.querySelectorAll<HTMLAnchorElement>('a[href^="/"]');
    anchors.forEach((a) => {
      const href = a.getAttribute("href");
      if (!href) return;
      const handle = parseHandleFromPath(href);
      if (handle) out.add(handle);
    });
  }
  return out.size - before;
}

function isFollowedByUserCell(row: HTMLElement): boolean {
  const text = normalized(row.innerText || "");
  return text.includes("follows you") || text.includes(normalized(JP_FOLLOWS_YOU));
}

async function collectNonMutualFromFollowing(targetCount: number): Promise<{ handles: string[]; scannedFollowing: number }> {
  stopNow = false;
  await waitForUserCells();
  const nonMutualHandles = new Set<string>();
  const scannedFollowing = new Set<string>();
  const started = Date.now();
  let lastIncreaseAt = started;
  let noIncreaseRounds = 0;
  let noHeightIncreaseRounds = 0;
  let rounds = 0;
  let lastHeight = 0;

  // 初回ロードが重い場合に備えて、すぐに終了判定へ入らないよう少し待つ
  await sleep(SCAN_INITIAL_WAIT_MS);

  while (
    !stopNow &&
    rounds < 320 &&
    Date.now() - started < 300000 &&
    nonMutualHandles.size < targetCount &&
    (noIncreaseRounds < 30 || noHeightIncreaseRounds < 20 || Date.now() - lastIncreaseAt < 25000 || isListLoading())
  ) {
    const before = nonMutualHandles.size;
    const rows = queryUserRows();
    for (const row of rows) {
      const handle = getHandleFromUserCell(row);
      if (!handle) continue;
      scannedFollowing.add(handle.toLowerCase());
      if (!isFollowedByUserCell(row)) {
        nonMutualHandles.add(handle);
      }
    }
    const delta = nonMutualHandles.size - before;
    if (delta === 0) {
      noIncreaseRounds += 1;
    } else {
      noIncreaseRounds = 0;
      lastIncreaseAt = Date.now();
    }

    const currentHeight = Math.max(
      document.body.scrollHeight,
      document.documentElement.scrollHeight
    );
    if (currentHeight <= lastHeight) {
      noHeightIncreaseRounds += 1;
    } else {
      noHeightIncreaseRounds = 0;
      lastHeight = currentHeight;
    }

    window.scrollBy(0, Math.max(320, Math.floor(window.innerHeight * 0.7)));
    await waitAfterScanScroll();
    rounds += 1;
  }
  window.scrollTo(0, 0);

  if (stopNow) {
    throw new Error("候補取得を停止しました。");
  }

  if (scannedFollowing.size === 0) {
    throw new Error("対象ユーザーを取得できませんでした。ページを再読み込みして再実行してください。");
  }

  return {
    handles: Array.from(nonMutualHandles),
    scannedFollowing: scannedFollowing.size
  };
}

async function scrollUntilUserCell(handle: string): Promise<HTMLElement | null> {
  window.scrollTo(0, 0);
  let noHeightIncreaseRounds = 0;
  let lastHeight = 0;
  for (let i = 0; i < 400; i += 1) {
    const link = document.querySelector<HTMLAnchorElement>(`[data-testid="UserCell"] a[href="/${handle}"]`);
    if (link) {
      const row = link.closest<HTMLElement>('[data-testid="UserCell"]');
      if (row) return row;
    }

    const currentHeight = Math.max(
      document.body.scrollHeight,
      document.documentElement.scrollHeight
    );
    if (currentHeight <= lastHeight) {
      noHeightIncreaseRounds += 1;
    } else {
      noHeightIncreaseRounds = 0;
      lastHeight = currentHeight;
    }
    if (noHeightIncreaseRounds >= 14) {
      break;
    }

    window.scrollBy(0, Math.floor(window.innerHeight * 0.8));
    await sleep(700);
    if (stopNow) return null;
  }
  return null;
}

function findUnfollowButton(row: HTMLElement): HTMLButtonElement | null {
  const explicit = row.querySelector<HTMLButtonElement>('button[data-testid$="-unfollow"]');
  if (explicit) return explicit;

  const buttons = row.querySelectorAll<HTMLButtonElement>("button");
  for (const button of buttons) {
    const text = normalized(button.innerText || "");
    const aria = normalized(button.getAttribute("aria-label") || "");
    if (
      text.includes("following") ||
      text.includes(JP_FOLLOWING) ||
      aria.includes("following") ||
      aria.includes(JP_FOLLOWING)
    ) {
      return button;
    }
  }
  return null;
}

function getHandleFromUserCell(row: HTMLElement): string | null {
  const links = row.querySelectorAll<HTMLAnchorElement>('a[href^="/"]');
  for (const link of links) {
    const href = link.getAttribute("href");
    if (!href) continue;
    const handle = parseHandleFromPath(href);
    if (handle) return handle;
  }
  return null;
}

async function clickConfirmIfPresent(): Promise<boolean> {
  await sleep(300);
  const confirm =
    document.querySelector<HTMLButtonElement>('[data-testid="confirmationSheetConfirm"]') ??
    Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((b) => {
      const txt = normalized(b.innerText || "");
      const aria = normalized(b.getAttribute("aria-label") || "");
      return txt.includes("unfollow") || txt.includes(JP_UNFOLLOW) || aria.includes("unfollow") || aria.includes(JP_UNFOLLOW);
    });
  if (confirm) {
    confirm.click();
    return true;
  }
  return false;
}

async function unfollowHandles(handles: string[], minDelayMs: number, maxDelayMs: number) {
  type FailureReason =
    | "unfollow_button_not_found"
    | "unfollow_button_disabled"
    | "click_unfollow_failed"
    | "left_unprocessed";

  stopNow = false;
  let processed = 0;
  let succeeded = 0;
  let failed = 0;
  const failureReasonCounts: Record<FailureReason, number> = {
    unfollow_button_not_found: 0,
    unfollow_button_disabled: 0,
    click_unfollow_failed: 0,
    left_unprocessed: 0
  };
  const failureSamples: string[] = [];
  const pending = new Set(handles.map((h) => h.toLowerCase()));
  const failureRetries = new Map<string, number>();
  const lastTransientReason = new Map<string, FailureReason>();
  const MAX_TRANSIENT_RETRIES = 3;
  let noProgressRounds = 0;
  let noHeightIncreaseRounds = 0;
  let lastHeight = 0;

  window.scrollTo(0, 0);
  await sleep(600);

  const addFailure = (reason: FailureReason, handle: string, detail?: string): void => {
    failed += 1;
    failureReasonCounts[reason] += 1;
    if (failureSamples.length < 8) {
      const line = detail ? `@${handle}: ${reason} (${detail})` : `@${handle}: ${reason}`;
      failureSamples.push(line);
    }
  };

  const markTransientFailure = (reason: FailureReason, key: string): boolean => {
    const next = (failureRetries.get(key) ?? 0) + 1;
    failureRetries.set(key, next);
    lastTransientReason.set(key, reason);
    return next >= MAX_TRANSIENT_RETRIES;
  };

  for (let round = 0; round < 600; round += 1) {
    if (stopNow || pending.size === 0) break;

    let roundProgress = 0;
    const handledInRound = new Set<string>();
    const rows = queryUserRows();
    for (const row of rows) {
      if (stopNow || pending.size === 0) break;

      const handle = getHandleFromUserCell(row);
      if (!handle) continue;
      const key = handle.toLowerCase();
      if (!pending.has(key) || handledInRound.has(key)) continue;
      handledInRound.add(key);

      const button = findUnfollowButton(row);
      if (!button) {
        if (markTransientFailure("unfollow_button_not_found", key)) {
          pending.delete(key);
          processed += 1;
          addFailure("unfollow_button_not_found", handle);
          await chrome.runtime.sendMessage({ type: "PROGRESS", processed, succeeded, failed });
          roundProgress += 1;
        }
        continue;
      }
      if (button.disabled) {
        if (markTransientFailure("unfollow_button_disabled", key)) {
          pending.delete(key);
          processed += 1;
          addFailure("unfollow_button_disabled", handle);
          await chrome.runtime.sendMessage({ type: "PROGRESS", processed, succeeded, failed });
          roundProgress += 1;
        }
        continue;
      }

      try {
        button.click();
        await clickConfirmIfPresent();
        failureRetries.delete(key);
        lastTransientReason.delete(key);
        succeeded += 1;
        processed += 1;
        pending.delete(key);
        roundProgress += 1;
        await chrome.runtime.sendMessage({ type: "PROGRESS", processed, succeeded, failed });
      } catch (error) {
        const detail = error instanceof Error ? error.message : "unknown";
        pending.delete(key);
        processed += 1;
        addFailure("click_unfollow_failed", handle, detail);
        await chrome.runtime.sendMessage({ type: "PROGRESS", processed, succeeded, failed });
        roundProgress += 1;
        continue;
      }

      const waitMs = randomDelay(minDelayMs, maxDelayMs);
      await sleep(waitMs);
    }

    if (roundProgress === 0) {
      noProgressRounds += 1;
    } else {
      noProgressRounds = 0;
    }

    const currentHeight = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
    if (currentHeight <= lastHeight) {
      noHeightIncreaseRounds += 1;
    } else {
      noHeightIncreaseRounds = 0;
      lastHeight = currentHeight;
    }

    if (noProgressRounds >= 20 && noHeightIncreaseRounds >= 14) {
      break;
    }

    window.scrollBy(0, Math.floor(window.innerHeight * 0.9));
    await sleep(900);
  }

  if (!stopNow && pending.size > 0) {
    for (const key of pending) {
      processed += 1;
      const reason = lastTransientReason.get(key) ?? "left_unprocessed";
      addFailure(reason, key);
    }
    await chrome.runtime.sendMessage({ type: "PROGRESS", processed, succeeded, failed });
  }

  return {
    processed,
    succeeded,
    failed,
    failureReasonCounts,
    failureSamples,
    stopped: stopNow
  };
}

function extractSelfHandle(): string | null {
  const fromPath = parseHandleFromPath(location.pathname);
  if (fromPath) return fromPath;

  const profileLink = document.querySelector<HTMLAnchorElement>('a[data-testid="AppTabBar_Profile_Link"]');
  if (profileLink) {
    const href = profileLink.getAttribute("href");
    if (href) {
      return parseHandleFromPath(href);
    }
  }

  const possible = document.querySelectorAll<HTMLAnchorElement>('a[href^="/"]');
  for (const a of possible) {
    const href = a.getAttribute("href");
    if (!href) continue;
    const handle = parseHandleFromPath(href);
    if (!handle) continue;
    if (a.getAttribute("data-testid")?.includes("Profile")) {
      return handle;
    }
  }
  return null;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    if (message?.type === "PING") {
      sendResponse({ ok: true });
      return;
    }

    if (message?.type === "EXTRACT_SELF_HANDLE") {
      sendResponse({ handle: extractSelfHandle() });
      return;
    }

    if (message?.type === "COLLECT_NON_MUTUAL_FROM_FOLLOWING") {
      const requested = Number(message.targetCount);
      const targetCount = Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : 100;
      const result = await collectNonMutualFromFollowing(targetCount);
      sendResponse(result);
      return;
    }

    if (message?.type === "UNFOLLOW_HANDLES") {
      const handles = Array.isArray(message.handles) ? (message.handles as string[]) : [];
      const minDelayMs = Number(message.minDelayMs) || 5000;
      const maxDelayMs = Number(message.maxDelayMs) || 15000;
      const result = await unfollowHandles(handles, minDelayMs, maxDelayMs);
      sendResponse(result);
      return;
    }

    if (message?.type === "STOP_NOW") {
      stopNow = true;
      sendResponse({ ok: true });
      return;
    }

    sendResponse({ ok: false, error: "Unknown message" });
  })().catch((error: unknown) => {
    const messageText = error instanceof Error ? error.message : "Unknown error";
    sendResponse({ ok: false, error: messageText });
  });
  return true;
});
