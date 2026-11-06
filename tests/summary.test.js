'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  buildMarkdown,
  cleanForSummary,
  splitSentences,
  tokenize,
  finishPoint,
  truncate,
} = require('../extension/lib/summarize.js');

const history = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures/history.json'), 'utf8'),
).data.biz_data;

function conversationFromFixture() {
  const messages = [];
  for (const message of history.chat_messages) {
    if (!['u1', 'a1', 'u2', 'a2'].includes(message.message_id)) continue;
    const role = message.role === 'USER' ? 'user' : 'assistant';
    const content = (message.fragments || [])
      .filter((fragment) => ['REQUEST', 'RESPONSE'].includes(fragment.type))
      .map((fragment) => fragment.content)
      .join('\n\n');
    const references = [];
    for (const fragment of message.fragments || []) {
      if (fragment.type === 'TOOL_SEARCH') {
        for (const result of fragment.results || []) {
          references.push({ url: result.url, title: result.title });
        }
      }
    }
    messages.push({
      role,
      content,
      thinking: (message.fragments || [])
        .filter((fragment) => fragment.type === 'THINK')
        .map((fragment) => fragment.content),
      files: (message.files || []).map((file) => ({
        name: file.file_name,
        url: `https://chat.deepseek.com${file.signed_path}`,
      })),
      references,
      timestamp: message.inserted_at,
    });
  }
  return {
    title: history.chat_session.title,
    url: 'https://chat.deepseek.com/a/chat/s/test-chat',
    exportedAt: '2026-11-06T10:15:00.000Z',
    model: 'DeepSeek Reasoner',
    messages,
  };
}

test('builds a complete Markdown summary', () => {
  const markdown = buildMarkdown(conversationFromFixture(), {
    depth: 'standard',
    includeTranscript: true,
    includeReasoning: true,
  });

  assert.match(markdown, /^---\ntitle: "Fix a flaky Playwright test"/);
  assert.match(markdown, /^# Fix a flaky Playwright test/m);
  assert.match(markdown, /## At a glance/);
  assert.match(markdown, /## Key points/);
  assert.match(markdown, /## Conversation outline/);
  assert.match(markdown, /## Action items/);
  assert.match(markdown, /## Code & files/);
  assert.match(markdown, /## Links mentioned/);
  assert.match(markdown, /## Full transcript/);
  assert.match(markdown, /1 ts block/);
  assert.match(markdown, /flaky-trace\.zip/);
  assert.match(markdown, /playwright\.dev\/docs\/test-retries/);
  assert.match(markdown, /playwright\.dev\/docs\/actionability/, 'search metadata sources should be linked');
  assert.match(markdown, /Reasoning \(70 characters\)/);
  assert.match(markdown, /```ts\nawait page\.waitForResponse/);
});

test('includes reasoning only once per assistant message', () => {
  const markdown = buildMarkdown(conversationFromFixture(), {
    depth: 'standard',
    includeTranscript: true,
    includeReasoning: true,
  });

  const details = markdown.match(/<details>/g) || [];
  assert.equal(details.length, 2, 'only the two assistant messages should have reasoning blocks');
  assert(!markdown.includes('Reasoning (0 characters)'));
  assert(!markdown.includes('Reasoning (1 characters)'));
});

test('omits transcript and reasoning when not requested', () => {
  const markdown = buildMarkdown(conversationFromFixture(), {
    depth: 'detailed',
    includeTranscript: false,
    includeReasoning: true,
  });

  assert(!markdown.includes('## Full transcript'));
  assert(!markdown.includes('<details>'));
  assert(!markdown.includes('I should check whether'));
  assert.match(markdown, /## Key points/);
});

test('deduplicates overlapping summary points and removes low-value link lines', () => {
  const markdown = buildMarkdown(conversationFromFixture(), {
    depth: 'standard',
    includeTranscript: false,
  });
  const keyPoints = markdown.split('## Key points')[1].split('## Conversation outline')[0];

  assert.equal(
    (keyPoints.match(/Retries are a diagnostic tool, not a fix\./g) || []).length,
    1,
    'the short and contextual versions of the same point should not both appear',
  );
  assert(!keyPoints.includes('See the Playwright retries guide'));
  assert(!/:\s*\n/.test(keyPoints), 'a bullet should not end with a dangling colon');
});

test('brief output is shorter than detailed output', () => {
  const brief = buildMarkdown(conversationFromFixture(), {
    depth: 'brief',
    includeTranscript: false,
  });
  const detailed = buildMarkdown(conversationFromFixture(), {
    depth: 'detailed',
    includeTranscript: false,
  });

  assert(brief.length < detailed.length);
  assert(brief.includes('## At a glance'));
  assert(!brief.includes('## Links mentioned'));
});

test('cleans code, links and citations out of extractive text', () => {
  const cleaned = cleanForSummary([
    '# Heading',
    'A **useful** result with [a link](https://example.com) and a citation.[reference:2]',
    '```js',
    'const hidden = true;',
    '```',
  ].join('\n'));

  assert(cleaned.includes('A useful result with a link and a citation.'));
  assert(!cleaned.includes('const hidden'));
  assert(!cleaned.includes('https://example.com'));
  assert(!cleaned.includes('[reference:2]'));
});

test('splits sentences and tokenizes without stop words', () => {
  assert.deepEqual(
    splitSentences('First sentence. Second sentence? Third!'),
    ['First sentence.', 'Second sentence?', 'Third!'],
  );
  const tokens = tokenize('The Playwright test is using retries and a trace.');
  assert(tokens.includes('playwright'));
  assert(tokens.includes('retries'));
  assert(!tokens.includes('the'));
  assert(!tokens.includes('and'));
});

function markdownSection(markdown, heading) {
  const start = markdown.indexOf(heading);
  assert(start >= 0, `missing section: ${heading}`);
  const rest = markdown.slice(start + heading.length);
  const next = rest.search(/\n## /);
  return next === -1 ? rest : rest.slice(0, next);
}

function conversationWithLeadingTangent() {
  return {
    title: 'Analyzing an online relationship with an acquaintance',
    url: 'https://chat.deepseek.com/a/chat/s/tangent',
    exportedAt: '2026-11-06T12:00:00.000Z',
    model: 'DeepSeek',
    messages: [
      { role: 'user', content: 'Can i just export history in one chat from WhatsApp' },
      {
        role: 'assistant',
        content:
          'Yes, you can export a single WhatsApp chat. Open the chat, tap the contact name, choose Export chat, and pick whether to include media.',
      },
      {
        role: 'user',
        content:
          'Okay different topic. I have been talking to an acquaintance online for about four months. She replies warmly but sometimes takes days, and I cannot tell if she is interested or just being polite. Can you help me analyze the relationship and what her signals might mean?',
      },
      {
        role: 'assistant',
        content:
          'Warm replies show she is comfortable, but slow replies suggest the relationship is not her priority right now. Look at who starts conversations, whether she asks questions back, and whether she moves toward meeting. Mixed signals usually mean mixed feelings, not a hidden message. Set a boundary for how much uncertainty you are willing to tolerate.',
      },
      {
        role: 'user',
        content: 'What should I say when she takes days to reply? I do not want to seem desperate.',
      },
      {
        role: 'assistant',
        content:
          'Keep your message light and do not comment on the delay. Ask a specific question about something she mentioned, or share something small from your day. Match her pace rather than chasing. If she consistently takes days, mirror that rhythm and invest elsewhere too.',
      },
    ],
  };
}

test('keeps a leading side question out of the at-a-glance and key points', () => {
  const markdown = buildMarkdown(conversationWithLeadingTangent(), {
    depth: 'detailed',
    includeTranscript: true,
  });

  const glance = markdownSection(markdown, '## At a glance');
  assert.match(glance, /acquaintance/, 'the headline should describe the main thread');
  assert(!/whatsapp/i.test(glance), 'the side question should not be the headline');
  assert(!/different topic/i.test(glance), 'conversational lead-ins should be trimmed');

  const keyPoints = markdownSection(markdown, '## Key points');
  assert(!/whatsapp|export chat|contact name/i.test(keyPoints), 'side-topic answers should not become key points');

  const actions = markdownSection(markdown, '## Action items');
  assert(!/whatsapp|export chat|contact name/i.test(actions), 'side-topic steps should not become action items');

  assert.match(
    markdown,
    /### 1\. Can i just export history in one chat from WhatsApp/,
    'the side question should remain in the conversation outline',
  );
  assert.match(markdown, /Can i just export history in one chat from WhatsApp/, 'the transcript should keep it');
});

test('opens the headline on the first substantial question after a greeting', () => {
  const markdown = buildMarkdown(
    {
      title: 'Centering a div',
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'Hello! How can I help you today?' },
        {
          role: 'user',
          content: 'How do I center a div horizontally and vertically in CSS?',
        },
        {
          role: 'assistant',
          content:
            'Use flexbox on the parent with display: flex; align-items: center; justify-content: center; and min-height: 100vh. Grid with place-items: center also works. Avoid absolute positioning hacks because they break when content grows.',
        },
      ],
    },
    { depth: 'standard', includeTranscript: false },
  );

  const glance = markdownSection(markdown, '## At a glance');
  assert.match(glance, /center a div horizontally and vertically/i);
  assert(!/\*\*You asked:\*\* hi\b/i.test(glance));
});

test('keeps the opening question when it defines the chat', () => {
  const markdown = buildMarkdown(conversationFromFixture(), {
    depth: 'standard',
    includeTranscript: false,
  });
  const glance = markdownSection(markdown, '## At a glance');
  assert.match(glance, /\*\*You asked:\*\* My Playwright test fails intermittently/);
});

test('leaves a mid-chat side question out of the headline and key points', () => {
  const markdown = buildMarkdown(
    {
      title: 'Reading the signals',
      messages: [
        {
          role: 'user',
          content:
            'I have been talking to an acquaintance online and cannot read her signals. Can you help me analyze the relationship?',
        },
        {
          role: 'assistant',
          content:
            'Warm but slow replies suggest she is comfortable but not prioritizing the relationship. Look at who starts conversations and whether she moves toward meeting. Mixed signals usually mean mixed feelings. Set a boundary for how much uncertainty you will tolerate.',
        },
        { role: 'user', content: 'Unrelated: can I export a WhatsApp chat history?' },
        {
          role: 'assistant',
          content:
            'Yes, open the chat, tap the contact name, choose Export chat, and pick whether to include media.',
        },
        { role: 'user', content: 'Back to her: she takes days to reply. What should I say?' },
        {
          role: 'assistant',
          content:
            'Keep your message light and do not comment on the delay. Match her pace rather than chasing, and invest elsewhere too.',
        },
      ],
    },
    { depth: 'detailed', includeTranscript: false },
  );

  const glance = markdownSection(markdown, '## At a glance');
  assert.match(glance, /analyze the relationship/);
  assert(!/whatsapp|open the chat, tap the contact name/i.test(glance));

  const keyPoints = markdownSection(markdown, '## Key points');
  assert(!/whatsapp|export chat|contact name/i.test(keyPoints));

  const outline = markdownSection(markdown, '## Conversation outline');
  assert.match(outline, /Unrelated: can I export a WhatsApp chat history\?/);
});

function longRelationshipAnalysis() {
  return [
    'Warm replies show she is comfortable with you, but slow replies suggest the relationship is not her priority right now and that is useful information.',
    'Look at who starts conversations, whether she asks questions back, and whether she moves toward meeting; reciprocity is the clearest signal you can observe.',
    'Mixed signals usually mean mixed feelings rather than a hidden message, and waiting for certainty will keep you stuck in the same loop for months.',
    'Set a boundary for how much uncertainty you are willing to tolerate, and decide in advance what you will do if the pattern does not change.',
    'Do not over-invest before you see reciprocal effort, because one-sided effort slowly turns affection into resentment and resentment into self-doubt.',
    'Keep your own life full while you wait, and make sure your sense of worth is not resting on how quickly she answers a message.',
    'The goal is not to decode her but to notice whether the relationship gives you energy, clarity, and a reason to keep showing up.',
  ].join(' ');
}

test('normalizes curly apostrophes so contractions remain stop words', () => {
  const terms = tokenize('People don’t always say what they mean, and you’re right.');
  assert(!terms.includes("don't"), 'curly don’t should normalize to the stop word');
  assert(!terms.includes("you're"), 'curly you’re should normalize to the stop word');
  assert(terms.includes('people'));
});

test('keeps contractions and generic filler out of the topic line', () => {
  const markdown = buildMarkdown(
    {
      title: 'Reading signals',
      messages: [
        {
          role: 'user',
          content: 'How do I read the relationship signals when her replies are slow?',
        },
        {
          role: 'assistant',
          content:
            'People don’t always say what they mean, and you’re right to want clarity. The relationship needs honest signals, and slow replies are one signal. One conversation about expectations is clearer than guessing.',
        },
      ],
    },
    { depth: 'standard', includeTranscript: false },
  );

  const glance = markdownSection(markdown, '## At a glance');
  const topicsLine = glance.split('\n').find((line) => line.startsWith('- **Topics:**'));
  assert(topicsLine, 'a topic line should be present');
  assert(!/don’t|you’re/i.test(topicsLine), 'curly contractions should not be topics');
  assert(!/\b(?:people|person|one|back)\b/i.test(topicsLine), 'generic filler should not be topics');
});

test('excludes a leading side question from links and references', () => {
  const markdown = buildMarkdown(
    {
      title: 'Reading signals',
      messages: [
        { role: 'user', content: 'Can I export a WhatsApp chat history?' },
        {
          role: 'assistant',
          content: 'Yes. Open Export. See https://wa.example/export for details.',
        },
        {
          role: 'user',
          content:
            'Okay different topic. I have been talking to an acquaintance online and she replies warmly but takes days. Can you analyze the relationship?',
        },
        {
          role: 'assistant',
          content: `${longRelationshipAnalysis()} See https://rel.example/guide for more.`,
        },
        { role: 'user', content: 'What should I say when she takes days to reply?' },
        {
          role: 'assistant',
          content: 'Keep your message light and do not comment on the delay. Match her pace rather than chasing.',
        },
      ],
    },
    { depth: 'standard', includeTranscript: false },
  );

  const glance = markdownSection(markdown, '## At a glance');
  assert.match(glance, /analyze the relationship/);
  assert(!/whatsapp|export a whatsapp/i.test(glance));

  const links = markdownSection(markdown, '## Links mentioned');
  assert.match(links, /rel\.example\/guide/);
  assert(!/wa\.example/.test(links), 'the side question links should not be collected');
});

test('turns advice into readable actions and drops quotes and offers', () => {
  const markdown = buildMarkdown(
    {
      title: 'Next steps',
      messages: [
        {
          role: 'user',
          content:
            'I have been talking to an acquaintance online and cannot read her signals. Can you help me analyze the relationship and what to do?',
        },
        {
          role: 'assistant',
          content: [
            'Warm replies show she is comfortable, but slow replies suggest the relationship is not her priority. Set a boundary for how much uncertainty you are willing to tolerate.',
            'Examples: “you might want to work on yourself”; “if you love him you need to let him go”.',
            'Yes—you can share the exported chat with me here, and I can read through it.',
            'You need to become someone whose anger arrives on time.',
            'Write the pattern down once — one paragraph.',
            'It’s not that you should have been quiet.',
            'Keep your message light and do not comment on the delay.',
            'First, check the trace timeline before changing anything else.',
          ].join(' '),
        },
      ],
    },
    { depth: 'detailed', includeTranscript: false },
  );

  const actions = markdownSection(markdown, '## Action items');
  assert.match(actions, /Become someone whose anger arrives on time/);
  assert.match(actions, /Set a boundary/);
  assert.match(actions, /Write the pattern down once/);
  assert.match(actions, /Check the trace timeline/, 'a leading "First," should still become an action');
  assert(!/examples|share the exported chat|it’s not that you should/i.test(actions));
});

test('closes quotations and completes points instead of cutting them mid-air', () => {
  assert.equal(
    finishPoint('He said “I am trying to punish myself', 440),
    'He said “I am trying to punish myself.”',
  );
  assert.equal(finishPoint('his age, work, burnout', 440), 'His age, work, burnout.');
  assert.equal(finishPoint('But notice: he used that one word.', 440), 'He used that one word.');

  const cut = truncate('Set a boundary for how much uncertainty you are willing to tolerate and', 40);
  assert.match(cut, /…$/, 'truncated text should end with an ellipsis');
  assert(!/\band…$/.test(cut), 'a dangling conjunction should be removed');
});

test('turns markdown headings into readable context instead of run-on points', () => {
  const markdown = buildMarkdown(
    {
      title: 'Patterns',
      messages: [
        {
          role: 'user',
          content: 'Can you explain why he behaves this way and what I should do about it?',
        },
        {
          role: 'assistant',
          content: [
            '### The cycle',
            'He shares pain, you advise, he feels judged, you get blunt, and he calls you aggressive.',
            '',
            '**Why realisation is possible but not guaranteed**',
            'He does have moments of self-awareness: “I was passive aggressive and stubborn”.',
          ].join('\n'),
        },
      ],
    },
    { depth: 'detailed', includeTranscript: false },
  );

  assert.match(markdown, /The cycle: He shares pain/);
  assert.match(markdown, /Why realisation is possible but not guaranteed: He does/);
  assert(!markdown.includes('\u0001'), 'the internal heading marker must not reach the export');
});

test('does not duplicate an outline point when a pronoun repeats the previous sentence', () => {
  const markdown = buildMarkdown(
    {
      title: 'Patterns',
      messages: [
        {
          role: 'user',
          content: 'Why does he flip positions so often, and what does that mean for the friendship?',
        },
        {
          role: 'assistant',
          content:
            'What is evidenced is emotional and rhetorical 180s — flipping positions, moods, and stances from one conversation to the next. He asks how people can move on so easily while his own positions, moods, and statements flip constantly depending on the moment.',
        },
      ],
    },
    { depth: 'detailed', includeTranscript: false },
  );

  const outline = markdownSection(markdown, '## Conversation outline');
  assert.equal(
    (outline.match(/What is evidenced/g) || []).length,
    1,
    'the short and context-prefixed versions should collapse into one point',
  );
  assert.match(outline, /He asks how people can move on/, 'the longer, more informative point should survive');
});
