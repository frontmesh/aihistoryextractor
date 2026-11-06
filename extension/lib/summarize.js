/*
 * DeepSeek Chat Exporter - local summary engine.
 *
 * No network calls and no third-party libraries. The summary is extractive:
 * it selects the most informative sentences from the assistant's answers,
 * then adds a question-by-question outline, action items and metadata.
 */
(function initSummarize(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.DSExporterSummarize = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function summarizeFactory() {
  'use strict';

  const DEPTHS = {
    brief: { keyPoints: 4, outline: 3, actions: 2, links: 0, answerPoints: 1, label: 'Brief' },
    standard: { keyPoints: 8, outline: 7, actions: 4, links: 6, answerPoints: 1, label: 'Standard' },
    detailed: { keyPoints: 12, outline: 18, actions: 8, links: 12, answerPoints: 2, label: 'Detailed' },
  };

  const STOPWORDS = new Set(`
    a about above after again against all am an and any are aren't as at be because been
    before being below between both but by can can't cannot could couldn't did didn't do
    does doesn't doing don't down during each few for from further had hadn't has hasn't
    have haven't having he he'd he'll he's her here here's hers herself him himself his how
    how's i i'd i'll i'm i've if in into is isn't it it's its itself let's me more most
    mustn't my myself no nor not of off on once only or other ought our ours ourselves out
    over own same shan't she she'd she'll she's should shouldn't so some such than that
    that's the their theirs them themselves then there there's these they they'd they'll
    they're they've this those through to too under until up very was wasn't we we'd we'll
    we're we've were weren't what what's when when's where where's which while who who's
    whom why why's with won't would wouldn't you you'd you'll you're you've your yours
    yourself yourselves whether whose via per
    also just like likely may might must need needs now often really should simply still
    then use used useful using want wants way ways will would
    keep keeps see sees say says tell tells ask asks try tries become becomes give gives
    focus notice notices seem seems look looks feel feels find finds think thinks know knows
    deepseek assistant answer answers chat conversation question questions response
    sure certainly absolutely okay ok great good happy help hope let's
  `.trim().split(/\s+/));

  const ACTION_START = /^(?:run|install|open|click|add|remove|set|use|try|check|make|ensure|create|update|download|navigate|configure|replace|avoid|keep|start|stop|enable|disable|call|import|define|write|put|move|copy|delete|verify|test|deploy|commit|read|review|ask|choose|select|provide|consider|apply|build|change|edit|save|export|reload|restart|authenticate|sign|log|upload|pass|return|include|exclude|store|load|send|fetch|parse|validate|generate|publish|become|say|tell|share|respond|reply|match|mirror|invest|mute|restrict|pause|wait|listen|practice|decide|plan|give|focus|limit|notice|name|hold|offer|reach|leave|walk|breathe|step|block|unfollow)\b/i;

  const ACTION_MODAL = /^(?:you\s+(?:should|need to|must|can|could|might want to)|try to|make sure to|be sure to|remember to)\s+/i;

  const ASSISTANT_OFFER = /^(?:yes|sure|of course|absolutely)\b|(?:^|\b)(?:let me know|feel free to|I can (?:read|take a look|help|summarize|check))\b/i;

  const SIGNAL_WORDS = /\b(?:important|key|recommend(?:ed|ation)?|should|must|need(?:s)? to|steps?|first|second|third|finally|conclusion|in short|in summary|note that|remember|avoid|best practice|instead|because|therefore|so that|make sure|for example|for instance)\b/i;

  const DISCLAIMER = /^(?:deepseek can make mistakes|ai-generated|please verify|this is not (?:financial|medical|legal) advice)/i;

  function buildMarkdown(conversation, options) {
    const settings = options || {};
    const depthKey = DEPTHS[settings.depth] ? settings.depth : 'standard';
    const depth = DEPTHS[depthKey];
    const includeTranscript = settings.includeTranscript !== false;
    const includeReasoning = Boolean(settings.includeReasoning);
    const messages = normalizeMessages((conversation && conversation.messages) || []);
    const title = cleanInline(conversation && conversation.title) || 'DeepSeek conversation';
    const url = (conversation && conversation.url) || '';
    const exportedAt = (conversation && conversation.exportedAt) || new Date().toISOString();
    const model = (conversation && conversation.model) || '';
    const summary = summarize(messages, depth, depthKey);

    const lines = [];
    lines.push('---');
    lines.push(`title: ${yaml(title)}`);
    if (url) lines.push(`source: ${yaml(url)}`);
    lines.push(`exported: ${yaml(exportedAt)}`);
    lines.push(`messages: ${messages.length}`);
    lines.push(`summary_style: ${yaml(depthKey)}`);
    if (model) lines.push(`model: ${yaml(model)}`);
    lines.push('exporter: "DeepSeek Chat Exporter 1.0.0"');
    lines.push('---', '');

    lines.push(`# ${escapeHeading(title)}`, '');
    lines.push(`> Exported from [DeepSeek](${url || 'https://chat.deepseek.com'}) on **${formatDate(exportedAt)}** · **${messages.length}** ${messages.length === 1 ? 'message' : 'messages'}${model ? ` · **${model}**` : ''}`);
    lines.push('');
    lines.push(`_Local ${depth.label.toLowerCase()} summary, generated entirely in your browser.${includeTranscript ? ' The full transcript is included below.' : ' The full transcript is not included.'}_`);
    lines.push('');

    lines.push('## At a glance', '');
    if (summary.mainQuestion) {
      lines.push(`- **You asked:** ${summary.mainQuestion}`);
    }
    if (summary.bottomLine) {
      lines.push(`- **Bottom line:** ${summary.bottomLine}`);
    }
    if (summary.topics.length) {
      lines.push(`- **Topics:** ${summary.topics.join(' · ')}`);
    }
    if (!summary.mainQuestion && !summary.bottomLine) {
      lines.push('_No assistant response was found in this conversation._');
    }
    lines.push('');

    if (summary.keyPoints.length) {
      lines.push('## Key points', '');
      summary.keyPoints.forEach((point) => lines.push(`- ${point}`));
      lines.push('');
    }

    if (summary.outline.length) {
      lines.push('## Conversation outline', '');
      summary.outline.forEach((turn) => {
        lines.push(`### ${turn.number}. ${turn.question}`);
        if (turn.points.length) {
          turn.points.forEach((point) => lines.push(`- ${point}`));
        } else {
          lines.push('_No response was recorded for this turn._');
        }
        lines.push('');
      });
      if (summary.outlineNote) {
        lines.push(`_${summary.outlineNote}_`, '');
      }
    }

    if (summary.actions.length) {
      lines.push('## Action items', '');
      summary.actions.forEach((action) => lines.push(`- [ ] ${action}`));
      lines.push('');
    }

    if (summary.code.length || summary.files.length) {
      lines.push('## Code & files', '');
      if (summary.code.length) {
        lines.push(`- **Code:** ${summary.code.join(', ')}`);
      }
      summary.files.forEach((file) => {
        const name = escapeLinkText(file.name);
        lines.push(`- **File:** ${file.url ? `[${name}](${file.url})` : name}`);
      });
      lines.push('');
    }

    if (summary.links.length) {
      lines.push('## Links mentioned', '');
      summary.links.forEach((link) => {
        lines.push(`- [${escapeLinkText(link.title || link.url)}](${link.url})`);
      });
      lines.push('');
    }

    if (includeTranscript) {
      lines.push('## Full transcript', '');
      if (!messages.length) {
        lines.push('_No messages could be read from this conversation._', '');
      } else {
        messages.forEach((message, index) => {
          lines.push(`### ${message.role === 'user' ? 'You' : 'DeepSeek'}`);
          const timestamp = formatTimestamp(message.timestamp);
          if (timestamp) lines.push(`_${timestamp}_`);
          lines.push('');
          if (message.role === 'assistant' && message.thinking && message.thinking.length && includeReasoning) {
            const reasoning = message.thinking.join('\n\n');
            lines.push('<details>');
            lines.push(`<summary>Reasoning (${reasoning.length.toLocaleString()} characters)</summary>`);
            lines.push('');
            lines.push(reasoning, '');
            lines.push('</details>', '');
          }
          lines.push(message.content.trim(), '');
          if (message.files && message.files.length) {
            message.files.forEach((file) => {
              const name = escapeLinkText(file.name);
              lines.push(`- Attachment: ${file.url ? `[${name}](${file.url})` : name}`);
            });
            lines.push('');
          }
          if (index < messages.length - 1) lines.push('---', '');
        });
      }
    }

    lines.push('');
    lines.push('<!-- Generated locally by DeepSeek Chat Exporter. -->');
    return `${lines.join('\n').replace(/\n+$/, '')}\n`;
  }

  function summarize(messages, depth, depthKey) {
    const userMessages = messages.filter((message) => message.role === 'user' && message.content);
    const assistantMessages = messages.filter((message) => message.role === 'assistant' && message.content);
    const cohesion = analyzeCohesion(messages);
    let mainTurn = selectMainTurn(cohesion);
    let tangent = findTangents(cohesion, mainTurn);
    if (mainTurn && tangent.has(mainTurn.userIndex)) {
      const connected = cohesion.turns.filter((turn) => !tangent.has(turn.userIndex));
      if (connected.length) {
        mainTurn = selectMainTurn(cohesion, connected);
        tangent = findTangents(cohesion, mainTurn);
      }
    }
    const mainQuestion = mainTurn
      ? truncate(cleanQuestion(messages[mainTurn.userIndex].content), 270)
      : '';

    const candidates = collectCandidates(messages);
    const mainCandidates = tangent.size
      ? candidates.filter((candidate) => !tangent.has(candidate.messageIndex))
      : candidates;
    const summaryCandidates = mainCandidates.length ? mainCandidates : candidates;

    const queryTerms = topTerms(userMessages.map((message) => message.content).join('\n'), 24, { frequencyOnly: true });
    const querySet = new Set(queryTerms);
    scoreCandidates(candidates, querySet);
    const keyPoints = selectKeyPoints(summaryCandidates, depth.keyPoints);

    const contextualPoint = keyPoints.find((point) => !/^(?:it|they|this|that|these|those|he|she)\b/i.test(point));
    const bottomParts = [];
    if (keyPoints.length) {
      const primary = contextualPoint || keyPoints[0];
      bottomParts.push(primary);
      if (keyPoints[1] && keyPoints[1] !== primary) bottomParts.push(keyPoints[1]);
    }
    const bottomLine = bottomParts.length
      ? truncate(bottomParts.join(' '), 430)
      : truncate(cleanInline(assistantMessages.at(-1)?.content || ''), 430);

    const topicStopwords = new Set([
      'page', 'pages', 'await', 'run', 'runs', 'code', 'file', 'files', 'example', 'examples',
      'step', 'steps', 'thing', 'things', 'way', 'ways', 'time', 'times', 'case', 'cases',
      'make', 'makes', 'made', 'get', 'gets', 'got', 'let', 'lets',
      'people', 'person', 'persons', 'one', 'ones', 'back', 'something', 'anything',
      'everything', 'nothing', 'someone', 'anyone', 'everyone', 'lot', 'lots', 'bit',
      'bits', 'part', 'parts', 'sort', 'kind', 'stuff',
    ]);
    const topics = [];
    const seenTopicStems = new Set();
    const centralMessages = tangent.size
      ? assistantMessages.filter((message) => !tangent.has(messages.indexOf(message)))
      : assistantMessages;
    const centralUserMessages = tangent.size
      ? userMessages.filter((message) => !tangent.has(messages.indexOf(message)))
      : userMessages;
    const topicMessages = [...centralUserMessages, ...centralMessages];
    const topicSource = (topicMessages.length ? topicMessages : [...userMessages, ...assistantMessages])
      .map((message) => (message.role === 'user' ? cleanQuestion(message.content) : message.content))
      .join('\n');
    topTerms(topicSource, 18).forEach((term) => {
      if (term.length <= 2 || topicStopwords.has(term) || topics.length >= 6) return;
      const stem = topicStem(term);
      if (seenTopicStems.has(stem)) return;
      seenTopicStems.add(stem);
      topics.push(term);
    });

    const outline = buildOutline(messages, candidates, depth, Boolean(keyPoints.length));
    const actions = selectActions(summaryCandidates, depth.actions);
    const code = collectCodeStats(assistantMessages.map((message) => message.content).join('\n\n'));
    const files = collectFiles(messages);
    const linkMessages = tangent.size
      ? assistantMessages.filter((message) => !tangent.has(messages.indexOf(message)))
      : assistantMessages;
    const sources = linkMessages.length ? linkMessages : assistantMessages;
    const references = messages.flatMap((message, index) => (tangent.has(index) ? [] : message.references || []));
    const links = depthKey === 'brief'
      ? []
      : collectLinks(
        sources.map((message) => message.content).join('\n\n'),
        depth.links,
        references,
      );

    return {
      mainQuestion,
      bottomLine,
      topics,
      keyPoints,
      outline: outline.turns,
      outlineNote: outline.note,
      actions,
      code,
      files,
      links,
    };
  }

  /*
   * Measures how much each turn overlaps with the rest of the chat. A one-off
   * aside ("can I export a WhatsApp chat?") shares almost no vocabulary with
   * the other turns, while a real follow-up echoes the thread even when the
   * question itself is phrased differently. findTangents() turns that signal
   * into the set of messages that should stay out of the key points.
   */
  function analyzeCohesion(messages) {
    const turns = [];
    let current = null;

    messages.forEach((message, index) => {
      if (message.role === 'user') {
        current = {
          userIndex: index,
          question: cleanInline(message.content),
          assistantIndexes: [],
          assistantTokens: 0,
          terms: new Set(),
        };
        tokenize(message.content).forEach((term) => current.terms.add(topicStem(term)));
        turns.push(current);
        return;
      }
      if (!current) return;
      current.assistantIndexes.push(index);
      current.assistantTokens += tokenize(message.content).length;
      tokenize(message.content).forEach((term) => current.terms.add(topicStem(term)));
    });

    if (!turns.length) {
      return { turns, coverage: [], maxCoverage: 0 };
    }

    const documentFrequency = new Map();
    turns.forEach((turn) => {
      turn.terms.forEach((term) => {
        documentFrequency.set(term, (documentFrequency.get(term) || 0) + 1);
      });
    });
    const total = turns.length;
    const idf = (term) => Math.log((total + 1) / ((documentFrequency.get(term) || 0) + 0.5)) + 1;

    const coverage = turns.map((turn, index) => {
      const otherTerms = new Set();
      turns.forEach((other, otherIndex) => {
        if (otherIndex === index) return;
        other.terms.forEach((term) => otherTerms.add(term));
      });
      let totalWeight = 0;
      let sharedWeight = 0;
      turn.terms.forEach((term) => {
        const weight = idf(term);
        totalWeight += weight;
        if (otherTerms.has(term)) sharedWeight += weight;
      });
      return totalWeight ? sharedWeight / totalWeight : 0;
    });

    const maxCoverage = Math.max(0, ...coverage);

    return { turns, coverage, maxCoverage };
  }

  function findTangents(cohesion, mainTurn) {
    const tangent = new Set();
    const turns = cohesion.turns;
    if (!turns.length) return tangent;

    const totalTokens = turns.reduce((sum, turn) => sum + turn.assistantTokens, 0);
    const markTurn = (turn) => {
      tangent.add(turn.userIndex);
      turn.assistantIndexes.forEach((messageIndex) => tangent.add(messageIndex));
    };

    // A tiny opening exchange before the real discussion is a preamble, not
    // the topic. This catches the common "quick unrelated question first" case
    // even when a few words (chat, export, message) echo later on.
    if (totalTokens >= 100) {
      let cumulative = 0;
      let anchorIndex = -1;
      for (let index = 0; index < turns.length; index += 1) {
        if (turns[index].assistantTokens >= Math.max(50, totalTokens * 0.05)) {
          anchorIndex = index;
          break;
        }
        cumulative += turns[index].assistantTokens;
      }
      if (anchorIndex > 0 && cumulative > 0 && cumulative <= totalTokens * 0.04) {
        turns.slice(0, anchorIndex).forEach(markTurn);
      }
    }

    // Also catch an isolated side turn anywhere in the chat: it shares almost
    // no vocabulary with the other turns.
    const mainIndex = mainTurn ? turns.indexOf(mainTurn) : -1;
    const mainTokens = mainTurn ? mainTurn.assistantTokens : 0;
    turns.forEach((turn, index) => {
      if (cohesion.coverage[index] >= 0.01) return;
      let isTangent = cohesion.maxCoverage >= 0.02;
      if (!isTangent && mainIndex > index && mainTokens >= 15) {
        isTangent = turn.assistantTokens < mainTokens * 0.3;
      }
      if (isTangent) markTurn(turn);
    });

    return tangent;
  }

  function selectMainTurn(cohesion, poolOverride) {
    if (!cohesion.turns.length) return null;
    const pool = poolOverride && poolOverride.length ? poolOverride : cohesion.turns;
    const substantive = pool.filter((turn) => turn.question && turn.question.length >= 20);
    const candidates = substantive.length ? substantive : pool;
    const first = candidates[0];

    let best = first;
    candidates.forEach((turn) => {
      if (turn.assistantTokens > best.assistantTokens) best = turn;
    });
    // A later turn only takes over when it clearly carries more of the
    // conversation, so ordinary chats keep their opening question.
    if (best !== first && best.assistantTokens >= first.assistantTokens * 1.35) {
      return best;
    }
    return first;
  }

  function normalizeMessages(messages) {
    return messages
      .map((message) => {
        const role = message && message.role === 'user' ? 'user' : 'assistant';
        const content = typeof message.content === 'string' ? stripExportNoise(message.content).trim() : '';
        const thinking = Array.isArray(message.thinking)
          ? message.thinking.map((part) => String(part || '').trim()).filter(Boolean)
          : [];
        const files = Array.isArray(message.files) ? message.files : [];
        const references = Array.isArray(message.references)
          ? message.references.filter((reference) => reference && typeof reference.url === 'string')
          : [];
        return {
          role,
          content,
          thinking,
          files,
          references,
          timestamp: message.timestamp || null,
        };
      })
      .filter((message) => message.content || message.files.length);
  }

  function stripExportNoise(value) {
    return String(value || '')
      .replace(/\r\n?/g, '\n')
      .replace(/[ \t]+\n/g, '\n')
      .trim();
  }

  function collectCandidates(messages) {
    const candidates = [];
    let order = 0;
    const assistantCount = messages.filter((message) => message.role === 'assistant').length;
    let assistantIndex = 0;

    messages.forEach((message, messageIndex) => {
      if (message.role !== 'assistant' || !message.content) return;
      const currentAssistantIndex = assistantIndex++;
      const marked = message.content
        .replace(/^[ \t]{0,3}#{1,6}[ \t]+(.+)$/gm, '\u0001$1')
        .replace(/^[ \t]*\*\*(?!\*)(.+?)\*\*[ \t]*$/gm, '\u0001$1');
      const lines = cleanForSummary(marked).split('\n');
      let pendingHeading = '';
      lines.forEach((line) => {
        if (line.startsWith('\u0001')) {
          pendingHeading = line.slice(1).trim();
          return;
        }
        const isBullet = /^\s*(?:[-*+]|\d+[.)])\s+/.test(line);
        const trimmed = line
          .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')
          .replace(/\s+/g, ' ')
          .trim();
        if (!trimmed) return;

        const heading = pendingHeading;
        let added = false;
        splitSentences(trimmed).forEach((sentence, sentenceIndex) => {
          const text = cleanSentence(sentence);
          if (!isUsefulSentence(text)) return;
          added = true;
          candidates.push({
            text,
            messageIndex,
            order: order++,
            isBullet,
            sentenceIndex,
            heading: sentenceIndex === 0 ? heading : '',
            isFinalMessage: currentAssistantIndex === assistantCount - 1,
          });
        });
        if (added) pendingHeading = '';
      });
    });

    addContextToCandidates(candidates);
    return candidates;
  }

  function addContextToCandidates(candidates) {
    candidates.forEach((candidate, index) => {
      const previous = candidates[index - 1];
      const startsWithReference = /^(?:it|they|this|that|these|those|he|she|we)\b/i.test(candidate.text);
      const heading = String(candidate.heading || '').replace(/[.:;,]+$/, '');
      const previousLooksLikeHeading = !heading
        && previous
        && previous.messageIndex === candidate.messageIndex
        && !/[.!?…]["”']?$/.test(previous.text)
        && previous.text.length <= 80
        && /^[A-Z]/.test(previous.text)
        && !/^(?:it|they|this|that|these|those|he|she|we|but|and|so)\b/i.test(previous.text);
      if (heading && startsWithReference) {
        candidate.contextText = truncate(`${heading}: ${candidate.text}`, 500);
      } else if (previousLooksLikeHeading && startsWithReference) {
        candidate.contextText = truncate(`${previous.text.replace(/[.:;,]+$/, '')}: ${candidate.text}`, 500);
      } else if (previous && previous.messageIndex === candidate.messageIndex && startsWithReference) {
        candidate.contextText = truncate(`${previous.text} ${candidate.text}`, 500);
      } else {
        candidate.contextText = candidate.text;
      }
    });
  }

  function cleanForSummary(markdown) {
    let text = String(markdown || '');
    text = text
      .replace(/```[\s\S]*?```/g, '\n')
      .replace(/~~~[\s\S]*?~~~/g, '\n')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/\[(?:citation|reference):\d+\]/gi, ' ')
      .replace(/\$\$[\s\S]*?\$\$/g, ' ')
      .replace(/\$[^$\n]{1,120}\$/g, ' ')
      .replace(/<\/?[a-z][^>]*>/gi, ' ')
      .replace(/^\s{0,3}>\s?/gm, '')
      .replace(/^\s{0,3}#{1,6}\s+/gm, '')
      .replace(/^\s*\|.*\|\s*$/gm, '')
      .replace(/^\s*(?:---+|___+|\*\*\*+)\s*$/gm, '')
      .replace(/https?:\/\/\S+/g, ' ')
      .replace(/[*_~`]+/g, '')
      .replace(/\\([\\`*_{}[\]()#+\-.!])/g, '$1')
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+/g, ' ');
    return text.trim();
  }

  function splitSentences(line) {
    const matches = line.match(/[^.!?。！？]+(?:[.!?。！？]+["'”’)]*|$)/g);
    return (matches || [line]).map((sentence) => sentence.trim()).filter(Boolean);
  }

  function cleanSentence(value) {
    return String(value || '')
      .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')
      .replace(/\s+/g, ' ')
      .replace(/^[“"']+|[”"']+$/g, '')
      .trim();
  }

  function isUsefulSentence(text) {
    if (!text || text.length < 22 || text.length > 560) return false;
    if (!/[\p{L}\p{N}]/u.test(text)) return false;
    if (DISCLAIMER.test(text)) return false;
    if (/^(?:sure|certainly|of course|absolutely|great question|happy to help|no problem)\b/i.test(text) && text.length < 110) {
      return false;
    }
    if (/^(?:let me know|hope this helps|feel free to (?:ask|reach out)|i hope this)/i.test(text)) {
      return false;
    }
    if (/^(?:sources?|references?|image|figure|table|note|example):?$/i.test(text)) return false;
    if (/^(?:examples?|for example|for instance|e\.g\.)\b/i.test(text)) return false;
    if (ASSISTANT_OFFER.test(text) && (/\b(?:with|to) me\b/i.test(text) || /\bI can (?:read|take a look|help)\b/i.test(text))) {
      return false;
    }
    if (/^(?:see|read|check out|refer to|visit)\b/i.test(text) && /\b(?:for more|for details|to learn more|guide|documentation)\b/i.test(text)) {
      return false;
    }
    return true;
  }

  function scoreCandidates(candidates, querySet) {
    const documents = candidates.map((candidate) => tokenize(candidate.text));
    const documentFrequency = new Map();
    let totalLength = 0;
    documents.forEach((terms) => {
      new Set(terms).forEach((term) => {
        documentFrequency.set(term, (documentFrequency.get(term) || 0) + 1);
      });
      totalLength += terms.length;
    });
    const averageLength = Math.max(1, totalLength / Math.max(1, documents.length));
    const documentCount = Math.max(1, documents.length);

    candidates.forEach((candidate, index) => {
      const terms = documents[index];
      if (!terms.length) {
        candidate.score = 0;
        return;
      }
      const counts = new Map();
      terms.forEach((term) => counts.set(term, (counts.get(term) || 0) + 1));

      let score = 0;
      let uniqueCount = 0;
      counts.forEach((count, term) => {
        uniqueCount += 1;
        const idf = Math.log((documentCount + 1) / ((documentFrequency.get(term) || 0) + 0.5)) + 1;
        const tf = count / Math.max(1, terms.length);
        score += (1 + Math.log(1 + count)) * idf * (0.5 + tf);
      });
      score /= Math.sqrt(Math.max(1, uniqueCount));
      score *= 0.65 + Math.min(1.15, terms.length / averageLength);

      let overlap = 0;
      querySet.forEach((term) => {
        if (counts.has(term)) overlap += 1;
      });
      score *= 1 + Math.min(0.9, overlap / Math.max(4, querySet.size * 0.6));

      if (SIGNAL_WORDS.test(candidate.text)) score *= 1.22;
      if (candidate.isBullet) score *= 1.08;
      if (candidate.isFinalMessage) score *= 1.1;
      if (candidate.sentenceIndex === 0) score *= 1.04;
      if (candidate.text.endsWith(':')) score *= 1.12;
      if (candidate.text.endsWith('?')) score *= 0.72;
      if (/\d/.test(candidate.text)) score *= 1.03;

      candidate.score = score;
    });
  }

  function selectKeyPoints(candidates, limit) {
    const selected = [];
    const sorted = candidates.slice().sort((a, b) => b.score - a.score);
    for (const candidate of sorted) {
      if (selected.length >= limit) break;
      if (selected.some((existing) => isSimilar(existing.text, candidate.contextText))) continue;
      selected.push({ ...candidate, text: candidate.contextText });
    }
    return dedupePoints(selected.map((candidate) => finishPoint(candidate.text, 440)));
  }

  function buildOutline(messages, candidates, depth, hasKeyPoints) {
    const turns = [];
    let current = null;

    messages.forEach((message, messageIndex) => {
      if (message.role === 'user') {
        current = {
          question: truncate(cleanInline(message.content), 115),
          answers: [],
          answerIndexes: [],
        };
        turns.push(current);
        return;
      }
      if (!current) return;
      const text = truncate(cleanInline(message.content), 260);
      if (text) current.answers.push(text);
      current.answerIndexes.push(messageIndex);
    });

    if (!turns.length) return { turns: [], note: '' };

    const maxTurns = depth.outline;
    let selected = turns;
    if (turns.length > maxTurns) {
      selected = [];
      const used = new Set();
      const indices = [];
      if (maxTurns <= 2) {
        indices.push(0, turns.length - 1);
      } else {
        indices.push(0, turns.length - 1);
        const middleSlots = maxTurns - 2;
        for (let i = 1; i <= middleSlots; i += 1) {
          indices.push(Math.round((i * (turns.length - 1)) / (middleSlots + 1)));
        }
      }
      indices.forEach((index) => {
        if (!used.has(index) && turns[index]) {
          used.add(index);
          selected.push(turns[index]);
        }
      });
      selected.sort((a, b) => turns.indexOf(a) - turns.indexOf(b));
    }

    const usedPoints = new Set();
    const outlined = selected.map((turn) => {
      const originalIndex = turns.indexOf(turn);
      const answerIndexSet = new Set(turn.answerIndexes);
      const answerCandidates = candidates
        .filter((candidate) => {
          return candidate.text && !usedPoints.has(candidate.text) && answerIndexSet.has(candidate.messageIndex);
        })
        .sort((a, b) => b.score - a.score);

      const uniqueCandidates = [];
      answerCandidates.forEach((candidate) => {
        const index = uniqueCandidates.findIndex((other) => isSimilar(other.contextText, candidate.contextText));
        if (index === -1) {
          uniqueCandidates.push(candidate);
        } else if (candidate.contextText.length > uniqueCandidates[index].contextText.length) {
          uniqueCandidates[index] = candidate;
        }
      });

      const points = dedupePoints(
        uniqueCandidates
          .slice(0, hasKeyPoints ? depth.answerPoints : depth.answerPoints + 1)
          .map((candidate) => {
            usedPoints.add(candidate.text);
            return finishPoint(candidate.contextText, 380);
          }),
      );

      if (!points.length && turn.answers.length) {
        const fallback = turn.answers.filter(Boolean).join(' ');
        if (fallback) points.push(finishPoint(fallback, 280));
      }

      return {
        number: originalIndex + 1,
        question: turn.question || 'Untitled turn',
        points,
      };
    });

    const omitted = turns.length - selected.length;
    return {
      turns: outlined,
      note: omitted > 0 ? `Showing ${selected.length} of ${turns.length} turns in this outline.` : '',
    };
  }


  function selectActions(candidates, limit) {
    const selected = [];
    const ordered = candidates
      .filter((candidate) => isActionable(candidate.text))
      .sort((a, b) => b.score - a.score);

    for (const candidate of ordered) {
      if (selected.length >= limit) break;
      const action = normalizeAction(candidate.text);
      if (!action || action.length < 30) continue;
      if (selected.some((existing) => isSimilar(existing, action))) continue;
      selected.push(finishPoint(action, 320));
    }
    return dedupePoints(selected);
  }

  function isActionable(text) {
    const trimmed = String(text || '').trim();
    if (!trimmed || trimmed.endsWith('?')) return false;
    if (/^[“"']/.test(trimmed)) return false;
    if (/^(?:examples?|for example|e\.g\.|note|remember)\b/i.test(trimmed)) return false;
    if (/^(?:it|this|that|these|those|there|here)\b/i.test(trimmed)) return false;
    if (ASSISTANT_OFFER.test(trimmed)) return false;
    const lead = trimmed.replace(/^(?:then|first|next|finally|also)\s*,?\s+/i, '');
    if (ACTION_MODAL.test(lead)) return true;
    return ACTION_START.test(lead);
  }

  function normalizeAction(text) {
    let value = String(text || '')
      .replace(ACTION_MODAL, '')
      .replace(/^(?:then|first|next|finally|also)\s*,?\s+/i, '')
      .replace(/^[-–—:;,\s]+/, '')
      .trim();
    if (!value) return '';
    if (/^[a-z]/.test(value)) value = `${value[0].toUpperCase()}${value.slice(1)}`;
    return value;
  }

  function collectCodeStats(markdown) {
    const counts = new Map();
    const regex = /(`{3,})([A-Za-z0-9_+#.-]*)\n([\s\S]*?)\n?\1/g;
    let match;
    while ((match = regex.exec(markdown)) !== null) {
      const language = (match[2] || 'plain text').toLowerCase();
      counts.set(language, (counts.get(language) || 0) + 1);
    }
    return Array.from(counts.entries()).map(([language, count]) => {
      const label = language === 'plain text' ? 'text' : language;
      return `${count} ${label} ${count === 1 ? 'block' : 'blocks'}`;
    });
  }

  function collectFiles(messages) {
    const seen = new Set();
    const files = [];
    messages.forEach((message) => {
      (message.files || []).forEach((file) => {
        if (!file) return;
        const name = String(file.name || file.file_name || file.filename || 'Attachment');
        const url = file.url || '';
        const key = `${name}|${url}`;
        if (seen.has(key)) return;
        seen.add(key);
        files.push({ name, url });
      });
    });
    return files;
  }

  function collectLinks(markdown, limit, references) {
    const found = new Map();
    (references || []).forEach((reference) => {
      addLink(found, reference.url, reference.title);
    });

    const markdownLink = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
    let match;
    while ((match = markdownLink.exec(markdown)) !== null) {
      addLink(found, match[2], match[1]);
    }

    const bare = /https?:\/\/[^\s<>"'`\])]+/g;
    while ((match = bare.exec(markdown)) !== null) {
      addLink(found, match[0], '');
    }

    return Array.from(found.values()).slice(0, limit);
  }

  function addLink(map, url, title) {
    if (!url || /^https?:\/\/chat\.deepseek\.com\b/i.test(url)) return;
    const cleanUrl = url.replace(/[.,;!?]+$/, '');
    if (map.has(cleanUrl)) {
      if (title && !map.get(cleanUrl).title) map.get(cleanUrl).title = cleanInline(title);
      return;
    }
    let fallbackTitle = '';
    try {
      fallbackTitle = new URL(cleanUrl).hostname.replace(/^www\./, '');
    } catch (_error) {
      return;
    }
    map.set(cleanUrl, {
      url: cleanUrl,
      title: cleanInline(title) || fallbackTitle,
    });
  }

  function topTerms(text, limit, options) {
    const settings = options || {};
    const documents = String(text || '')
      .split(/\n{2,}/)
      .map((document) => tokenize(document))
      .filter((terms) => terms.length > 0);
    const counts = new Map();
    const documentFrequency = new Map();

    documents.forEach((terms) => {
      terms.forEach((term) => counts.set(term, (counts.get(term) || 0) + 1));
      new Set(terms).forEach((term) => {
        documentFrequency.set(term, (documentFrequency.get(term) || 0) + 1);
      });
    });

    const totalDocs = Math.max(1, documents.length);
    return Array.from(counts.entries())
      .filter(([term, count]) => {
        if (term.length < 3 && !/^\p{Script=Han}+$/u.test(term)) return false;
        if (STOPWORDS.has(term)) return false;
        if (/^\d+$/.test(term)) return false;
        return count >= 1;
      })
      .map(([term, count]) => {
        const df = documentFrequency.get(term) || 1;
        const specificity = 1 + Math.log(totalDocs / df);
        const score = settings.frequencyOnly ? count : count * specificity;
        return { term, score };
      })
      .sort((a, b) => b.score - a.score || a.term.localeCompare(b.term))
      .slice(0, limit)
      .map((entry) => entry.term);
  }

  function tokenize(text) {
    const normalized = String(text || '')
      .toLowerCase()
      .replace(/[’‘]/g, "'")
      .replace(/https?:\/\/\S+/g, ' ');
    const tokens = normalized.match(/[\p{Script=Han}]{2,}|[\p{L}\p{N}][\p{L}\p{N}'_-]*/gu) || [];
    const terms = [];
    tokens.forEach((token) => {
      if (/^\p{Script=Han}+$/u.test(token)) {
        if (token.length <= 3) {
          terms.push(token);
          return;
        }
        for (let index = 0; index < token.length - 1; index += 1) {
          terms.push(token.slice(index, index + 2));
        }
        return;
      }
      const term = token.replace(/[’']s$/, '').replace(/^[-_]+|[-_]+$/g, '');
      if (!term || term.length < 2) return;
      if (!STOPWORDS.has(term)) terms.push(term);
    });
    return terms;
  }

  function dedupePoints(points) {
    const result = [];
    points.forEach((point) => {
      const normalized = normalizeForCompare(point);
      if (!normalized) return;
      const index = result.findIndex((existing) => {
        const existingNormalized = normalizeForCompare(existing);
        return existingNormalized === normalized
          || existingNormalized.startsWith(normalized)
          || normalized.startsWith(existingNormalized);
      });
      if (index === -1) {
        result.push(point);
        return;
      }
      if (normalized.length > normalizeForCompare(result[index]).length) {
        result[index] = point;
      }
    });
    return result;
  }

  function normalizeForCompare(value) {
    return String(value || '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function isSimilar(left, right) {
    const a = new Set(tokenize(left));
    const b = new Set(tokenize(right));
    if (!a.size || !b.size) return false;
    let intersection = 0;
    a.forEach((term) => {
      if (b.has(term)) intersection += 1;
    });
    const union = a.size + b.size - intersection;
    const jaccard = intersection / union;
    if (jaccard >= 0.58) return true;
    const shorter = Math.min(left.length, right.length);
    const longer = Math.max(left.length, right.length);
    if (shorter >= 30 && (left.startsWith(right) || right.startsWith(left))) return true;
    return shorter / longer > 0.78 && (left.includes(right.slice(0, 40)) || right.includes(left.slice(0, 40)));
  }

  function topicStem(term) {
    return String(term || '')
      .replace(/ing$/i, '')
      .replace(/ed$/i, '')
      .replace(/ies$/i, 'y')
      .replace(/s$/i, '');
  }

  function cleanInline(value) {
    return String(value || '')
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/\[(?:citation|reference):\d+\]/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/[*_~`#>|]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // Removes conversational lead-ins such as "Okay, different topic." so the
  // headline starts with the actual question.
  function cleanQuestion(value) {
    const original = cleanInline(value);
    let text = original
      .replace(/^(?:(?:okay|ok|so|hi|hello|hey|anyway|alright|well)\b[\s,.;:!-]*)+/i, '')
      .replace(/^(?:(?:this is|that is|that's)\s+)?(?:a\s+)?(?:different|unrelated|separate|off[- ]topic|new|another|side)\s+(?:topic|question)\b[\s,.;:!-]*/i, '')
      .trim();
    if (text && /^[a-z]/.test(text)) text = `${text[0].toUpperCase()}${text.slice(1)}`;
    return text || original;
  }

  function finishPoint(value, length) {
    let text = truncate(value, length).trim();
    text = text.replace(/^(?:but|and|so)\s+(?:notice|note|remember|consider)\b[\s,:;-]*/i, '');
    text = text.replace(/^(?:and|but|so|also|then|still|yet)\b[\s,:;-]*/i, '');
    text = text.replace(/[:;]+$/, '.').replace(/,+$/, '');
    text = ensureTerminalPunctuation(text);
    if (/^[a-z]/.test(text)) text = `${text[0].toUpperCase()}${text.slice(1)}`;
    return text;
  }

  function ensureTerminalPunctuation(text) {
    if (!text) return text;
    if (/[.!?…]$/.test(text)) return text;
    if (/[”"]$/.test(text)) {
      const before = text.slice(0, -1);
      return /[.!?…]$/.test(before) ? text : `${before}.”`;
    }
    return `${text}.`;
  }

  function closeDanglingQuote(text) {
    let result = text;
    const openCurly = (result.match(/“/g) || []).length;
    const closeCurly = (result.match(/”/g) || []).length;
    if (openCurly > closeCurly) result += '”';
    const straight = (result.match(/"/g) || []).length;
    if (straight % 2 === 1) result += '"';
    return result;
  }

  function truncate(value, length) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    if (text.length <= length) return closeDanglingQuote(text);
    const slice = text.slice(0, length);
    const boundary = Math.max(slice.lastIndexOf('. '), slice.lastIndexOf('? '), slice.lastIndexOf('! '), slice.lastIndexOf('; '), slice.lastIndexOf(' '));
    let cut = boundary > length * 0.55 ? slice.slice(0, boundary) : slice;
    cut = cut
      .replace(/[,;:\s]+$/, '')
      .replace(/\s+(?:and|but|or|because|which|that|with|to|of|for|in|on|at|by|from|as|the|a|an|is|are|was|were|his|her|their|your|my)$/i, '');
    if (!cut) cut = slice;
    return closeDanglingQuote(`${cut}…`);
  }

  function formatTimestamp(value) {
    if (!value) return '';
    const date = new Date(typeof value === 'number' && value < 100000000000 ? value * 1000 : value);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  function formatDate(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return 'unknown date';
    return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }

  function yaml(value) {
    return JSON.stringify(String(value == null ? '' : value));
  }

  function escapeLinkText(value) {
    return String(value || '').replace(/[\r\n]+/g, ' ').replace(/([\[\]])/g, '\\$1');
  }

  function escapeHeading(value) {
    return String(value || '')
      .replace(/\\/g, '\\\\')
      .replace(/[\r\n]+/g, ' ')
      .replace(/([`*_[\]<>#])/g, '\\$1')
      .trim();
  }

  return {
    buildMarkdown,
    summarize,
    cleanForSummary,
    splitSentences,
    tokenize,
    topTerms,
    isSimilar,
    finishPoint,
    truncate,
  };
});
