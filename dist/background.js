const DEFAULT_LIMIT = 1000;
const MIN_DELAY_MS = 3000;
const MAX_DELAY_MS = 8000;
const LIST_COLLECTION_TIMEOUT_MS = 420000;
const X_ORIGIN = "https://x.com";
const STATE_KEY = "runtimeState";
const CANDIDATES_KEY = "runtimeCandidates";
const ACTION_TAB_ID_KEY = "runtimeActionTabId";
const FOLLOWING_HANDLES_KEY = "runtimeFollowingHandles";
const FOLLOWER_HANDLES_KEY = "runtimeFollowerHandles";
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
function defaultState() {
    return {
        phase: "idle",
        message: "\u5f85\u6a5f\u4e2d\u3067\u3059\u3002",
        limit: DEFAULT_LIMIT,
        accountHandle: null,
        previewHandles: [],
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
let state = defaultState();
let candidates = [];
let actionTabId = null;
let followingHandles = [];
let followerHandles = [];
let scanTabId = null;
let scanStopRequested = false;
let initPromise = null;
async function persistRuntime() {
    await chrome.storage.local.set({
        [STATE_KEY]: state,
        [CANDIDATES_KEY]: candidates,
        [ACTION_TAB_ID_KEY]: actionTabId,
        [FOLLOWING_HANDLES_KEY]: followingHandles,
        [FOLLOWER_HANDLES_KEY]: followerHandles
    });
}
function setState(patch) {
    state = { ...state, ...patch };
    void persistRuntime();
}
function setCandidates(next) {
    candidates = next;
    void persistRuntime();
}
function setActionTabId(tabId) {
    actionTabId = tabId;
    void persistRuntime();
}
function setCollectedHandles(nextFollowing, nextFollowers) {
    followingHandles = nextFollowing;
    followerHandles = nextFollowers;
    void persistRuntime();
}
function ensureNotScanStopped() {
    if (scanStopRequested) {
        throw new Error("候補取得を停止しました。");
    }
}
async function ensureInitialized() {
    if (initPromise) {
        await initPromise;
        return;
    }
    initPromise = (async () => {
        const saved = await chrome.storage.local.get([
            STATE_KEY,
            CANDIDATES_KEY,
            ACTION_TAB_ID_KEY,
            FOLLOWING_HANDLES_KEY,
            FOLLOWER_HANDLES_KEY
        ]);
        if (saved[STATE_KEY]) {
            state = { ...defaultState(), ...saved[STATE_KEY] };
        }
        if (Array.isArray(saved[CANDIDATES_KEY])) {
            candidates = saved[CANDIDATES_KEY]
                .filter((x) => typeof x === "string")
                .map((x) => x.trim())
                .filter(Boolean);
        }
        if (typeof saved[ACTION_TAB_ID_KEY] === "number") {
            actionTabId = saved[ACTION_TAB_ID_KEY];
        }
        if (Array.isArray(saved[FOLLOWING_HANDLES_KEY])) {
            followingHandles = saved[FOLLOWING_HANDLES_KEY]
                .filter((x) => typeof x === "string")
                .map((x) => x.trim())
                .filter(Boolean);
        }
        if (Array.isArray(saved[FOLLOWER_HANDLES_KEY])) {
            followerHandles = saved[FOLLOWER_HANDLES_KEY]
                .filter((x) => typeof x === "string")
                .map((x) => x.trim())
                .filter(Boolean);
        }
    })();
    await initPromise;
}
function isLikelyHandle(segment) {
    return /^[A-Za-z0-9_]{1,15}$/.test(segment) && !RESERVED_PATHS.has(segment.toLowerCase());
}
function getHandleFromUrl(url) {
    if (!url)
        return null;
    try {
        const parsed = new URL(url);
        const first = parsed.pathname.split("/").filter(Boolean)[0];
        if (first && isLikelyHandle(first)) {
            return first;
        }
        return null;
    }
    catch {
        return null;
    }
}
async function getActiveTab() {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0];
    if (!tab?.id) {
        throw new Error("\u30a2\u30af\u30c6\u30a3\u30d6\u30bf\u30d6\u3092\u53d6\u5f97\u3067\u304d\u307e\u305b\u3093\u3002");
    }
    return tab;
}
async function waitTabComplete(tabId, timeoutMs = 30000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        const tab = await chrome.tabs.get(tabId);
        if (tab.status === "complete")
            return;
        await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error("\u30bf\u30d6\u306e\u8aad\u307f\u8fbc\u307f\u304c\u30bf\u30a4\u30e0\u30a2\u30a6\u30c8\u3057\u307e\u3057\u305f\u3002");
}
function isReceivingEndMissing(error) {
    if (!(error instanceof Error))
        return false;
    return error.message.includes("Receiving end does not exist");
}
async function delay(ms) {
    await new Promise((resolve) => setTimeout(resolve, ms));
}
function withTimeout(promise, timeoutMs, label) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(new Error(`${label} がタイムアウトしました。ページを再読み込みして再実行してください。`));
        }, timeoutMs);
        promise
            .then((value) => {
            clearTimeout(timer);
            resolve(value);
        })
            .catch((error) => {
            clearTimeout(timer);
            reject(error);
        });
    });
}
async function waitForContentScript(tabId, timeoutMs = 15000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        try {
            await chrome.tabs.sendMessage(tabId, { type: "PING" });
            return;
        }
        catch (error) {
            if (!isReceivingEndMissing(error)) {
                throw error;
            }
            await delay(250);
        }
    }
    throw new Error("ページ準備中です。タブの読み込み完了後に再実行してください。");
}
async function sendMessageToTab(tabId, message) {
    const maxRetry = 3;
    let lastError = null;
    for (let i = 0; i < maxRetry; i += 1) {
        try {
            return (await chrome.tabs.sendMessage(tabId, message));
        }
        catch (error) {
            lastError = error;
            if (!isReceivingEndMissing(error)) {
                throw error;
            }
            await waitForContentScript(tabId);
        }
    }
    throw lastError instanceof Error ? lastError : new Error("タブとの通信に失敗しました。");
}
async function ensureXTab(url) {
    const tab = await chrome.tabs.create({ url, active: false });
    if (!tab.id)
        throw new Error("\u51e6\u7406\u7528\u30bf\u30d6\u3092\u4f5c\u6210\u3067\u304d\u307e\u305b\u3093\u3067\u3057\u305f\u3002");
    try {
        await chrome.tabs.update(tab.id, { autoDiscardable: false });
    }
    catch {
        // best effort
    }
    try {
        await waitTabComplete(tab.id, 20000);
    }
    catch {
        // x.com は読み込み状態が長く続くことがあるため、content script 到達判定を優先
    }
    await waitForContentScript(tab.id);
    return tab.id;
}
async function resolveHandle(currentTab) {
    if (!currentTab.id) {
        throw new Error("\u30bf\u30d6ID\u304c\u3042\u308a\u307e\u305b\u3093\u3002");
    }
    const result = await sendMessageToTab(currentTab.id, {
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
async function collectHandlesOnOnce(url) {
    ensureNotScanStopped();
    const tabId = await ensureXTab(url);
    scanTabId = tabId;
    try {
        const result = await withTimeout(sendMessageToTab(tabId, {
            type: "COLLECT_NON_MUTUAL_FROM_FOLLOWING",
            targetCount: state.limit
        }), LIST_COLLECTION_TIMEOUT_MS, "候補取得");
        return result;
    }
    finally {
        scanTabId = null;
        try {
            await chrome.tabs.remove(tabId);
        }
        catch {
            // already closed
        }
    }
}
function mergeHandles(base, next) {
    const merged = [...base];
    const seen = new Set(base.map((h) => h.toLowerCase()));
    let added = 0;
    for (const handle of next) {
        const key = handle.toLowerCase();
        if (seen.has(key))
            continue;
        seen.add(key);
        merged.push(handle);
        added += 1;
    }
    return { merged, added };
}
async function collectHandlesOn(url, desiredMinCount) {
    ensureNotScanStopped();
    let merged = [];
    let scannedFollowing = 0;
    let noGrowthRounds = 0;
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        ensureNotScanStopped();
        setState({
            message: `\u5bfe\u8c61 @${state.accountHandle ?? "-"}\nfollowing\u4e00\u89a7\u3092\u8d70\u67fb\u4e2d... (${attempt}/${maxAttempts})`
        });
        const current = await collectHandlesOnOnce(url);
        const result = mergeHandles(merged, current.handles);
        merged = result.merged;
        scannedFollowing = Math.max(scannedFollowing, current.scannedFollowing);
        if (result.added === 0) {
            noGrowthRounds += 1;
        }
        else {
            noGrowthRounds = 0;
        }
        if (merged.length >= desiredMinCount) {
            break;
        }
        if (noGrowthRounds >= 2) {
            break;
        }
    }
    return { handles: merged, scannedFollowing };
}
async function runScan(limit) {
    scanStopRequested = false;
    setState({
        phase: "scanning",
        message: "\u5019\u88dc\u4ef6\u6570\u3092\u53d6\u5f97\u3057\u3066\u3044\u307e\u3059...",
        limit,
        accountHandle: null,
        previewHandles: [],
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
    setCollectedHandles([], []);
    setActionTabId(null);
    const activeTab = await getActiveTab();
    if (!activeTab.url?.startsWith("https://x.com/") && !activeTab.url?.startsWith("https://twitter.com/")) {
        throw new Error("x.com\u306e\u30bf\u30d6\u3092\u958b\u3044\u3066\u5b9f\u884c\u3057\u3066\u304f\u3060\u3055\u3044\u3002");
    }
    const handle = await resolveHandle(activeTab);
    const followingUrl = `${X_ORIGIN}/${handle}/following`;
    setState({ accountHandle: handle, message: `\u5bfe\u8c61 @${handle}\nfollowing\u4e00\u89a7\u3092\u8d70\u67fb\u4e2d...` });
    const following = await collectHandlesOn(followingUrl, limit);
    ensureNotScanStopped();
    setCollectedHandles([], []);
    const unilateral = following.handles;
    const limited = unilateral.slice(0, limit);
    setCandidates(limited);
    setState({
        phase: "ready",
        accountHandle: handle,
        previewHandles: limited,
        candidateCount: unilateral.length,
        targetCount: limited.length,
        followingCount: following.scannedFollowing,
        followerCount: 0,
        message: `\u5bfe\u8c61 @${handle}
following\u5185\u3067\u300c\u30d5\u30a9\u30ed\u30fc\u3055\u308c\u3066\u3044\u307e\u3059\u300d\u304c\u7121\u3044\u5019\u88dc\u3092\u89e3\u9664\u3057\u307e\u3059\u304b\uff1f
\u4ef6\u6570 ${unilateral.length} \u4ef6 (\u4e0a\u9650 ${limit})
\u8d70\u67fb following ${following.scannedFollowing} \u4ef6`
    });
}
async function ensureActionTab(handle) {
    if (actionTabId !== null) {
        try {
            await waitTabComplete(actionTabId, 1000);
            return actionTabId;
        }
        catch {
            setActionTabId(null);
        }
    }
    const followingUrl = `${X_ORIGIN}/${handle}/following`;
    const newTabId = await ensureXTab(followingUrl);
    setActionTabId(newTabId);
    return newTabId;
}
async function runUnfollow() {
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
    const result = await sendMessageToTab(tabId, {
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
    }
    else {
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
                if (state.phase === "scanning") {
                    scanStopRequested = true;
                    setState({
                        phase: "stopping",
                        stopRequested: true,
                        message: "\u5019\u88dc\u53d6\u5f97\u306e\u505c\u6b62\u8981\u6c42\u3092\u9001\u4fe1\u3057\u307e\u3057\u305f..."
                    });
                    if (scanTabId !== null) {
                        try {
                            await sendMessageToTab(scanTabId, { type: "STOP_NOW" });
                        }
                        catch {
                            // ignore if tab is already closing
                        }
                    }
                }
                else {
                    setState({
                        phase: "stopping",
                        stopRequested: true,
                        message: "\u505c\u6b62\u8981\u6c42\u3092\u9001\u4fe1\u3057\u307e\u3057\u305f..."
                    });
                    if (actionTabId !== null) {
                        try {
                            await sendMessageToTab(actionTabId, { type: "STOP_NOW" });
                        }
                        catch {
                            // if tab is already closed, final state will be set by current flow
                        }
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
    })().catch((err) => {
        const messageText = err instanceof Error ? err.message : "Unknown error";
        const isStopped = messageText.includes("停止しました");
        if (isStopped) {
            setState({
                phase: "done",
                message: messageText,
                stopRequested: false,
                finishedAt: Date.now()
            });
            sendResponse({ ok: true, state });
            return;
        }
        setState({
            phase: "error",
            message: `\u30a8\u30e9\u30fc: ${messageText}`,
            finishedAt: Date.now()
        });
        sendResponse({ ok: false, error: messageText, state });
    });
    return true;
});
export {};
