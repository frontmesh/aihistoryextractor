/*
 * DeepSeek Chat Exporter - shared helpers.
 *
 * This file is loaded as a classic script by the service worker, offscreen
 * document and content script. It intentionally has no dependencies.
 */
(function initShared(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.DSExporterShared = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function sharedFactory() {
  'use strict';

  const VERSION = '1.0.0';
  const CHAT_HOST = 'chat.deepseek.com';

  /**
   * DeepSeek stores the current web session token in localStorage.userToken.
   * Depending on the release it is either a raw string or JSON such as
   * {"value":"..."} / {"token":"..."}.
   */
  function parseUserToken(raw) {
    if (!raw) return null;

    function findToken(value, depth) {
      if (depth > 4) return null;
      if (typeof value === 'string') {
        const trimmed = value.trim();
        return trimmed || null;
      }
      if (!value || typeof value !== 'object') return null;

      return (
        findToken(value.value, depth + 1) ||
        findToken(value.token, depth + 1) ||
        findToken(value.access_token, depth + 1) ||
        findToken(value.accessToken, depth + 1)
      );
    }

    try {
      return findToken(JSON.parse(raw), 0) || raw.trim() || null;
    } catch (_error) {
      return raw.trim() || null;
    }
  }

  function getChatId(url) {
    try {
      const parsed = new URL(url);
      if (parsed.hostname !== CHAT_HOST) return null;
      const match = parsed.pathname.match(/\/(?:a\/)?chat\/s\/([^/?#]+)/);
      return match ? decodeURIComponent(match[1]) : null;
    } catch (_error) {
      return null;
    }
  }

  function normalizeChatUrl(url, chatId) {
    const id = chatId || getChatId(url);
    if (!id) return url;
    return `https://${CHAT_HOST}/a/chat/s/${encodeURIComponent(id)}`;
  }

  function sanitizeFilename(value, fallback) {
    const base = (fallback || 'DeepSeek chat').replace(/\.md$/i, '');
    let name = String(value || '')
      .replace(/\.md$/i, '')
      .replace(/[\u0000-\u001f<>:"/\\|?*]/g, '-')
      .replace(/\s+/g, ' ')
      .replace(/^[.\s-]+|[.\s-]+$/g, '')
      .trim();

    if (!name) name = base;
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name)) name = `_${name}`;
    if (name.length > 110) {
      name = name.slice(0, 110).replace(/\s+\S*$/, '').trim();
    }
    name = truncateUtf8(name, 180);
    return `${name || base}.md`;
  }

  function truncateUtf8(value, maxBytes) {
    let text = String(value || '');
    if (typeof TextEncoder === 'undefined') return text.slice(0, Math.max(1, Math.floor(maxBytes / 3)));
    const encoder = new TextEncoder();
    while (text && encoder.encode(text).length > maxBytes) {
      text = text.slice(0, -1);
    }
    return text;
  }

  function makeFilename(title, date, suffix) {
    const day = toDateInputValue(date || new Date());
    const label = suffix || 'summary';
    const rawTitle = String(title || 'DeepSeek chat').replace(/\s+/g, ' ').trim();
    let shortTitle = rawTitle.slice(0, 80);
    if (rawTitle.length > 80) shortTitle = shortTitle.replace(/\s+\S*$/, '').trim();
    return sanitizeFilename(`${shortTitle || 'DeepSeek chat'} - ${day} - ${label}`);
  }

  function toDateInputValue(value) {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return 'unknown-date';
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  function formatDisplayDate(value) {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return 'Unknown date';
    return date.toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  }

  function formatDisplayTime(value) {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  function escapeYaml(value) {
    return JSON.stringify(String(value == null ? '' : value));
  }

  function escapeMarkdownHeading(value) {
    return String(value || '')
      .replace(/\\/g, '\\\\')
      .replace(/[\r\n]+/g, ' ')
      .replace(/([`*_[\]<>#])/g, '\\$1')
      .trim();
  }

  function countWords(text) {
    if (!text) return 0;
    const words = String(text).match(/[\p{L}\p{N}]+(?:['’_-][\p{L}\p{N}]+)*/gu);
    return words ? words.length : 0;
  }

  /**
   * Attempt a rough model label from a DeepSeek model identifier.
   */
  function modelLabel(value) {
    const raw = String(value || '').toLowerCase();
    if (!raw) return 'DeepSeek';
    if (/reason|think|r1|v4-pro|pro/.test(raw)) return 'DeepSeek Reasoner';
    if (/vision|vl/.test(raw)) return 'DeepSeek Vision';
    return 'DeepSeek Chat';
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  return {
    VERSION,
    CHAT_HOST,
    parseUserToken,
    getChatId,
    normalizeChatUrl,
    sanitizeFilename,
    makeFilename,
    toDateInputValue,
    formatDisplayDate,
    formatDisplayTime,
    escapeYaml,
    escapeMarkdownHeading,
    countWords,
    modelLabel,
    clamp,
    truncateUtf8,
  };
});
