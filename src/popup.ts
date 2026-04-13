import type { RuntimeState } from "./types";

const limitInput = document.getElementById("limitInput") as HTMLInputElement;
const scanBtn = document.getElementById("scanBtn") as HTMLButtonElement;
const startBtn = document.getElementById("startBtn") as HTMLButtonElement;
const stopBtn = document.getElementById("stopBtn") as HTMLButtonElement;
const statusEl = document.getElementById("status") as HTMLDivElement;
const startWrap = document.getElementById("startWrap") as HTMLDivElement;
const stopWrap = document.getElementById("stopWrap") as HTMLDivElement;

function setBusy(button: HTMLButtonElement, busy: boolean, busyLabel: string, defaultLabel: string): void {
  button.disabled = busy;
  button.textContent = busy ? busyLabel : defaultLabel;
}

function setStatus(text: string): void {
  statusEl.textContent = text;
}

function render(state: RuntimeState): void {
  setStatus(state.message);
  const isEditingLimit = document.activeElement === limitInput;
  if (!isEditingLimit) {
    limitInput.value = String(state.limit || 1000);
  }

  startWrap.style.display = state.phase === "ready" ? "block" : "none";
  stopWrap.style.display =
    state.phase === "scanning" || state.phase === "running" || state.phase === "stopping"
      ? "block"
      : "none";

  const disableScan = state.phase === "scanning" || state.phase === "running" || state.phase === "stopping";
  scanBtn.disabled = disableScan;
  limitInput.disabled = disableScan;
}

async function send<T>(payload: unknown): Promise<T> {
  return (await chrome.runtime.sendMessage(payload)) as T;
}

async function refreshState(): Promise<void> {
  const result = await send<{ state: RuntimeState }>({ type: "GET_STATE" });
  render(result.state);
}

scanBtn.addEventListener("click", async () => {
  const limit = Math.max(1, Math.floor(Number(limitInput.value) || 1000));
  limitInput.value = String(limit);
  setBusy(scanBtn, true, "取得中...", "候補件数を取得");
  try {
    const response = await send<{ ok: boolean; error?: string; state?: RuntimeState }>({
      type: "START_SCAN",
      limit
    });
    if (!response.ok) {
      setStatus(response.error ?? "候補取得に失敗しました。");
      return;
    }
    if (response.state) render(response.state);
  } finally {
    setBusy(scanBtn, false, "取得中...", "候補件数を取得");
  }
});

startBtn.addEventListener("click", async () => {
  setBusy(startBtn, true, "開始中...", "この内容で解除開始");
  try {
    const response = await send<{ ok: boolean; error?: string; state?: RuntimeState }>({
      type: "START_UNFOLLOW"
    });
    if (!response.ok) {
      setStatus(response.error ?? "開始に失敗しました。");
      return;
    }
    if (response.state) render(response.state);
  } finally {
    setBusy(startBtn, false, "開始中...", "この内容で解除開始");
  }
});

stopBtn.addEventListener("click", async () => {
  setBusy(stopBtn, true, "停止中...", "停止");
  try {
    await send({ type: "STOP_UNFOLLOW" });
    await refreshState();
  } finally {
    setBusy(stopBtn, false, "停止中...", "停止");
  }
});

void refreshState();
setInterval(() => {
  void refreshState();
}, 1000);
