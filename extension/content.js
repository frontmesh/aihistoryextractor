/*
 * DeepSeek Chat Exporter - content script.
 *
 * Runs on chat.deepseek.com. It reads the currently open conversation, builds
 * a Markdown summary locally, and asks the service worker to save it.
 */
(function initContentScript() {
  'use strict';

  if (globalThis.__DSCE_CONTENT_LOADED__) return;
  globalThis.__DSCE_CONTENT_LOADED__ = true;

  const Shared = globalThis.DSExporterShared;
  const Markdown = globalThis.DSExporterMarkdown;
  const Summarize = globalThis.DSExporterSummarize;

  const MESSAGE = {
    PING: 'DSCE_PING',
    GET_INFO: 'DSCE_GET_INFO',
    EXPORT: 'DSCE_EXPORT',
    EXPORT_AND_SAVE: 'DSCE_EXPORT_AND_SAVE',
    DOWNLOAD: 'DSCE_DOWNLOAD',
  };

  const CACHE_TTL_MS = 15000;
  const EXPORT_CACHE_TTL_MS = 3000;
  const CLIENT_VERSION = '2.3.0';

  let cache = null;
  let activeLoad = null;

  chrome.runtime.onMessage.addListener(function onMessage(message, _sender, sendResponse) {
    if (!message || typeof message.type !== 'string' || !message.type.startsWith('DSCE_')) {
      return false;
    }

    if (message.type === MESSAGE.PING) {
      sendResponse({
        ok: true,
        version: Shared ? Shared.VERSION : 'unknown',
        chatId: getCurrentChatId(),
      });
      return false;
    }

    if (message.type === MESSAGE.GET_INFO) {
      handleGetInfo()
        .then(sendResponse)
        .catch((error) => sendResponse(toErrorResponse(error)));
      return true;
    }

    if (message.type === MESSAGE.EXPORT) {
      handleExport(message.options || {})
        .then((result) => sendResponse({ ok: true, ...result }))
        .catch((error) => sendResponse(toErrorResponse(error)));
      return true;
    }

    if (message.type === MESSAGE.EXPORT_AND_SAVE) {
      handleExportAndSave(message.options || {})
        .then(sendResponse)
        .catch((error) => sendResponse(toErrorResponse(error)));
      return true;
    }

    return false;
  });

  async function handleGetInfo() {
    const conversation = await loadConversation({ maxAge: CACHE_TTL_MS, includeReasoning: false });
    return { ok: true, info: buildInfo(conversation) };
  }

  async function handleExport(options) {
    const includeTranscript = options.includeTranscript !== false;
    const includeReasoning = includeTranscript && Boolean(options.includeReasoning);
    const conversation = await loadConversation({
      maxAge: EXPORT_CACHE_TTL_MS,
      includeReasoning,
    });
    const depth = ['brief', 'standard', 'detailed'].includes(options.depth) ? options.depth : 'standard';
    const markdown = Summarize.buildMarkdown(conversation, {
      depth,
      includeTranscript,
      includeReasoning,
    });
    const filename = Shared.makeFilename(
      conversation.title,
      new Date(),
      includeTranscript ? 'chat' : `${depth}-summary`,
    );

    return {
      markdown,
      filename,
      title: conversation.title,
      messageCount: conversation.messages.length,
      source: conversation.source,
      generating: conversation.generating,
    };
  }

  async function handleExportAndSave(options) {
    const result = await handleExport(options);
    const download = await sendRuntimeMessage({
      type: MESSAGE.DOWNLOAD,
      markdown: result.markdown,
      filename: result.filename,
    });
    if (!download || !download.ok) {
      throw createError(
        'DOWNLOAD_FAILED',
        (download && download.message) || 'Chrome could not start the download.',
      );
    }
    return {
      ok: true,
      filename: result.filename,
      title: result.title,
      messageCount: result.messageCount,
      source: result.source,
      downloadId: download.downloadId,
    };
  }

  function buildInfo(conversation) {
    const userCount = conversation.messages.filter((message) => message.role === 'user').length;
    const assistantCount = conversation.messages.length - userCount;
    const firstUser = conversation.messages.find((message) => message.role === 'user');
    return {
      title: conversation.title,
      url: conversation.url,
      chatId: conversation.chatId,
      messageCount: conversation.messages.length,
      userCount,
      assistantCount,
      source: conversation.source,
      fallbackReason: conversation.fallbackReason || '',
      model: conversation.model || '',
      generating: Boolean(conversation.generating),
      preview: firstUser ? cleanPreview(firstUser.content, 120) : '',
    };
  }

  function cleanPreview(value, limit) {
    return String(value || '')
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/[*_~`#>|]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, limit);
  }

  async function loadConversation(options) {
    const settings = options || {};
    const chatId = getCurrentChatId();
    if (!chatId) {
      throw createError(
        'NO_CONVERSATION',
        'Open a DeepSeek conversation first, then click the extension again.',
      );
    }

    const includeReasoning = Boolean(settings.includeReasoning);
    const cacheKey = `${chatId}:${includeReasoning ? 'reasoning' : 'plain'}`;
    const maxAge = settings.maxAge == null ? CACHE_TTL_MS : settings.maxAge;

    if (
      cache &&
      cache.key === cacheKey &&
      cache.url === location.href &&
      Date.now() - cache.at <= maxAge
    ) {
      return cache.conversation;
    }

    if (activeLoad && activeLoad.key === cacheKey) {
      return activeLoad.promise;
    }

    const promise = (async () => {
      let apiError = null;
      let conversation = null;

      try {
        conversation = await fetchConversationFromApi(chatId, includeReasoning);
      } catch (error) {
        apiError = error;
      }

      if (!conversation || !conversation.messages.length) {
        try {
          conversation = await scrapeConversationFromDom(includeReasoning);
        } catch (domError) {
          if (apiError) {
            throw createError(
              'READ_FAILED',
              `Could not read this chat. ${apiError.message || apiError} ${domError.message || domError}`.trim(),
            );
          }
          throw domError;
        }
      }

      if (!conversation.messages.length) {
        throw createError('NO_MESSAGES', 'This conversation does not contain any readable messages yet.');
      }

      conversation.chatId = chatId;
      conversation.url = Shared.normalizeChatUrl(location.href, chatId);
      conversation.exportedAt = new Date().toISOString();
      conversation.title = conversation.title || titleFromDocument() || 'DeepSeek conversation';
      conversation.model = conversation.model || modelFromDocument();
      if (apiError && conversation.source === 'dom') {
        conversation.fallbackReason = apiError.message || String(apiError);
      }

      cache = {
        key: cacheKey,
        url: location.href,
        at: Date.now(),
        conversation,
      };
      return conversation;
    })();

    activeLoad = { key: cacheKey, promise };
    try {
      return await promise;
    } finally {
      if (activeLoad && activeLoad.key === cacheKey) activeLoad = null;
    }
  }

  function getCurrentChatId() {
    return Shared ? Shared.getChatId(location.href) : null;
  }

  async function fetchConversationFromApi(chatId, includeReasoning) {
    const rawToken = Shared.parseUserToken(localStorage.getItem('userToken'));
    const token = rawToken ? rawToken.replace(/^Bearer\s+/i, '') : '';
    if (!token) {
      throw createError(
        'NOT_LOGGED_IN',
        'DeepSeek login token was not found. Sign in to chat.deepseek.com and reload the page.',
      );
    }

    const endpoint = new URL('/api/v0/chat/history_messages', location.origin);
    endpoint.searchParams.set('chat_session_id', chatId);

    const response = await fetch(endpoint.toString(), {
      method: 'GET',
      credentials: 'include',
      cache: 'no-store',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        'x-client-bundle-id': 'com.deepseek.chat',
        'x-client-platform': 'web',
        'x-client-version': CLIENT_VERSION,
        'x-client-locale': (document.documentElement.lang || navigator.language || 'en-US').replace('-', '_'),
        'x-client-timezone-offset': String(-new Date().getTimezoneOffset() * 60),
      },
    });

    if (response.status === 401 || response.status === 403) {
      throw createError('NOT_LOGGED_IN', 'Your DeepSeek session has expired. Sign in again and reload the page.');
    }
    if (!response.ok) {
      throw createError('API_FAILED', `DeepSeek returned HTTP ${response.status}.`);
    }

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('json')) {
      throw createError('API_FAILED', 'DeepSeek returned an unexpected response.');
    }

    const payload = await response.json();
    const data = unwrapApiData(payload);
    return normalizeApiConversation(data, chatId, includeReasoning);
  }

  function unwrapApiData(payload) {
    if (!payload || typeof payload !== 'object') {
      throw createError('API_FAILED', 'DeepSeek returned an empty response.');
    }

    if (payload.code != null && !isSuccessCode(payload.code)) {
      throw createError('API_FAILED', payload.msg || `DeepSeek API error ${String(payload.code)}.`);
    }

    let data = payload.data == null ? payload : payload.data;
    if (data && typeof data === 'object' && data.biz_code != null) {
      if (!isSuccessCode(data.biz_code)) {
        throw createError('API_FAILED', data.biz_msg || `DeepSeek API error ${String(data.biz_code)}.`);
      }
      data = data.biz_data;
    }
    if (data && typeof data === 'object' && data.data && data.data.chat_messages) {
      data = data.data;
    }
    if (!data || !Array.isArray(data.chat_messages)) {
      throw createError('API_FAILED', 'DeepSeek did not return a conversation.');
    }
    return data;
  }

  function isSuccessCode(value) {
    return value === 0 || value === '0';
  }

  function normalizeApiConversation(data, chatId, includeReasoning) {
    const session = data.chat_session || {};
    const rawMessages = data.chat_messages || [];
    const activeMessages = activeMessagePath(rawMessages, session.current_message_id);
    const messages = [];
    let generating = Boolean(isGeneratingInDom());

    activeMessages.forEach((raw) => {
      const rawRole = String(raw.role || '').toUpperCase();
      if (rawRole !== 'USER' && rawRole !== 'ASSISTANT') return;
      const role = rawRole === 'USER' ? 'user' : 'assistant';
      let content = visibleMessageText(raw);
      if (role === 'assistant') content = stripCitationMarkers(content);
      content = normalizeContent(content);
      const files = collectApiFiles(raw);
      const references = collectApiReferences(raw);
      const thinking = includeReasoning ? extractThinking(raw) : [];
      if (!content && !files.length) return;

      const status = String(raw.status || '').toUpperCase();
      if (status && !['FINISHED', 'COMPLETED', 'SUCCESS'].includes(status)) generating = true;

      messages.push({
        id: raw.message_id == null ? '' : String(raw.message_id),
        role,
        content,
        thinking,
        files,
        references,
        timestamp: toIsoTimestamp(raw.inserted_at || raw.updated_at),
      });
    });

    let title = cleanTitle(session.title || data.title || '');
    if (!title || /^new chat$/i.test(title)) {
      const firstUser = messages.find((message) => message.role === 'user');
      title = firstUser ? firstUser.content.replace(/\s+/g, ' ').slice(0, 80) : '';
    }

    return {
      title: title || titleFromDocument() || 'DeepSeek conversation',
      url: Shared.normalizeChatUrl(location.href, chatId),
      exportedAt: new Date().toISOString(),
      model: Shared.modelLabel(session.model_type || findModel(rawMessages)),
      source: 'api',
      generating,
      messages,
    };
  }

  function activeMessagePath(messages, currentMessageId) {
    const byId = new Map(messages.map((message) => [String(message.message_id), message]));
    let currentId = currentMessageId == null ? '' : String(currentMessageId);

    if (!currentId || !byId.has(currentId)) {
      const parentIds = new Set(
        messages
          .map((message) => message.parent_id)
          .filter((id) => id != null)
          .map(String),
      );
      const leaves = messages.filter((message) => !parentIds.has(String(message.message_id)));
      const candidates = leaves.length ? leaves : messages;
      const latest = candidates.slice().sort((a, b) => {
        return timestampMs(a.inserted_at) - timestampMs(b.inserted_at);
      }).at(-1);
      currentId = latest ? String(latest.message_id) : '';
    }

    const path = [];
    const seen = new Set();
    while (currentId && !seen.has(currentId)) {
      seen.add(currentId);
      const message = byId.get(currentId);
      if (!message) break;
      path.push(message);
      currentId = message.parent_id == null ? '' : String(message.parent_id);
    }
    return path.reverse();
  }

  function visibleMessageText(message) {
    const role = String(message.role || '').toUpperCase();
    const accepted = role === 'USER'
      ? new Set(['REQUEST'])
      : new Set(['RESPONSE', 'TEMPLATE_RESPONSE']);
    const fragments = Array.isArray(message.fragments) ? message.fragments : [];
    const parts = fragments
      .filter((fragment) => accepted.has(String(fragment.type || '').toUpperCase()))
      .map((fragment) => (typeof fragment.content === 'string' ? fragment.content.trim() : ''))
      .filter(Boolean);

    if (parts.length) return parts.join('\n\n');
    if (typeof message.content === 'string' && message.content.trim()) return message.content.trim();

    return fragments
      .filter((fragment) => {
        const type = String(fragment.type || '').toUpperCase();
        return !['THINK', 'TOOL_SEARCH', 'TOOL_OPEN', 'SEARCH', 'TIP', 'FILE'].includes(type);
      })
      .map((fragment) => (typeof fragment.content === 'string' ? fragment.content.trim() : ''))
      .filter(Boolean)
      .join('\n\n');
  }

  function extractThinking(message) {
    const fragments = Array.isArray(message.fragments) ? message.fragments : [];
    return fragments
      .filter((fragment) => String(fragment.type || '').toUpperCase() === 'THINK')
      .map((fragment) => normalizeContent(fragment.content))
      .filter(Boolean);
  }

  function collectApiFiles(message) {
    const candidates = [];
    if (Array.isArray(message.files)) candidates.push(...message.files);
    (message.fragments || []).forEach((fragment) => {
      if (String(fragment.type || '').toUpperCase() !== 'FILE') return;
      if (Array.isArray(fragment.files)) candidates.push(...fragment.files);
      if (fragment.file && typeof fragment.file === 'object') candidates.push(fragment.file);
    });

    const seen = new Set();
    const files = [];
    candidates.forEach((file) => {
      if (!file || typeof file !== 'object') return;
      const name = String(file.file_name || file.filename || file.name || 'Attachment');
      const rawUrl = file.signed_path || file.url || file.path || '';
      const url = resolveFileUrl(rawUrl);
      const key = `${name}|${url}`;
      if (seen.has(key)) return;
      seen.add(key);
      files.push({ name, url });
    });
    return files;
  }

  function collectApiReferences(message) {
    const fragments = Array.isArray(message.fragments) ? message.fragments : [];
    const references = [];
    const seen = new Set();

    function visit(value, depth) {
      if (!value || typeof value !== 'object' || depth > 5 || references.length >= 12) return;
      if (Array.isArray(value)) {
        value.forEach((entry) => visit(entry, depth + 1));
        return;
      }
      if (typeof value.url === 'string' && /^https?:\/\//i.test(value.url)) {
        const url = value.url;
        if (!seen.has(url)) {
          seen.add(url);
          references.push({
            url,
            title: String(value.title || value.site_name || value.name || '').trim(),
          });
        }
      }
      Object.values(value).forEach((child) => {
        if (child && typeof child === 'object') visit(child, depth + 1);
      });
    }

    fragments.forEach((fragment) => {
      const type = String(fragment.type || '').toUpperCase();
      if (!['SEARCH', 'TOOL_SEARCH', 'TOOL_OPEN'].includes(type)) return;
      visit(fragment, 0);
    });
    return references.slice(0, 12);
  }

  function resolveFileUrl(value) {
    const raw = String(value || '');
    if (!raw || /^data:/i.test(raw)) return '';
    try {
      return new URL(raw, location.origin).href;
    } catch (_error) {
      return '';
    }
  }

  function findModel(messages) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index] && messages[index].model) return messages[index].model;
    }
    return '';
  }

  function stripCitationMarkers(value) {
    return String(value || '').replace(/\s*\[(?:citation|reference):\d+\]/gi, '');
  }

  function normalizeContent(value) {
    return String(value || '')
      .replace(/\r\n?/g, '\n')
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+\n/g, '\n')
      .trim();
  }

  function timestampMs(value) {
    if (value == null) return 0;
    if (typeof value === 'number') return value < 100000000000 ? value * 1000 : value;
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric < 100000000000 ? numeric * 1000 : numeric;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function toIsoTimestamp(value) {
    const ms = timestampMs(value);
    if (!ms) return '';
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? '' : date.toISOString();
  }

  /* ------------------------------------------------------------------ */
  /* DOM fallback                                                        */
  /* ------------------------------------------------------------------ */

  async function scrapeConversationFromDom(includeReasoning) {
    await waitForMessages(10000);
    const scroller = findConversationScroller();
    const originalTop = scroller ? scroller.scrollTop : 0;
    const collected = [];
    const seen = new Set();

    function collect() {
      for (const node of topLevelMessageNodes()) {
        const parts = extractDomMessageParts(node, includeReasoning);
        for (const part of parts) {
          const content = normalizeContent(part.content);
          if (!content) continue;
          const key = `${part.role}:${hashString(content)}`;
          if (seen.has(key)) continue;
          seen.add(key);
          collected.push({
            role: part.role,
            content,
            thinking: part.thinking || [],
            files: [],
            timestamp: '',
          });
        }
      }
    }

    try {
      if (scroller && scroller.scrollHeight > scroller.clientHeight + 100) {
        await setScrollTop(scroller, 0);
        collect();
        const maxSteps = 90;
        let previousTop = -1;
        let stable = 0;
        for (let step = 0; step < maxSteps; step += 1) {
          const metrics = scrollMetrics(scroller);
          if (metrics.scrollTop + metrics.clientHeight >= metrics.scrollHeight - 8) break;
          const increment = Math.max(320, Math.floor(metrics.clientHeight * 0.78));
          const nextTop = Math.min(
            metrics.scrollTop + increment,
            metrics.scrollHeight - metrics.clientHeight,
          );
          await setScrollTop(scroller, nextTop);
          collect();
          const next = scrollMetrics(scroller);
          if (Math.abs(next.scrollTop - previousTop) < 2) stable += 1;
          else stable = 0;
          previousTop = next.scrollTop;
          if (stable >= 4) break;
        }
        await setScrollTop(scroller, scrollMetrics(scroller).scrollHeight);
        collect();
      } else {
        collect();
      }
    } finally {
      if (scroller) await setScrollTop(scroller, originalTop, true);
    }

    const messages = collected.filter((message) => message.role === 'user' || message.role === 'assistant');
    if (!messages.length) {
      throw createError('NO_MESSAGES', 'No messages were found in the page. Wait for the chat to load and try again.');
    }

    return {
      title: titleFromDocument() || titleFromFirstMessage(messages),
      url: Shared.normalizeChatUrl(location.href, getCurrentChatId()),
      exportedAt: new Date().toISOString(),
      model: modelFromDocument(),
      source: 'dom',
      generating: isGeneratingInDom(),
      messages,
    };
  }

  function waitForMessages(timeoutMs) {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const check = () => {
        if (document.querySelector('.ds-message, .ds-assistant-message-main-content')) {
          window.setTimeout(resolve, 350);
          return;
        }
        if (Date.now() - started >= timeoutMs) {
          reject(createError('PAGE_NOT_READY', 'Timed out waiting for the conversation to load.'));
          return;
        }
        window.setTimeout(check, 250);
      };
      check();
    });
  }

  function topLevelMessageNodes() {
    return Array.from(document.querySelectorAll('.ds-message'))
      .filter((node) => !node.parentElement || !node.parentElement.closest('.ds-message'))
      .filter((node) => cleanText(node.textContent).length > 0);
  }

  function extractDomMessageParts(node, includeReasoning) {
    const assistant = node.querySelector('.ds-assistant-message-main-content');
    if (assistant) {
      const thinking = [];
      if (includeReasoning) {
        node.querySelectorAll('.ds-think-content .ds-markdown, .ds-think-content .ds-markdown-body').forEach((element) => {
          const converted = Markdown.htmlToMarkdown(element);
          if (converted) thinking.push(converted);
        });
      }
      return [{
        role: 'assistant',
        content: Markdown.htmlToMarkdown(assistant),
        thinking,
      }];
    }

    const userNode = findUserContentNode(node);
    if (userNode) {
      return [{
        role: 'user',
        content: Markdown.htmlToMarkdown(userNode),
        thinking: [],
      }];
    }

    return [];
  }

  function findUserContentNode(messageNode) {
    const knownBubble = messageNode.querySelector('.fbb737a4');
    if (knownBubble && cleanText(knownBubble.textContent)) return knownBubble;

    const candidates = Array.from(messageNode.children)
      .filter((child) => !child.matches('button, [role="button"]'))
      .filter((child) => !child.querySelector('.ds-assistant-message-main-content, .ds-think-content'))
      .map((child) => ({
        node: child,
        textLength: cleanText(child.textContent).length,
        buttonCount: child.querySelectorAll('button, [role="button"]').length,
        hasImage: Boolean(child.querySelector('img')),
      }))
      .filter((candidate) => candidate.textLength > 0 || candidate.hasImage)
      .sort((a, b) => {
        return (b.textLength - b.buttonCount * 90) - (a.textLength - a.buttonCount * 90);
      });

    return candidates.length ? candidates[0].node : null;
  }

  function findConversationScroller() {
    const candidates = Array.from(
      document.querySelectorAll(".ds-virtual-list, [class*='ds-scroll-area'], main, [role='main'], div"),
    )
      .filter((element) => {
        const metrics = scrollMetrics(element);
        return (
          metrics.scrollHeight > metrics.clientHeight + 120 &&
          metrics.clientHeight > 160 &&
          Boolean(element.querySelector('.ds-message'))
        );
      })
      .map((element) => {
        const metrics = scrollMetrics(element);
        return {
          element,
          metrics,
          messageCount: element.querySelectorAll('.ds-message').length,
          score: String(element.className || '').includes('ds-virtual-list') ? 2 : 0,
        };
      })
      .sort((a, b) => {
        if (a.score !== b.score) return b.score - a.score;
        if (a.messageCount !== b.messageCount) return b.messageCount - a.messageCount;
        return b.metrics.clientHeight - a.metrics.clientHeight;
      });

    if (candidates.length) return candidates[0].element;

    const documentScroller = document.scrollingElement || document.documentElement;
    return documentScroller && documentScroller.scrollHeight > documentScroller.clientHeight + 120
      ? documentScroller
      : null;
  }

  function setScrollTop(element, value, immediate) {
    element.scrollTop = value;
    element.dispatchEvent(new Event('scroll', { bubbles: true }));
    return new Promise((resolve) => {
      window.setTimeout(resolve, immediate ? 0 : 150);
    });
  }

  function scrollMetrics(element) {
    return {
      scrollTop: element.scrollTop || 0,
      scrollHeight: element.scrollHeight || 0,
      clientHeight: element.clientHeight || 0,
    };
  }

  function cleanText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function hashString(value) {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  function titleFromFirstMessage(messages) {
    const first = messages.find((message) => message.role === 'user');
    if (!first) return '';
    return first.content.replace(/\s+/g, ' ').slice(0, 80);
  }

  function titleFromDocument() {
    const title = String(document.title || '').trim();
    if (!title) return '';
    return cleanTitle(
      title
        .replace(/\s*[|·-]\s*DeepSeek\s*$/i, '')
        .replace(/^DeepSeek\s*[|·-]\s*/i, '')
        .trim(),
    );
  }

  function cleanTitle(value) {
    const title = String(value || '')
      .replace(/\s+/g, ' ')
      .replace(/^["“”']+|["“”']+$/g, '')
      .trim();
    if (!title || /^DeepSeek$/i.test(title) || /^Into the Unknown$/i.test(title)) return '';
    return title;
  }

  function modelFromDocument() {
    const text = cleanText(document.body ? document.body.textContent : '');
    if (/DeepThink|DeepSeek[- ]R1|Reasoner/i.test(text)) return 'DeepSeek Reasoner';
    return 'DeepSeek Chat';
  }

  function isGeneratingInDom() {
    return Boolean(
      document.querySelector(
        'button[aria-label*="stop" i], button[aria-label*="Stop"], [data-testid*="stop" i], [class*="stop-button"], [class*="ds-loading"]',
      ),
    );
  }

  /* ------------------------------------------------------------------ */
  /* Messaging / errors                                                   */
  /* ------------------------------------------------------------------ */

  function sendRuntimeMessage(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        const error = chrome.runtime.lastError;
        if (error) {
          reject(createError('EXTENSION_ERROR', error.message || 'Extension communication failed.'));
          return;
        }
        resolve(response);
      });
    });
  }

  function createError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
  }

  function toErrorResponse(error) {
    return {
      ok: false,
      code: (error && error.code) || 'UNKNOWN',
      message: (error && error.message) || 'Something went wrong while reading this conversation.',
    };
  }

})();
