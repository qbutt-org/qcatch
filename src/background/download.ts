function waitForDownload(downloadId: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = (error?: string) => {
      chrome.downloads.onChanged.removeListener(listener);
      if (error) reject(new Error(`Браузер не сохранил файл: ${error}`));
      else resolve();
    };
    const listener = (delta: chrome.downloads.DownloadDelta) => {
      if (delta.id !== downloadId) return;
      if (delta.error?.current) finish(delta.error.current);
      else if (delta.state?.current === "complete") finish();
    };

    chrome.downloads.onChanged.addListener(listener);
    void chrome.downloads.search({ id: downloadId }).then(([item]) => {
      if (item?.state === "complete") finish();
      else if (item?.error) finish(item.error);
    }).catch((error: unknown) => finish(error instanceof Error ? error.message : String(error)));
  });
}

export async function saveDownload(filename: string, url: string): Promise<number> {
  const downloadId = await chrome.downloads.download({ filename, saveAs: false, url });
  await waitForDownload(downloadId);
  return downloadId;
}
