import type { CollectResult, RuntimeState } from "./types";

const DEFAULT_LIMIT = 1000;
const MIN_DELAY_MS = 3000;
const MAX_DELAY_MS = 8000;
const X_ORIGIN = "https://x.com";
const STATE_KEY = "runtimeState";
const CANDIDATES_KEY = "runtimeCandidates";
const ACTION_TAB_ID_KEY = "runtimeActionTabId";

const RESERVED_PATHS = new Set([
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

function defaultState(): RuntimeState {
  return {
    phase: "idle",
    message: "\u5f85\u6a5f\u4e2d\u3067\u3059\u3002",
    limit: DEFAULT_LIMIT,
    accountHandle: null,
    candidateCount: 0,
    targetCount: 0,
    followingCount: 0,
    followerCount: 0,
    processed: 0,
    succeeded: 0,
    failed: 0,
    stopRequested: false,
    startedAt: null,
    finishedAt: null
  };
}

let state: RuntimeState = defaultState();
let candidates: string[] = [];
let actionTabId: number | null = null;
let initPromise: Promise<void> | null = null;

async function persistRuntime(): Promise<void> {
  await chrome.storage.local.set({
    [STATE_KEY]: state,
    [CANDIDATES_KEY]: candidates,
    [ACTION_TAB_ID_KEY]: actionTabId
  });
}

function setState(patch: Partial<RuntimeState>): void {
  state = { ...state, ...patch };
  void persistRuntime();
}

function setCandidates(next: string[]): void {
  candidates = next;
  void persistRuntime();
}

function setActionTabId(tabId: number | null): void {
  actionTabId = tabId;
  void persistRuntime();
}

async function ensureInitialized(): Promise<void> {
  if (initPromise) {
    await initPromise;
    return;
  }

  initPromise = (async () => {
    const saved = await chrome.storage.local.get([STATE_KEY, CANDIDATES_KEY, ACTION_TAB_ID_KEY]);
    if (saved[STATE_KEY]) {
      state = { ...defaultState(), ...(saved[STATE_KEY] as Partial<RuntimeState>) };
    }
    if (Array.isArray(saved[CANDIDATES_KEY])) {
      candidates = (saved[CANDIDATES_KEY] as unknown[])
        .filter((x): x is string => typeof x === "string")
        .map((x) => x.trim())
        .filter(Boolean);
    }
    if (typeof saved[ACTION_TAB_ID_KEY] === "number") {
      actionTabId = saved[ACTION_TAB_ID_KEY] as number;
    }
  })();

  await initPromise;
}

function isLikelyHandle(segment: string): boolean {
  return /^[A-Za-z0-9_]{1,15}$/.test(segment) && !RESERVED_PATHS.has(segment.toLowerCase());
}

function getHandleFromUrl(url?: string): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    const first = parsed.pathname.split("/").filter(Boolean)[0];
    if (first && isLikelyHandle(first)) {
      return first;
    }
    return null;
  } catch {
    return null;
  }
}

async function getActiveTab(): Promise<chrome.tabs.Tab> {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab?.id) {
    throw new Error("\u30a2\u30af\u30c6\u30a3\u30d6\u30bf\u30d6\u3092\u53d6\u5f97\u3067\u304d\u307e\u305b\u3093\u3002");
  }
  return tab;
}

async function waitTabComplete(tabId: number, timeoutMs = 30000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === "complete") return;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error("\u30bf\u30d6\u306e\u8aad\u307f\u8fbc\u307f\u304c\u30bf\u30a4\u30e0\u30a2\u30a6\u30c8\u3057\u307e\u3057\u305f\u3002");
}

function isReceivingEndMissing(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.message.includes("Receiving end does not exist");
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForContentScript(tabId: number, timeoutMs = 15000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      await chrome.tabs.sendMessage(tabId, { type: "PING" });
      return;
    } catch (error) {
      if (!isReceivingEndMissing(error)) {
        throw error;
      }
      await delay(250);
    }
  }
  throw new Error("ページ準備中です。タブの読み込み完了後に再実行してください。");
}

async function sendMessageToTab<T>(tabId: number, message: unknown): Promise<T> {
  const maxRetry = 3;
  let lastError: unknown = null;

  for (let i = 0; i < maxRetry; i += 1) {
    try {
      return (await chrome.tabs.sendMessage(tabId, message)) as T;
    } catch (error) {
      lastError = error;
      if (!isReceivingEndMissing(error)) {
        throw error;
      }
      await waitForContentScript(tabId);
    }
  }

  throw lastError instanceof Error ? lastError : new Error("タブとの通信に失敗しました。");
}

async function ensureXTab(url: string): Promise<number> {
  const tab = await chrome.tabs.create({ url, active: false });
  if (!tab.id) throw new Error("\u51e6\u7406\u7528\u30bf\u30d6\u3092\u4f5c\u6210\u3067\u304d\u307e\u305b\u3093\u3067\u3057\u305f\u3002");
  try {
    await chrome.tabs.update(tab.id, { autoDiscardable: false });
  } catch {
    // best effort
  }
  await waitTabComplete(tab.id);
  await waitForContentScript(tab.id);
  return tab.id;
}

async function resolveHandle(currentTab: chrome.tabs.Tab): Promise<string> {
  if (!currentTab.id) {
    throw new Error("\u30bf\u30d6ID\u304c\u3042\u308a\u307e\u305b\u3093\u3002");
  }

  const result = await sendMessageToTab<{ handle: string | null }>(currentTab.id, {
    type: "EXTRACT_SELF_HANDLE"
  });

  if (!result?.handle) {
    const fromUrl = getHandleFromUrl(currentTab.url);
    if (fromUrl) {
      return fromUrl;
    }
    throw new Error("\u30e6\u30fc\u30b6\u30fcID\u3092\u7279\u5b9a\u3067\u304d\u307e\u305b\u3093\u3002x.com\u306e\u30ed\u30b0\u30a4\u30f3\u6e08\u307f\u30bf\u30d6\u3067\u5b9f\u884c\u3057\u3066\u304f\u3060\u3055\u3044\u3002");
  }

  return result.handle;
}

async function collectHandlesOnOnce(url: string): Promise<CollectResult> {
  const tabId = await ensureXTab(url);
  try {
    const result = await sendMessageToTab<CollectResult>(tabId, {
      type: "COLLECT_HANDLES",
      targetCount: state.limit
    });
    return result;
  } finally {
    await chrome.tabs.remove(tabId);
  }
}

async function collectHandlesOn(url: string): Promise<CollectResult> {
  let best: CollectResult = { handles: [] };
  for (let i = 0; i < 2; i += 1) {
    const current = await collectHandlesOnOnce(url);
    if (current.handles.length > best.handles.length) {
      best = current;
    }
    if (best.handles.length >= state.limit) {
      break;
    }
  }
  return best;
}

async function runScan(limit: number): Promise<void> {
  setState({
    phase: "scanning",
    message: "\u5019\u88dc\u4ef6\u6570\u3092\u53d6\u5f97\u3057\u3066\u3044\u307e\u3059...",
    limit,
    accountHandle: null,
    candidateCount: 0,
    targetCount: 0,
    followingCount: 0,
    followerCount: 0,
    processed: 0,
    succeeded: 0,
    failed: 0,
    stopRequested: false,
    startedAt: null,
    finishedAt: null
  });
  setCandidates([]);
  setActionTabId(null);

  const activeTab = await getActiveTab();
  if (!activeTab.url?.startsWith("https://x.com/") && !activeTab.url?.startsWith("https://twitter.com/")) {
    throw new Error("x.com\u306e\u30bf\u30d6\u3092\u958b\u3044\u3066\u5b9f\u884c\u3057\u3066\u304f\u3060\u3055\u3044\u3002");
  }

  const handle = await resolveHandle(activeTab);
  const followingUrl = `${X_ORIGIN}/${handle}/following`;
  const followersUrl = `${X_ORIGIN}/${handle}/followers`;

  const [following, followers] = await Promise.all([collectHandlesOn(followingUrl), collectHandlesOn(followersUrl)]);

  const followerSet = new Set(followers.handles.map((h) => h.toLowerCase()));
  const unilateral = following.handles.filter((h) => !followerSet.has(h.toLowerCase()));
  const limited = unilateral.slice(0, limit);

  setCandidates(limited);
  setState({
    phase: "ready",
    accountHandle: handle,
    candidateCount: unilateral.length,
    targetCount: limited.length,
    followingCount: following.handles.length,
    followerCount: followers.handles.length,
    message:
      `\u5bfe\u8c61 @${handle}\n` +
      `\u7247\u601d\u3044\u30d5\u30a9\u30ed\u30ef\u30fc\u3092\u89e3\u9664\u3057\u307e\u3059\u304b\uff1f\n` +
      `\u4ef6\u6570 ${unilateral.length} \u4ef6 (\u4e0a\u9650 ${limit})\n` +
      `following ${following.handles.length} / followers ${followers.handles.length}`
  });
}

async function ensureActionTab(handle: string): Promise<number> {
  if (actionTabId !== null) {
    try {
      await waitTabComplete(actionTabId, 1000);
      return actionTabId;
    } catch {
      setActionTabId(null);
    }
  }

  const followingUrl = `${X_ORIGIN}/${handle}/following`;
  const newTabId = await ensureXTab(followingUrl);
  setActionTabId(newTabId);
  return newTabId;
}

async function runUnfollow(): Promise<void> {
  if (state.phase !== "ready") {
    throw new Error("\u5019\u88dc\u4ef6\u6570\u3092\u53d6\u5f97\u3057\u3066\u304b\u3089\u958b\u59cb\u3057\u3066\u304f\u3060\u3055\u3044\u3002");
  }

  const handle = state.accountHandle;
  if (!handle) {
    throw new Error("\u30a2\u30ab\u30a6\u30f3\u30c8\u60c5\u5831\u304c\u5931\u308f\u308c\u3066\u3044\u307e\u3059\u3002\u3082\u3046\u4e00\u5ea6\u5019\u88dc\u53d6\u5f97\u3092\u5b9f\u884c\u3057\u3066\u304f\u3060\u3055\u3044\u3002");
  }

  const targetCount = Math.min(state.targetCount, candidates.length);
  if (targetCount <= 0) {
    throw new Error("\u89e3\u9664\u5bfe\u8c61\u304c\u3042\u308a\u307e\u305b\u3093\u3002");
  }

  const tabId = await ensureActionTab(handle);

  setState({
    phase: "running",
    message: `\u89e3\u9664\u4e2d 0/${targetCount}`,
    processed: 0,
    succeeded: 0,
    failed: 0,
    stopRequested: false,
    startedAt: Date.now(),
    finishedAt: null,
    targetCount
  });

  const result = await sendMessageToTab<{
    processed: number;
    succeeded: number;
    failed: number;
    stopped: boolean;
  }>(tabId, {
    type: "UNFOLLOW_HANDLES",
    handles: candidates.slice(0, targetCount),
    minDelayMs: MIN_DELAY_MS,
    maxDelayMs: MAX_DELAY_MS
  });

  if (result.stopped) {
    setState({
      phase: "done",
      message: `\u505c\u6b62\u3057\u307e\u3057\u305f\u3002\u9032\u6357 ${result.processed}/${targetCount}`,
      processed: result.processed,
      succeeded: result.succeeded,
      failed: result.failed,
      finishedAt: Date.now()
    });
  } else {
    setState({
      phase: "done",
      message: `\u5b8c\u4e86\u3057\u307e\u3057\u305f\u3002${result.succeeded}\u4ef6\u89e3\u9664 / \u5931\u6557${result.failed}\u4ef6`,
      processed: result.processed,
      succeeded: result.succeeded,
      failed: result.failed,
      finishedAt: Date.now()
    });
  }
}

chrome.tabs.onRemoved.addListener((tabId) => {
  if (actionTabId === tabId) {
    setActionTabId(null);
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    await ensureInitialized();

    switch (message?.type) {
      case "GET_STATE": {
        sendResponse({ state });
        return;
      }
      case "START_SCAN": {
        const limit = Number(message.limit);
        const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : DEFAULT_LIMIT;
        await runScan(safeLimit);
        sendResponse({ ok: true, state });
        return;
      }
      case "START_UNFOLLOW": {
        await runUnfollow();
        sendResponse({ ok: true, state });
        return;
      }
      case "STOP_UNFOLLOW": {
        setState({
          phase: "stopping",
          stopRequested: true,
          message: "\u505c\u6b62\u8981\u6c42\u3092\u9001\u4fe1\u3057\u307e\u3057\u305f..."
        });
        if (actionTabId !== null) {
          try {
            await sendMessageToTab(actionTabId, { type: "STOP_NOW" });
          } catch {
            // if tab is already closed, final state will be set by current flow
          }
        }
        sendResponse({ ok: true, state });
        return;
      }
      case "PROGRESS": {
        const processed = Number(message.processed) || 0;
        const succeeded = Number(message.succeeded) || 0;
        const failed = Number(message.failed) || 0;
        setState({
          phase: "running",
          processed,
          succeeded,
          failed,
          message: `\u89e3\u9664\u4e2d ${processed}/${state.targetCount}`
        });
        sendResponse({ ok: true });
        return;
      }
      default:
        sendResponse({ ok: false, error: "Unknown message" });
    }
  })().catch((err: unknown) => {
    const messageText = err instanceof Error ? err.message : "Unknown error";
    setState({
      phase: "error",
      message: `\u30a8\u30e9\u30fc: ${messageText}`,
      finishedAt: Date.now()
    });
    sendResponse({ ok: false, error: messageText, state });
  });

  return true;
});
