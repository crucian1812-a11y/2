// YTBrain: копит лог просмотров в chrome.storage.local (ключ watchLog).
// Дедупликация: одно видео учитывается один раз за календарный день.

const STORAGE_KEY = "watchLog";

async function getLog() {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  return data[STORAGE_KEY] || [];
}

async function setLog(log) {
  await chrome.storage.local.set({ [STORAGE_KEY]: log });
}

function dayOf(iso) {
  return (iso || "").slice(0, 10);
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    if (message.type === "log" && message.entry && message.entry.videoId) {
      const log = await getLog();
      const entry = message.entry;
      const duplicate = log.some(
        (e) =>
          e.videoId === entry.videoId &&
          dayOf(e.watchedAt) === dayOf(entry.watchedAt)
      );
      if (!duplicate) {
        log.push(entry);
        await setLog(log);
      }
      sendResponse({ ok: true, count: log.length });
    } else if (message.type === "getCount") {
      const log = await getLog();
      sendResponse({ count: log.length });
    } else if (message.type === "clear") {
      await setLog([]);
      sendResponse({ ok: true, count: 0 });
    } else {
      sendResponse({ ok: false });
    }
  })();
  return true; // keep the message channel open for the async response
});
