import { chromium } from 'playwright-core';
import { mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const extensionPath = path.join(root, 'extension');
const braveCandidates = [
  process.env.BRAVE_PATH,
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/usr/bin/brave-browser',
  '/usr/bin/brave',
  'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
].filter(Boolean);
const bravePath = braveCandidates.find((candidate) => existsSync(candidate));

async function main() {
  if (!bravePath) {
    throw new Error('Brave Browser is required for this integration test. Set BRAVE_PATH to its executable.');
  }

  const profile = await mkdtemp(path.join(tmpdir(), 'dsce-profile-'));
  const downloadsPath = await mkdtemp(path.join(tmpdir(), 'dsce-downloads-'));
  const history = JSON.parse(await readFile(path.join(__dirname, 'fixtures/history.json'), 'utf8'));
  const chatHtml = await readFile(path.join(__dirname, 'fixtures/chat.html'), 'utf8');
  const domChatHtml = await readFile(path.join(__dirname, 'fixtures/dom-chat.html'), 'utf8');

  const context = await chromium.launchPersistentContext(profile, {
    headless: true,
    executablePath: bravePath,
    acceptDownloads: true,
    downloadsPath,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });

  try {

  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15000 });
  const extensionId = new URL(worker.url()).host;
  console.log(`Loaded extension ${extensionId}`);

  await context.addInitScript(() => {
    if (location.hostname === 'chat.deepseek.com') {
      localStorage.setItem('userToken', JSON.stringify({ value: 'integration-test-token' }));
    }
  });

  await context.route('https://chat.deepseek.com/api/v0/chat/history_messages**', async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('chat_session_id') === 'dom-chat') {
      await route.fulfill({ status: 500, contentType: 'application/json', body: '{"code":500}' });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(history),
    });
  });

  await context.route('https://chat.deepseek.com/a/chat/s/test-chat', async (route) => {
    await route.fulfill({ status: 200, contentType: 'text/html', body: chatHtml });
  });

  await context.route('https://chat.deepseek.com/a/chat/s/dom-chat', async (route) => {
    await route.fulfill({ status: 200, contentType: 'text/html', body: domChatHtml });
  });

  await context.route('https://chat.deepseek.com/', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<!doctype html><html lang="en"><head><title>DeepSeek - Into the Unknown</title></head><body><main>Start a chat</main></body></html>',
    });
  });

  const page = context.pages()[0] || await context.newPage();
  await page.goto('https://chat.deepseek.com/a/chat/s/test-chat', { waitUntil: 'domcontentloaded' });
  const tabId = await getTabId(worker, 'test-chat');
  await waitForContentScript(worker, tabId);

  const ping = await sendToTab(worker, tabId, { type: 'DSCE_PING' });
  assert(ping && ping.ok, 'content script should answer PING');

  const infoResponse = await sendToTab(worker, tabId, { type: 'DSCE_GET_INFO' });
  assert(infoResponse && infoResponse.ok, `GET_INFO failed: ${JSON.stringify(infoResponse)}`);
  const info = infoResponse.info;
  assertEqual(info.source, 'api', 'GET_INFO should use the DeepSeek API');
  assertEqual(info.messageCount, 4, 'only the selected branch should be counted');
  assertEqual(info.title, 'Fix a flaky Playwright test', 'title should come from chat_session.title');
  assertEqual(info.generating, false, 'fixture should not look like it is generating');
  console.log('API GET_INFO ✔');

  const exportResponse = await sendToTab(worker, tabId, {
    type: 'DSCE_EXPORT',
    options: { depth: 'standard', includeTranscript: true, includeReasoning: true },
  });
  assert(exportResponse && exportResponse.ok, `EXPORT failed: ${JSON.stringify(exportResponse)}`);
  const markdown = exportResponse.markdown;
  assertIncludes(markdown, '## Key points', 'summary should contain key points');
  assertIncludes(markdown, '## Conversation outline', 'summary should contain an outline');
  assertIncludes(markdown, '## Full transcript', 'transcript option should be honored');
  assertIncludes(markdown, '## Code & files', 'code stats should be included');
  assertIncludes(markdown, 'flaky-trace.zip', 'file attachments should be listed');
  assertIncludes(markdown, 'Reasoning (', 'reasoning option should be honored');
  assertIncludes(markdown, 'playwright.dev/docs/test-retries', 'answer links should be included');
  assertIncludes(markdown, 'playwright.dev/docs/actionability', 'search metadata sources should be included');
  assert(!markdown.includes('regenerated branch'), 'non-selected branches must not be exported');
  assert(!markdown.includes('This rendered message'), 'DOM should not be used when API works');
  await writeFile(path.join(__dirname, 'artifacts/sample-export.md'), markdown, 'utf8');
  console.log('API summary + transcript ✔');

  const concise = await sendToTab(worker, tabId, {
    type: 'DSCE_EXPORT',
    options: { depth: 'brief', includeTranscript: false, includeReasoning: false },
  });
  assert(concise && concise.ok, 'concise export should succeed');
  assert(!concise.markdown.includes('## Full transcript'), 'transcript should be omitted when disabled');
  assert(concise.markdown.length < markdown.length, 'brief summary should be shorter');
  console.log('Summary-only export ✔');

  const apiPopup = await context.newPage();
  await apiPopup.setViewportSize({ width: 390, height: 640 });
  await apiPopup.goto(`chrome-extension://${extensionId}/popup.html?tabId=${tabId}`, {
    waitUntil: 'domcontentloaded',
  });
  await apiPopup.waitForFunction(() => {
    return document.getElementById('statusText').textContent.includes('Ready');
  }, null, { timeout: 15000 });
  assertEqual(await apiPopup.locator('#sourceBadge').textContent(), 'API', 'popup should show API mode');
  await apiPopup.waitForTimeout(350);
  await apiPopup.screenshot({ path: path.join(__dirname, 'artifacts/popup.png') });
  await apiPopup.close();
  console.log('API popup ✔');

  const saveResponse = await sendToTab(worker, tabId, {
    type: 'DSCE_EXPORT_AND_SAVE',
    options: { depth: 'standard', includeTranscript: false, includeReasoning: false },
  }, 45000);
  assert(saveResponse && saveResponse.ok, `EXPORT_AND_SAVE failed: ${JSON.stringify(saveResponse)}`);
  console.log(`Download started: ${saveResponse.filename} (id ${saveResponse.downloadId})`);

  const downloaded = await waitForDownloadFile(downloadsPath, 30000);
  assert(downloaded, 'a Markdown file should be written to the downloads path');
  const downloadedText = await readFile(downloaded, 'utf8');
  assertIncludes(downloadedText, '# Fix a flaky Playwright test', 'downloaded file should contain the title');
  assertIncludes(downloadedText, '## At a glance', 'downloaded file should contain the summary');
  assert(!downloadedText.includes('## Full transcript'), 'downloaded concise file should omit the transcript');
  console.log(`Save As download ✔ (${path.basename(downloaded)})`);

  const downloadState = await worker.evaluate((downloadId) => {
    return new Promise((resolve) => {
      chrome.downloads.search({ id: downloadId }, (items) => {
        resolve(items && items[0] ? items[0].state : null);
      });
    });
  }, saveResponse.downloadId);
  assertEqual(downloadState, 'complete', 'download should finish successfully');

  const offscreenClosed = await waitForOffscreenClosed(worker, 15000);
  assert(offscreenClosed, 'offscreen Blob factory should close after the download completes');
  console.log('Offscreen cleanup ✔');

  await page.goto('https://chat.deepseek.com/a/chat/s/dom-chat', { waitUntil: 'domcontentloaded' });
  const domTabId = await getTabId(worker, 'dom-chat');
  await waitForContentScript(worker, domTabId);
  const domInfo = await sendToTab(worker, domTabId, { type: 'DSCE_GET_INFO' });
  assert(domInfo && domInfo.ok, `DOM GET_INFO failed: ${JSON.stringify(domInfo)}`);
  assertEqual(domInfo.info.source, 'dom', 'DOM fallback should be reported');
  assertEqual(domInfo.info.messageCount, 4, 'DOM fallback should read all rendered messages');
  const domExport = await sendToTab(worker, domTabId, {
    type: 'DSCE_EXPORT',
    options: { depth: 'standard', includeTranscript: true, includeReasoning: false },
  });
  assert(domExport && domExport.ok, `DOM EXPORT failed: ${JSON.stringify(domExport)}`);
  assertIncludes(domExport.markdown, 'Wait for the network response', 'DOM content should be summarized');
  assertIncludes(domExport.markdown, 'await page.waitForResponse', 'DOM fallback should preserve code block content');
  assertIncludes(domExport.markdown, 'Use retries as a diagnostic tool', 'DOM content should include the second answer');
  assertIncludes(domExport.markdown, '- Wait for the network response.', 'DOM fallback should preserve lists');
  assertIncludes(domExport.markdown, '| Setting | Value |', 'DOM fallback should preserve tables');
  assertIncludes(domExport.markdown, '> Retries are diagnostic, not a fix.', 'DOM fallback should preserve blockquotes');
  assertIncludes(domExport.markdown, '$x^2$', 'DOM fallback should convert KaTeX to Markdown math');
  await writeFile(path.join(__dirname, 'artifacts/dom-export.md'), domExport.markdown, 'utf8');
  console.log('DOM fallback export ✔');

  const popup = await context.newPage();
  await popup.setViewportSize({ width: 390, height: 640 });
  await popup.goto(`chrome-extension://${extensionId}/popup.html?tabId=${domTabId}`, {
    waitUntil: 'domcontentloaded',
  });
  await popup.waitForFunction(() => {
    return document.getElementById('statusText').textContent.includes('Ready');
  }, null, { timeout: 15000 });
  assertEqual(
    await popup.locator('#conversationTitle').textContent(),
    'DOM fallback chat',
    'popup should show the open conversation title',
  );
  assertIncludes(
    await popup.locator('#conversationMeta').textContent(),
    '4 messages',
    'popup should show the message count',
  );
  assertEqual(await popup.locator('#sourceBadge').textContent(), 'DOM', 'popup should show DOM mode');
  assert(!(await popup.locator('#exportBtn').isDisabled()), 'popup export button should be enabled');
  await popup.waitForTimeout(350);
  await popup.screenshot({ path: path.join(__dirname, 'artifacts/popup-dom.png') });

  await popup.locator('label[for="includeTranscript"]').click();
  assert(!(await popup.locator('#includeReasoning').isDisabled()), 'reasoning should be available with a transcript');
  assertIncludes(
    await popup.locator('#exportLabel').textContent(),
    'chat + summary',
    'export label should reflect transcript mode',
  );
  await popup.locator('label[for="includeTranscript"]').click();
  assert(await popup.locator('#includeReasoning').isDisabled(), 'reasoning should be disabled without a transcript');

  const darkPopup = await context.newPage();
  await darkPopup.emulateMedia({ colorScheme: 'dark' });
  await darkPopup.setViewportSize({ width: 390, height: 640 });
  await darkPopup.goto(`chrome-extension://${extensionId}/popup.html?tabId=${domTabId}`, {
    waitUntil: 'domcontentloaded',
  });
  await darkPopup.waitForFunction(() => {
    return document.getElementById('statusText').textContent.includes('Ready');
  }, null, { timeout: 15000 });
  await darkPopup.waitForTimeout(350);
  await darkPopup.screenshot({ path: path.join(__dirname, 'artifacts/popup-dark.png') });
  console.log('Popup UI ✔');

  await page.goto('https://chat.deepseek.com/', { waitUntil: 'domcontentloaded' });
  const homeTabId = await getTabId(worker, 'chat.deepseek.com/');
  await waitForContentScript(worker, homeTabId);
  const homeInfo = await sendToTab(worker, homeTabId, { type: 'DSCE_GET_INFO' });
  assertEqual(homeInfo.ok, false, 'home page should not report a conversation');
  assertEqual(homeInfo.code, 'NO_CONVERSATION', 'home page should return NO_CONVERSATION');

  const homePopup = await context.newPage();
  await homePopup.setViewportSize({ width: 390, height: 640 });
  await homePopup.goto(`chrome-extension://${extensionId}/popup.html?tabId=${homeTabId}`, {
    waitUntil: 'domcontentloaded',
  });
  await homePopup.waitForFunction(() => {
    return document.getElementById('statusText').textContent.includes('No conversation');
  }, null, { timeout: 15000 });
  assert(await homePopup.locator('#options').isHidden(), 'options should be hidden without a conversation');
  console.log('Empty-state UI ✔');

    console.log('\nAll integration checks passed.');
  } finally {
    await context.close();
  }
}

async function getTabId(worker, chatId) {
  const tabs = await worker.evaluate(async () => {
    return await chrome.tabs.query({ url: 'https://chat.deepseek.com/*' });
  });
  const tab = tabs.find((candidate) => candidate.url && candidate.url.includes(chatId));
  assert(tab, `could not find tab for ${chatId}`);
  return tab.id;
}

async function waitForContentScript(worker, tabId) {
  let lastError = null;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await sendToTab(worker, tabId, { type: 'DSCE_PING' });
      if (response && response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`content script did not become ready: ${lastError && lastError.message}`);
}

function sendToTab(worker, tabId, message, timeoutMs = 30000) {
  return Promise.race([
    worker.evaluate(({ tabId: id, message: payload }) => {
      return new Promise((resolve) => {
        chrome.tabs.sendMessage(id, payload, (response) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, code: 'TAB_MESSAGE_ERROR', message: chrome.runtime.lastError.message });
            return;
          }
          resolve(response);
        });
      });
    }, { tabId, message }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('tab message timed out')), timeoutMs)),
  ]);
}

async function waitForOffscreenClosed(worker, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const open = await worker.evaluate(async () => {
      if (!chrome.runtime.getContexts) return false;
      const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
      return contexts.length > 0;
    });
    if (!open) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

async function waitForDownloadFile(downloadsPath, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const names = (await readdir(downloadsPath)).filter((name) => !name.endsWith('.crdownload'));
    const candidates = [];
    for (const name of names) {
      const candidate = path.join(downloadsPath, name);
      const details = await stat(candidate);
      if (details.isFile() && details.size > 0) {
        candidates.push({ path: candidate, mtime: details.mtimeMs });
      }
    }
    if (candidates.length) {
      candidates.sort((a, b) => b.mtime - a.mtime);
      return candidates[0].path;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return null;
}

function assert(value, message) {
  if (!value) throw new Error(message);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertIncludes(haystack, needle, message) {
  if (!haystack || !haystack.includes(needle)) {
    throw new Error(`${message}: missing ${JSON.stringify(needle)}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
