// YTBrain: копит лог просмотров в chrome.storage.local (ключ watchLog).
// Дедупликация: videoId + день (пересмотр в другой день — отдельная запись).

const STORAGE_KEY = "watchLog";

async function getLog() {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  return data[STORAGE_KEY] || [];
}

async function setLog(log) {
  await chrome.storage.local.set({ [STORAGE_KEY]: log });
}

function dedupKey(entry) {
  const day = (entry.watchedAt || "").slice(0, 10);
  return `${entry.videoId}|${day}`;
}

async function handleLog(entry) {
  const log = await getLog();
  const key = dedupKey(entry);
  if (log.some((e) => dedupKey(e) === key)) return { added: false, count: log.length };
  log.push(entry);
  await setLog(log);
  return { added: true, count: log.length };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    switch (message.type) {
      case "log":
        sendResponse(await handleLog(message.entry));
        break;
      case "getCount": {
        const log = await getLog();
        sendResponse({ count: log.length });
        break;
      }
      case "clear":
        await setLog([]);
        sendResponse({ count: 0 });
        break;
      default:
        sendResponse({ error: "unknown message type" });
    }
  })();
  return true; // асинхронный sendResponse
});
