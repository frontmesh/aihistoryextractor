'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseUserToken,
  getChatId,
  normalizeChatUrl,
  sanitizeFilename,
  makeFilename,
  modelLabel,
  toDateInputValue,
} = require('../extension/lib/shared.js');

test('parses the known DeepSeek userToken shapes', () => {
  assert.equal(parseUserToken('"abc"'), 'abc');
  assert.equal(parseUserToken(JSON.stringify({ value: 'abc' })), 'abc');
  assert.equal(parseUserToken(JSON.stringify({ token: { value: 'abc' } })), 'abc');
  assert.equal(parseUserToken(JSON.stringify({ access_token: 'abc' })), 'abc');
  assert.equal(parseUserToken('  raw-token  '), 'raw-token');
  assert.equal(parseUserToken(''), null);
});

test('finds chat IDs in both old and current DeepSeek URLs', () => {
  assert.equal(getChatId('https://chat.deepseek.com/a/chat/s/abc123'), 'abc123');
  assert.equal(getChatId('https://chat.deepseek.com/chat/s/abc123?x=1'), 'abc123');
  assert.equal(getChatId('https://chat.deepseek.com/a/chat/s/abc%20123'), 'abc 123');
  assert.equal(getChatId('https://chat.deepseek.com/'), null);
  assert.equal(getChatId('https://example.com/a/chat/s/abc123'), null);
});

test('normalizes conversation URLs', () => {
  assert.equal(
    normalizeChatUrl('https://chat.deepseek.com/a/chat/s/abc123?from=history', 'abc123'),
    'https://chat.deepseek.com/a/chat/s/abc123',
  );
});

test('sanitizes filenames for Windows, macOS and Linux', () => {
  assert.equal(sanitizeFilename('My / chat: "notes"', 'fallback'), 'My - chat- -notes.md');
  assert.equal(sanitizeFilename('   ', 'Fallback title'), 'Fallback title.md');
  assert.equal(sanitizeFilename('CON', 'fallback'), '_CON.md');
  assert.equal(sanitizeFilename('Already.md', 'fallback'), 'Already.md');
  assert(!sanitizeFilename('a'.repeat(300), 'fallback').includes('/'));
  assert(sanitizeFilename('a'.repeat(300), 'fallback').length <= 113);
});

test('builds dated filenames', () => {
  const date = new Date(2026, 10, 6, 12, 0, 0);
  assert.equal(toDateInputValue(date), '2026-11-06');
  assert.equal(makeFilename('A title', date, 'standard-summary'), 'A title - 2026-11-06 - standard-summary.md');
});

test('maps DeepSeek model identifiers to friendly labels', () => {
  assert.equal(modelLabel('deepseek_reasoner'), 'DeepSeek Reasoner');
  assert.equal(modelLabel('deepseek-reasoner'), 'DeepSeek Reasoner');
  assert.equal(modelLabel('deepseek_vl'), 'DeepSeek Vision');
  assert.equal(modelLabel('deepseek_chat'), 'DeepSeek Chat');
  assert.equal(modelLabel(''), 'DeepSeek');
});
