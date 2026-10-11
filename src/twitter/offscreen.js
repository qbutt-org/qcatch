import { GifConverter } from "./gif-converter.js";

const OBJECT_URL_LIFETIME = 120_000;
const objectUrls = new Set();
let activeRequestId;
let idleTimer;
let lastPercentage = -1;
let pendingConversions = 0;
let conversionQueue = Promise.resolve();

const converter = new GifConverter(({ progress }) => {
  const percentage = Math.round(Math.min(1, Math.max(0, progress)) * 100);
  if (!activeRequestId || percentage === lastPercentage) {
    return;
  }

  lastPercentage = percentage;
  void chrome.runtime
    .sendMessage({
      target: "background",
      type: "gif-progress",
      requestId: activeRequestId,
      progress,
    })
    .catch(() => {});
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (
    sender.id !== chrome.runtime.id ||
    message?.target !== "offscreen" ||
    message.type !== "convert-gif"
  ) {
    return;
  }

  pendingConversions += 1;
  const conversion = conversionQueue.then(() => convertGif(message));
  conversionQueue = conversion.catch(() => {});

  conversion
    .then(
      (url) => sendResponse({ ok: true, url }),
      (error) => sendResponse({ ok: false, error: errorMessage(error) }),
    )
    .finally(() => {
      pendingConversions -= 1;
      notifyWhenIdle();
    });

  return true;
});

async function convertGif({ requestId, url }) {
  if (typeof requestId !== "string" || typeof url !== "string") {
    throw new TypeError("Invalid GIF conversion request.");
  }

  activeRequestId = requestId;
  lastPercentage = -1;

  try {
    const output = await converter.convert(url);
    const objectUrl = URL.createObjectURL(
      new Blob([output], { type: "image/gif" }),
    );
    retainObjectUrl(objectUrl);
    return objectUrl;
  } finally {
    activeRequestId = undefined;
  }
}

function retainObjectUrl(url) {
  objectUrls.add(url);
  setTimeout(() => {
    URL.revokeObjectURL(url);
    objectUrls.delete(url);
    notifyWhenIdle();
  }, OBJECT_URL_LIFETIME);
}

function notifyWhenIdle() {
  clearTimeout(idleTimer);
  if (pendingConversions !== 0 || objectUrls.size !== 0) {
    return;
  }

  idleTimer = setTimeout(() => {
    if (pendingConversions === 0 && objectUrls.size === 0) {
      void chrome.runtime
        .sendMessage({ target: "background", type: "offscreen-idle" })
        .catch(() => {});
    }
  }, 0);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
