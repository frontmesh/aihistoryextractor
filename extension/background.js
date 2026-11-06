/*
 * DeepSeek Chat Exporter - service worker.
 *
 * Receives the generated Markdown, asks the offscreen document to create a
 * Blob URL, then calls chrome.downloads.download with saveAs:true so
 * Chrome/Brave always shows the native Save As dialog.
 */
importScripts('lib/shared.js');

const DSCE = {
  DOWNLOAD: 'DSCE_DOWNLOAD',
  OFFSCREEN_CREATE_URL: 'DSCE_OFFSCREEN_CREATE_URL',
  OFFSCREEN_REVOKE: 'DSCE_OFFSCREEN_REVOKE',
  PING: 'DSCE_BACKGROUND_PING',
};

const OFFSCREEN_URL = 'offscreen.html';

let creatingOffscreen = null;
let offscreenCloseTimer = null;
const activeDownloads = new Map();

chrome.runtime.onMessage.addListener(function onMessage(message, sender, sendResponse) {
  if (!message || typeof message.type !== 'string') return false;

  if (message.type === DSCE.PING) {
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === DSCE.DOWNLOAD) {
    handleDownload(message, sender)
      .then(sendResponse)
      .catch((error) => {
        sendResponse({
          ok: false,
          message: (error && error.message) || 'Could not start the download.',
        });
      });
    return true;
  }

  return false;
});

chrome.downloads.onChanged.addListener((delta) => {
  if (!delta || !delta.state) return;
  const state = delta.state.current;
  if (state !== 'complete' && state !== 'interrupted') return;
  finalizeDownload(delta.id);
});

async function handleDownload(message, sender) {
  const markdown = typeof message.markdown === 'string' ? message.markdown : '';
  if (!markdown.trim()) {
    throw new Error('The generated Markdown file was empty.');
  }

  if (sender && sender.id !== chrome.runtime.id) {
    throw new Error('Unexpected message sender.');
  }

  const filename = globalThis.DSExporterShared.sanitizeFilename(
    message.filename,
    'DeepSeek chat',
  );

  await ensureOffscreenDocument();

  const response = await sendMessageToOffscreen({
    type: DSCE.OFFSCREEN_CREATE_URL,
    target: 'offscreen',
    markdown,
  });

  if (!response || !response.ok || !response.url) {
    throw new Error((response && response.message) || 'Could not prepare the Markdown file.');
  }

  let downloadId;
  try {
    downloadId = await chrome.downloads.download({
      url: response.url,
      filename,
      saveAs: true,
      conflictAction: 'uniquify',
    });
  } catch (error) {
    revokeOffscreenUrl(response.url);
    if (activeDownloads.size === 0) scheduleOffscreenClose(5000);
    throw error;
  }

  if (!downloadId) {
    revokeOffscreenUrl(response.url);
    throw new Error('The browser did not create a download.');
  }

  activeDownloads.set(downloadId, { url: response.url, filename });

  // Chrome may finish a tiny download before we record it, so check once.
  const existing = await searchDownload(downloadId);
  if (existing && existing.state && existing.state !== 'in_progress') {
    finalizeDownload(downloadId);
  }

  return {
    ok: true,
    downloadId,
    filename,
  };
}

function finalizeDownload(downloadId) {
  const entry = activeDownloads.get(downloadId);
  if (!entry) return;
  activeDownloads.delete(downloadId);
  revokeOffscreenUrl(entry.url);
  if (activeDownloads.size === 0) scheduleOffscreenClose(5000);
}

function searchDownload(downloadId) {
  return new Promise((resolve) => {
    chrome.downloads.search({ id: downloadId }, (items) => {
      if (chrome.runtime.lastError) {
        resolve(null);
        return;
      }
      resolve(Array.isArray(items) ? items[0] : null);
    });
  });
}

function revokeOffscreenUrl(url) {
  if (!url) return;
  chrome.runtime.sendMessage(
    { type: DSCE.OFFSCREEN_REVOKE, target: 'offscreen', url },
    () => {
      void chrome.runtime.lastError;
    },
  );
}

async function ensureOffscreenDocument() {
  clearTimeout(offscreenCloseTimer);

  if (await hasOffscreenDocument()) return;

  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_URL,
        reasons: ['BLOBS'],
        justification: 'Create a Blob URL so Chrome can show a Save As dialog for the Markdown export.',
      })
      .catch((error) => {
        const message = String((error && error.message) || error || '');
        if (/single offscreen document|already exists/i.test(message)) return;
        throw error;
      })
      .finally(() => {
        creatingOffscreen = null;
      });
  }

  await creatingOffscreen;
}

async function hasOffscreenDocument() {
  if (!chrome.runtime.getContexts) return false;
  try {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)],
    });
    return contexts.length > 0;
  } catch (_error) {
    return false;
  }
}

async function sendMessageToOffscreen(message) {
  let lastError = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return await sendMessageOnce(message);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 100 + attempt * 75));
    }
  }
  throw lastError || new Error('Could not reach the offscreen document.');
}

function sendMessageOnce(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message || 'Could not reach the offscreen document.'));
        return;
      }
      resolve(response);
    });
  });
}

function scheduleOffscreenClose(delayMs) {
  clearTimeout(offscreenCloseTimer);
  offscreenCloseTimer = setTimeout(() => {
    closeOffscreenDocument().catch(() => {});
  }, delayMs == null ? 5000 : delayMs);
}

async function closeOffscreenDocument() {
  if (!(await hasOffscreenDocument())) return;
  try {
    await chrome.offscreen.closeDocument();
  } catch (_error) {
    // The browser may have already torn it down.
  }
}

chrome.runtime.onInstalled.addListener(() => {
  // No remote config, no analytics, no background network requests.
});
