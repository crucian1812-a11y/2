const countEl = document.getElementById("count");

function refreshCount() {
  chrome.runtime.sendMessage({ type: "getCount" }, (resp) => {
    countEl.textContent = resp && typeof resp.count === "number" ? resp.count : 0;
  });
}

document.getElementById("download").addEventListener("click", async () => {
  const data = await chrome.storage.local.get("watchLog");
  const log = data.watchLog || [];
  const json = JSON.stringify(log, null, 2);
  const url = "data:application/json;charset=utf-8," + encodeURIComponent(json);
  const date = new Date().toISOString().slice(0, 10);
  chrome.downloads.download({
    url,
    filename: `extension-${date}.json`,
    saveAs: true,
  });
});

document.getElementById("clear").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "clear" }, () => refreshCount());
});

refreshCount();
