#!/usr/bin/env node
/**
 * Classify user messages and inject routing hints for Claude.
 *
 * Architecture: data-driven signal matching. Each signal has a list of trigger
 * patterns checked via regex with Latin-letter lookarounds (not \b). Words can
 * appear in multiple signals (explicit overlaps) because the cost of a false
 * positive hint is ~0 (Claude ignores irrelevant hints) while a false negative
 * means missed routing.
 *
 * Patterns include English, Japanese, Korean, and Simplified Chinese to support
 * multilingual users. The Latin-letter lookaround approach allows mixed
 * Latin/CJK text without relying on JS word-boundary behavior.
 */
'use strict';

// Each signal: name, routing message, and trigger patterns.
// Patterns are checked with Latin-letter lookarounds — safe for CJK/Latin mixed text.
// Words MAY appear in multiple signals to express natural category overlaps.
const SIGNALS = [
  {
    name: 'DECISION',
    message: 'DECISION detected \u2014 consider creating a Decision Record in work/active/ and logging in work/Index.md Decisions Log',
    patterns: [
      // English
      'decided', 'deciding', 'decision', 'we chose', 'agreed to',
      "let's go with", 'the call is', "we're going with",
      // Japanese
      '\u6c7a\u5b9a\u3057\u305f', '\u6c7a\u3081\u305f', '\u5408\u610f\u3057\u305f',
      // Korean
      '\uacb0\uc815\ud588\uc5b4', '\uacb0\uc815\ud588\uc2b5\ub2c8\ub2e4', '\ud569\uc758\ud588\uc5b4',
      // Chinese
      '\u51b3\u5b9a\u4e86', '\u6211\u4eec\u51b3\u5b9a', '\u786e\u5b9a\u4e86', '\u540c\u610f',
    ],
  },
  {
    name: 'INCIDENT',
    message: 'INCIDENT detected \u2014 consider using /om-incident-capture or creating an incident note in work/incidents/',
    patterns: [
      // English
      'incident', 'outage', 'pagerduty', 'severity',
      'p0', 'p1', 'p2', 'sev1', 'sev2', 'postmortem', 'rca',
      // Japanese
      '\u30a4\u30f3\u30b7\u30c7\u30f3\u30c8', '\u969c\u5bb3',
      // Korean
      '\uc778\uc2dc\ub358\ud2b8', '\uc7a5\uc560',
      // Chinese
      '\u4e8b\u4ef6', '\u6545\u969c', '\u4e8b\u540e\u5206\u6790',
    ],
  },
  {
    name: '1:1 CONTENT',
    message: '1:1 CONTENT detected \u2014 consider creating a 1-on-1 note in work/1-1/ and updating the person note in org/people/',
    patterns: [
      // English
      '1:1', '1-1', '1-on-1', 'one on one', '1on1',
      'catch up with', 'sync with',
      // Japanese
      '\u30ef\u30f3\u30aa\u30f3\u30ef\u30f3',
      // Korean
      '\uc6d0\uc628\uc6d0',
      // Chinese
      '\u4e00\u5bf9\u4e00', '\u5355\u72ec\u9762\u8c08',
    ],
  },
  {
    name: 'WIN',
    message: 'WIN detected \u2014 consider adding to perf/Brag Doc.md with a link to the evidence note',
    patterns: [
      // Delivery — English (shared with PROJECT UPDATE)
      'shipped', 'shipping', 'ships',
      'launched', 'launching', 'launches',
      'completed', 'completing', 'completes',
      'released', 'releasing', 'releases',
      'deployed', 'deploying', 'deploys',
      // Achievement — English
      'achieved', 'achieving', 'won', 'promoted', 'praised', 'win',
      'kudos', 'shoutout', 'great feedback', 'recognized',
      // Japanese
      '\u51fa\u8377\u3057\u305f', '\u30ea\u30ea\u30fc\u30b9\u3057\u305f', '\u9054\u6210\u3057\u305f', '\u8912\u3081\u3089\u308c\u305f',
      // Korean
      '\ubc30\ud3ec\ud588\uc5b4', '\ucd9c\uc2dc\ud588\uc5b4', '\ub2ec\uc131\ud588\uc5b4', '\uce6d\ucc2c\ubc1b\uc558\uc5b4',
      // Chinese
      '\u53d1\u5e03\u4e86', '\u4e0a\u7ebf\u4e86', '\u5b8c\u6210\u4e86', '\u8868\u626c', '\u8ba4\u53ef',
    ],
  },
  {
    name: 'ARCHITECTURE',
    message: 'ARCHITECTURE discussion \u2014 consider creating a reference note in reference/ or a decision record',
    patterns: [
      // English
      'architecture', 'system design', 'rfc', 'tech spec',
      'trade-off', 'design doc', 'adr',
      // Japanese
      '\u30a2\u30fc\u30ad\u30c6\u30af\u30c1\u30e3', '\u30b7\u30b9\u30c6\u30e0\u8a2d\u8a08',
      // Korean
      '\uc544\ud0a4\ud14d\ucc98', '\uc2dc\uc2a4\ud15c \uc124\uacc4',
      // Chinese
      '\u67b6\u6784', '\u7cfb\u7edf\u8bbe\u8ba1', '\u6280\u672f\u89c4\u8303',
    ],
  },
  {
    name: 'PERSON CONTEXT',
    message: 'PERSON CONTEXT detected \u2014 consider updating the relevant person note in org/people/ and linking from the conversation note',
    patterns: [
      // English
      'told me', 'said that', 'feedback from', 'met with',
      'talked to', 'spoke with',
      'mentioned that', 'mentioned the', 'mentioned a',
      // Japanese
      '\u8a00\u3063\u3066\u305f', '\u30d5\u30a3\u30fc\u30c9\u30d0\u30c3\u30af', '\u8a71\u3057\u305f',
      // Korean
      '\ub9d0\ud588\uc5b4', '\ud53c\ub4dc\ubc31', '\uc598\uae30\ud588\uc5b4', '\uc5b8\uae09\ud588\uc5b4',
      // Chinese
      '\u8bf4\u4e86', '\u63d0\u5230', '\u53cd\u9988', '\u63d0\u53ca',
    ],
  },
  {
    name: 'PROJECT UPDATE',
    message: 'PROJECT UPDATE detected \u2014 consider updating the active work note in work/active/ and checking if wins should go to brag doc',
    patterns: [
      // English
      'project update', 'sprint', 'milestone',
      // Delivery — English (shared with WIN)
      'shipped', 'shipping', 'ships', 'shipped feature',
      'launched', 'launching', 'launches',
      'completed', 'completing', 'completes',
      'released', 'releasing', 'releases',
      'deployed', 'deploying', 'deploys',
      // Delivery-only — English (not wins on their own)
      'went live', 'rolled out', 'rolling out',
      'merged', 'merging', 'merges',
      'cut the release', 'release cut',
      // Japanese
      '\u30b9\u30d7\u30ea\u30f3\u30c8', '\u30de\u30a4\u30eb\u30b9\u30c8\u30fc\u30f3', '\u30de\u30fc\u30b8\u3057\u305f', '\u30ea\u30ea\u30fc\u30b9\u3057\u307e\u3057\u305f',
      // Korean
      '\uc2a4\ud504\ub9b0\ud2b8', '\ub9c8\uc77c\uc2a4\ud1a4', '\ubc30\ud3ec', '\ub9b4\ub9ac\uc2a4', '\ubcd1\ud569',
      // Chinese (发布了, 上线 shared with WIN)
      '\u8fed\u4ee3', '\u91cc\u7a0b\u7891', '\u53d1\u5e03\u4e86', '\u4e0a\u7ebf', '\u5408\u5e76\u4e86',
    ],
  },
];

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Check if any phrase appears as a whole word/phrase in text.
 *
 * Uses Latin-letter boundaries instead of \b. JS's \b treats CJK
 * characters as non-word characters, but we want consistent behavior
 * with the Python version that uses (?<![a-zA-Z]) and (?![a-zA-Z])
 * to ensure English keywords aren't part of a larger English word,
 * while allowing CJK adjacency.
 */
function _anyWordMatch(patternWords, text) {
  for (const phrase of patternWords) {
    const re = new RegExp('(?<![a-zA-Z])' + escapeRegex(phrase) + '(?![a-zA-Z])');
    if (re.test(text)) {
      return true;
    }
  }
  return false;
}

function classify(prompt) {
  const p = prompt.toLowerCase();
  const signals = [];
  for (const sig of SIGNALS) {
    if (_anyWordMatch(sig.patterns, p)) {
      signals.push(sig.message);
    }
  }
  return signals;
}

function main() {
  let data = '';
  process.stdin.setEncoding('utf-8');
  process.stdin.on('data', (chunk) => { data += chunk; });
  process.stdin.on('end', () => {
    try {
      const inputData = JSON.parse(data);
      const prompt = inputData.prompt;
      if (typeof prompt !== 'string' || !prompt) {
        process.exit(0);
      }

      const signals = classify(prompt);

      if (signals.length > 0) {
        const hints = signals.map((s) => `- ${s}`).join('\n');
        const output = {
          hookSpecificOutput: {
            hookEventName: inputData.hook_event_name || 'UserPromptSubmit',
            additionalContext:
              'Content classification hints (act on these if the user\'s message contains relevant info):\n' +
              hints +
              '\n\nRemember: use proper templates, add [[wikilinks]], follow CLAUDE.md conventions.',
          },
        };
        process.stdout.write(JSON.stringify(output));
      }
    } catch {
      // Silent exit — never block the user
    }
    process.exit(0);
  });
}

// Support both direct execution and require() for testing
if (require.main === module) {
  try {
    main();
  } catch {
    process.exit(0);
  }
}

module.exports = { classify, _anyWordMatch, SIGNALS };
