'use strict';

const CONTENT_FILES = [
  'lib/shared.js',
  'lib/markdown.js',
  'lib/summarize.js',
  'content.js',
];

const DEFAULTS = {
  depth: 'standard',
  includeTranscript: false,
  includeReasoning: false,
};

const els = {
  statusDot: document.getElementById('statusDot'),
  statusText: document.getElementById('statusText'),
  sourceBadge: document.getElementById('sourceBadge'),
  conversationSummary: document.getElementById('conversationSummary'),
  conversationTitle: document.getElementById('conversationTitle'),
  conversationMeta: document.getElementById('conversationMeta'),
  stateMessage: document.getElementById('stateMessage'),
  stateActions: document.getElementById('stateActions'),
  openChatBtn: document.getElementById('openChatBtn'),
  reloadBtn: document.getElementById('reloadBtn'),
  options: document.getElementById('options'),
  depthInputs: Array.from(document.querySelectorAll('input[name="depth"]')),
  includeTranscript: document.getElementById('includeTranscript'),
  includeReasoning: document.getElementById('includeReasoning'),
  reasoningRow: document.getElementById('reasoningRow'),
  exportBtn: document.getElementById('exportBtn'),
  exportLabel: document.getElementById('exportLabel'),
  exportSpinner: document.getElementById('exportSpinner'),
  errorMessage: document.getElementById('errorMessage'),
};

let activeTab = null;
let conversationInfo = null;
let busy = false;
let contentReady = false;

init();

async function init() {
  bindEvents();
  await loadSettings();

  try {
    const params = new URLSearchParams(location.search);
    const requestedTabId = Number(params.get('tabId'));
    if (Number.isInteger(requestedTabId) && requestedTabId > 0) {
      activeTab = await chrome.tabs.get(requestedTabId);
    } else {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      activeTab = tabs && tabs[0] ? tabs[0] : null;
    }
  } catch (_error) {
    activeTab = null;
  }

  if (!activeTab || !activeTab.url || !/^https:\/\/chat\.deepseek\.com\//i.test(activeTab.url)) {
    renderNotOnDeepSeek();
    return;
  }

  await connectToPage();
}

function bindEvents() {
  els.depthInputs.forEach((input) => {
    input.addEventListener('change', () => {
      updateDepthSelection();
      saveSettings();
    });
  });

  els.includeTranscript.addEventListener('change', () => {
    updateReasoningState();
    updateExportLabel();
    saveSettings();
  });

  els.includeReasoning.addEventListener('change', saveSettings);
  els.exportBtn.addEventListener('click', exportAndSave);
  els.reloadBtn.addEventListener('click', () => {
    if (activeTab) chrome.tabs.reload(activeTab.id);
    window.close();
  });
  els.openChatBtn.addEventListener('click', async () => {
    const url = conversationInfo && conversationInfo.url
      ? conversationInfo.url
      : 'https://chat.deepseek.com/';
    await chrome.tabs.create({ url });
    window.close();
  });
}

async function connectToPage() {
  setStatus('Connecting to this tab…', 'loading');
  setStateMessage('');
  showActions(false);
  setOptionsEnabled(false);

  try {
    await ensureContentScript();
    setStatus('Reading conversation…', 'loading');
    const response = await sendTabMessage({ type: 'DSCE_GET_INFO' }, 45000);

    if (!response || !response.ok) {
      handleInfoError(response || {});
      return;
    }

    conversationInfo = response.info;
    renderConversation(response.info);
  } catch (error) {
    setStatus('Could not connect to the page', 'error');
    setStateMessage('Reload the DeepSeek tab after installing or updating the extension, then try again.');
    showActions(true, { open: false, reload: true });
    showError(error && error.message ? error.message : String(error));
    setOptionsEnabled(false);
    els.options.hidden = true;
    els.exportBtn.hidden = true;
  }
}

async function ensureContentScript() {
  if (contentReady) return;

  try {
    await sendTabMessage({ type: 'DSCE_PING' }, 1800);
    contentReady = true;
    return;
  } catch (_error) {
    // The declared content script has not run on this already-open tab yet.
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId: activeTab.id },
      files: CONTENT_FILES,
    });
  } catch (error) {
    throw new Error(
      `Chrome could not access this tab. Reload the page and try again. (${(error && error.message) || error})`,
    );
  }

  await sleep(180);
  await sendTabMessage({ type: 'DSCE_PING' }, 3000);
  contentReady = true;
}

function renderConversation(info) {
  conversationInfo = info;
  els.options.hidden = false;
  els.exportBtn.hidden = false;
  els.conversationSummary.hidden = false;
  els.conversationTitle.textContent = info.title || 'DeepSeek conversation';

  const parts = [
    `${info.messageCount} ${info.messageCount === 1 ? 'message' : 'messages'}`,
    `${info.userCount} from you`,
  ];
  if (info.model) parts.push(info.model);
  els.conversationMeta.textContent = parts.join(' · ');

  els.sourceBadge.hidden = false;
  els.sourceBadge.textContent = info.source === 'api' ? 'API' : 'DOM';
  els.sourceBadge.title = info.source === 'api'
    ? 'Read from DeepSeek’s conversation data.'
    : `Read from the rendered page.${info.fallbackReason ? ` ${info.fallbackReason}` : ''}`;

  if (info.generating) {
    setStatus('Response still generating — export may be partial', 'warning');
    setStateMessage('Wait for DeepSeek to finish, or export the completed part now.');
  } else {
    setStatus('Ready to export', 'ready');
    setStateMessage('');
  }

  showActions(false);
  setOptionsEnabled(true);
  updateDepthSelection();
  updateReasoningState();
  updateExportLabel();
  els.exportBtn.disabled = busy || !info.messageCount;
  hideError();
}

function handleInfoError(response) {
  conversationInfo = null;
  setOptionsEnabled(false);
  els.options.hidden = true;
  els.exportBtn.hidden = true;
  setStatus(response.code === 'NO_CONVERSATION' ? 'No conversation open' : 'Could not read this chat', 'warning');
  const message = response.message || 'Open a DeepSeek conversation and try again.';
  setStateMessage(message);
  showActions(true, {
    open: response.code === 'NO_CONVERSATION' || response.code === 'NOT_LOGGED_IN',
    reload: response.code === 'PAGE_NOT_READY' || response.code === 'READ_FAILED',
  });
  if (response.code !== 'NO_CONVERSATION') showError(message);
}

function renderNotOnDeepSeek() {
  conversationInfo = null;
  els.options.hidden = true;
  els.exportBtn.hidden = true;
  setStatus('Open a DeepSeek chat first', 'warning');
  setStateMessage('This extension reads the conversation open on chat.deepseek.com.');
  showActions(true, { open: true, reload: false });
  setOptionsEnabled(false);
  els.conversationSummary.hidden = true;
  els.sourceBadge.hidden = true;
}

function setOptionsEnabled(enabled) {
  els.depthInputs.forEach((input) => {
    input.disabled = !enabled || busy;
  });
  els.includeTranscript.disabled = !enabled || busy;
  els.includeReasoning.disabled = !enabled || busy || !els.includeTranscript.checked;
  if (!enabled) els.exportBtn.disabled = true;
}

function setBusy(value) {
  busy = value;
  els.exportSpinner.hidden = !value;
  els.exportBtn.disabled = value || !conversationInfo;
  if (value) {
    els.exportLabel.textContent = 'Preparing Markdown…';
  } else {
    updateExportLabel();
  }
  const enabled = !value && Boolean(conversationInfo);
  els.depthInputs.forEach((input) => {
    input.disabled = !enabled;
  });
  els.includeTranscript.disabled = !enabled;
  els.includeReasoning.disabled = !enabled || !els.includeTranscript.checked;
}

async function exportAndSave() {
  if (busy || !activeTab) return;

  const options = {
    depth: getSelectedDepth(),
    includeTranscript: els.includeTranscript.checked,
    includeReasoning: els.includeTranscript.checked && els.includeReasoning.checked,
  };

  hideError();
  setBusy(true);
  setStatus('Building your Markdown…', 'loading');
  setStateMessage('Reading the full conversation and writing the summary.');

  try {
    const response = await sendTabMessage(
      { type: 'DSCE_EXPORT_AND_SAVE', options },
      180000,
    );
    if (!response || !response.ok) {
      throw new Error((response && response.message) || 'The export failed.');
    }

    setBusy(false);
    setStatus('Save dialog opened', 'ready');
    setStateMessage(`Choose where to save “${response.filename}”.`);
  } catch (error) {
    setBusy(false);
    setStatus('Export failed', 'error');
    showError((error && error.message) || String(error));
  }
}

function getSelectedDepth() {
  const selected = els.depthInputs.find((input) => input.checked);
  return selected ? selected.value : 'standard';
}

function updateDepthSelection() {
  els.depthInputs.forEach((input) => {
    const card = input.closest('.depth-card');
    if (card) card.classList.toggle('is-selected', input.checked);
  });
}

function updateReasoningState() {
  const transcript = els.includeTranscript.checked;
  els.includeReasoning.disabled = busy || !transcript;
  els.reasoningRow.style.opacity = transcript ? '' : '0.66';
}

function updateExportLabel() {
  if (busy) return;
  els.exportLabel.textContent = els.includeTranscript.checked
    ? 'Export chat + summary (.md)'
    : 'Export summary (.md)';
}

function setStatus(text, state) {
  els.statusText.textContent = text;
  els.statusDot.className = `status-dot is-${state || 'ready'}`;
}

function setStateMessage(text) {
  els.stateMessage.textContent = text || '';
  els.stateMessage.hidden = !text;
}

function showActions(show, options) {
  const settings = options || { open: true, reload: false };
  els.stateActions.hidden = !show;
  els.openChatBtn.hidden = !settings.open;
  els.reloadBtn.hidden = !settings.reload;
}

function showError(message) {
  els.errorMessage.textContent = message || '';
  els.errorMessage.hidden = !message;
}

function hideError() {
  els.errorMessage.hidden = true;
  els.errorMessage.textContent = '';
}

async function loadSettings() {
  let stored = DEFAULTS;
  try {
    stored = { ...DEFAULTS, ...(await chrome.storage.local.get(DEFAULTS)) };
  } catch (_error) {
    stored = DEFAULTS;
  }

  if (['brief', 'standard', 'detailed'].includes(stored.depth)) {
    const input = els.depthInputs.find((candidate) => candidate.value === stored.depth);
    if (input) input.checked = true;
  }
  els.includeTranscript.checked = Boolean(stored.includeTranscript);
  els.includeReasoning.checked = Boolean(stored.includeReasoning) && els.includeTranscript.checked;
  updateDepthSelection();
  updateReasoningState();
  updateExportLabel();
}

async function saveSettings() {
  try {
    await chrome.storage.local.set({
      depth: getSelectedDepth(),
      includeTranscript: els.includeTranscript.checked,
      includeReasoning: els.includeTranscript.checked && els.includeReasoning.checked,
    });
  } catch (_error) {
    // Settings are a convenience; export still works without persistence.
  }
}

function sendTabMessage(message, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (!activeTab) {
      reject(new Error('No active tab.'));
      return;
    }

    let settled = false;
    const timer = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('The DeepSeek tab did not respond. Reload it and try again.'));
    }, timeoutMs || 15000);

    chrome.tabs.sendMessage(activeTab.id, message, (response) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message || 'Could not reach the DeepSeek tab.'));
        return;
      }
      resolve(response);
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
