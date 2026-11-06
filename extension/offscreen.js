/*
 * Offscreen Blob factory.
 *
 * Service workers cannot create Blob URLs. This tiny extension page creates
 * them on demand; the service worker then calls chrome.downloads.download
 * with saveAs:true so Brave/Chrome shows the native Save As dialog.
 */
'use strict';

const urls = new Set();
const MESSAGE = {
  CREATE_URL: 'DSCE_OFFSCREEN_CREATE_URL',
  REVOKE: 'DSCE_OFFSCREEN_REVOKE',
};

chrome.runtime.onMessage.addListener(function onMessage(message, _sender, sendResponse) {
  if (!message || message.target !== 'offscreen') return false;

  if (message.type === MESSAGE.CREATE_URL) {
    try {
      const markdown = typeof message.markdown === 'string' ? message.markdown : '';
      if (!markdown.trim()) throw new Error('There is nothing to export.');
      const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      urls.add(url);

      // Keep the Blob alive long enough for the download to start, but do not
      // leak it forever if the service worker disappears unexpectedly.
      window.setTimeout(() => {
        if (!urls.has(url)) return;
        URL.revokeObjectURL(url);
        urls.delete(url);
      }, 60 * 60 * 1000);

      sendResponse({ ok: true, url });
    } catch (error) {
      sendResponse({ ok: false, message: (error && error.message) || 'Could not create the file.' });
    }
    return false;
  }

  if (message.type === MESSAGE.REVOKE) {
    const url = typeof message.url === 'string' ? message.url : '';
    if (url && urls.has(url)) {
      URL.revokeObjectURL(url);
      urls.delete(url);
    }
    sendResponse({ ok: true });
    return false;
  }

  return false;
});

window.addEventListener('unload', () => {
  urls.forEach((url) => URL.revokeObjectURL(url));
  urls.clear();
});
