const countEl = document.getElementById("count");

async function refreshCount() {
  const { count } = await chrome.runtime.sendMessage({ type: "getCount" });
  countEl.textContent = count;
}

document.getElementById("download").addEventListener("click", async () => {
  const data = await chrome.storage.local.get("watchLog");
  const log = data.watchLog || [];
  const json = JSON.stringify(log, null, 2);
  const url = "data:application/json;charset=utf-8," + encodeURIComponent(json);
  const day = new Date().toISOString().slice(0, 10);
  await chrome.downloads.download({
    url,
    filename: `extension-${day}.json`,
    saveAs: true,
  });
});

document.getElementById("clear").addEventListener("click", async () => {
  if (!confirm("Очистить очередь просмотров?")) return;
  await chrome.runtime.sendMessage({ type: "clear" });
  refreshCount();
});

refreshCount();
