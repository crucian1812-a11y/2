// YTBrain: помечает видео просмотренным после THRESHOLD_MS на странице.
// YouTube — SPA: переходы между видео не перезагружают страницу,
// поэтому смену URL отслеживаем через MutationObserver.

const THRESHOLD_MS = 30 * 1000;

let currentVideoId = null;
let timerId = null;

function getVideoId(href) {
  try {
    const url = new URL(href);
    return url.searchParams.get("v");
  } catch {
    return null;
  }
}

function getTitle() {
  const el =
    document.querySelector("h1.ytd-watch-metadata yt-formatted-string") ||
    document.querySelector("h1.title yt-formatted-string") ||
    document.querySelector('meta[name="title"]');
  if (!el) return document.title.replace(/ - YouTube$/, "");
  return (el.textContent || el.content || "").trim();
}

function getChannel() {
  const el =
    document.querySelector("ytd-channel-name #channel-name a") ||
    document.querySelector("ytd-channel-name a") ||
    document.querySelector('span[itemprop="author"] link[itemprop="name"]');
  if (!el) return "";
  return (el.textContent || el.getAttribute("content") || "").trim();
}

function logCurrentVideo() {
  const videoId = getVideoId(location.href);
  if (!videoId) return;
  chrome.runtime.sendMessage({
    type: "log",
    entry: {
      videoId,
      title: getTitle(),
      channel: getChannel(),
      url: `https://www.youtube.com/watch?v=${videoId}`,
      watchedAt: new Date().toISOString(),
    },
  });
}

function armTimer() {
  const videoId = getVideoId(location.href);
  if (videoId === currentVideoId) return;
  currentVideoId = videoId;
  if (timerId) clearTimeout(timerId);
  timerId = null;
  if (!videoId) return;
  timerId = setTimeout(logCurrentVideo, THRESHOLD_MS);
}

armTimer();

new MutationObserver(() => armTimer()).observe(document.body, {
  childList: true,
  subtree: true,
});
