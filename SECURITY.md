# Security

qcatch intentionally requests `<all_urls>`, `webRequest`, `declarativeNetRequest`, `downloads`, `storage` and `offscreen`, because cross-origin players and their CDN hosts are not known ahead of time.

The extension:

- does not send browsing or media data to a project-controlled server;
- does not copy cookies into extension storage;
- stores replayable URLs and selected request headers only in `chrome.storage.session`;
- scopes temporary Origin/Referer rules to the extension initiator and exact source origins, removing them after each job;
- sends private request headers only to their source origin and rejects their redirects;
- sends playback cookies through temporary domain/path-scoped cookie files, never a global player header;
- rejects encrypted HLS and DASH manifests with `ContentProtection`;
- does not implement DRM bypass, key extraction, credential extraction or remote code execution.

Report a security issue privately through the GitHub repository owner. Do not include bearer tokens, signed media URLs, cookies or personal page data in an issue or log excerpt.
