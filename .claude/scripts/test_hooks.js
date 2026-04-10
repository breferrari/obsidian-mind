#!/usr/bin/env node
/**
 * Test suite for Claude Code hook scripts (classify-message.js, validate-write.js).
 *
 * Run: node --test .claude/scripts/test_hooks.js
 * Verbose: node --test .claude/scripts/test_hooks.js
 *
 * Node.js 18+ built-ins only — no external dependencies. Uses node:test + node:assert.
 */
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { execSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// ---------------------------------------------------------------------------
// Import hook modules
// ---------------------------------------------------------------------------
const SCRIPT_DIR = __dirname;
const { classify, _anyWordMatch, SIGNALS } = require(path.join(SCRIPT_DIR, 'classify-message.js'));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function runScript(scriptName, stdinData) {
  const scriptPath = path.join(SCRIPT_DIR, scriptName);
  const stdinStr = stdinData !== undefined ? JSON.stringify(stdinData) : '';
  const result = spawnSync(process.execPath, [scriptPath], {
    input: stdinStr,
    encoding: 'utf-8',
    timeout: 10000,
  });
  return { stdout: result.stdout || '', stderr: result.stderr || '', rc: result.status };
}

function getSignalNames(prompt) {
  const messages = classify(prompt);
  const names = [];
  for (const msg of messages) {
    for (const sig of SIGNALS) {
      if (msg === sig.message) {
        names.push(sig.name);
        break;
      }
    }
  }
  return names.sort();
}

// ---------------------------------------------------------------------------
// TestAnyWordMatch — unit tests for the core matching function
// ---------------------------------------------------------------------------
describe('_anyWordMatch', () => {
  it('basic match', () => {
    assert.ok(_anyWordMatch(['hello'], 'hello world'));
  });

  it('no match', () => {
    assert.ok(!_anyWordMatch(['xyz'], 'hello world'));
  });

  it('boundary prevents substring', () => {
    // 'decision' must not match inside 'predecisioned'
    assert.ok(!_anyWordMatch(['decision'], 'predecisioned'));
  });

  it('boundary prevents prefix', () => {
    // 'shipped' must not match inside 'unshipped'
    assert.ok(!_anyWordMatch(['shipped'], 'unshipped items'));
  });

  it('CJK adjacency', () => {
    // English keyword adjacent to CJK characters must match
    assert.ok(_anyWordMatch(['decision'], '\u306edecision\u306b\u3064\u3044\u3066'));
  });

  it('multi-word phrase', () => {
    assert.ok(_anyWordMatch(['one on one'], 'had a one on one with Alice'));
  });

  it('multi-word no partial', () => {
    // 'one on one' should not match 'one on two'
    assert.ok(!_anyWordMatch(['one on one'], 'one on two'));
  });

  it('CJK pattern match', () => {
    assert.ok(_anyWordMatch(['\u6c7a\u5b9a\u3057\u305f'], '\u30c1\u30fc\u30e0\u3067\u6c7a\u5b9a\u3057\u305f'));
  });

  it('case sensitivity', () => {
    // _anyWordMatch is case-sensitive; classify() lowercases first
    assert.ok(!_anyWordMatch(['decision'], 'DECISION'));
    assert.ok(_anyWordMatch(['decision'], 'decision'));
  });
});

// ---------------------------------------------------------------------------
// TestClassifyEnglish — unit tests for English signal detection
// ---------------------------------------------------------------------------
describe('classify English', () => {
  it('decision', () => {
    assert.ok(getSignalNames('we decided to use Redis').includes('DECISION'));
  });

  it('incident', () => {
    assert.ok(getSignalNames('there was an outage in prod').includes('INCIDENT'));
  });

  it('1on1', () => {
    assert.ok(getSignalNames('had a 1:1 with my manager').includes('1:1 CONTENT'));
  });

  it('1on1 hyphen', () => {
    assert.ok(getSignalNames('1-1 with Sarah today').includes('1:1 CONTENT'));
  });

  it('win', () => {
    assert.ok(getSignalNames('got kudos from the team').includes('WIN'));
  });

  it('architecture', () => {
    assert.ok(getSignalNames('wrote a tech spec for the API').includes('ARCHITECTURE'));
  });

  it('person context', () => {
    assert.ok(getSignalNames('Alice told me about the deadline').includes('PERSON CONTEXT'));
  });

  it('project update', () => {
    assert.ok(getSignalNames('sprint planning for next week').includes('PROJECT UPDATE'));
  });

  it('overlap shipped', () => {
    const names = getSignalNames('we shipped the feature');
    assert.ok(names.includes('WIN'));
    assert.ok(names.includes('PROJECT UPDATE'));
  });

  it('overlap deployed', () => {
    const names = getSignalNames('deployed to production');
    assert.ok(names.includes('WIN'));
    assert.ok(names.includes('PROJECT UPDATE'));
  });

  it('multi signal', () => {
    const names = getSignalNames('we decided to fix the incident');
    assert.ok(names.includes('DECISION'));
    assert.ok(names.includes('INCIDENT'));
  });

  it('case insensitivity', () => {
    assert.ok(getSignalNames('DECIDED to go with option A').includes('DECISION'));
  });

  it('return type', () => {
    const result = classify('hello world');
    assert.ok(Array.isArray(result));
  });

  it('return items are strings', () => {
    const result = classify('we decided to ship it');
    for (const item of result) {
      assert.strictEqual(typeof item, 'string');
    }
  });
});

// ---------------------------------------------------------------------------
// TestClassifyInflections — English verb form coverage
// ---------------------------------------------------------------------------
describe('classify inflections', () => {
  it('deciding', () => {
    assert.ok(getSignalNames("we're still deciding on the approach").includes('DECISION'));
  });

  it('deploying', () => {
    const names = getSignalNames('deploying the fix right now');
    assert.ok(names.includes('WIN'));
    assert.ok(names.includes('PROJECT UPDATE'));
  });

  it('shipping', () => {
    const names = getSignalNames('shipping the feature today');
    assert.ok(names.includes('WIN'));
    assert.ok(names.includes('PROJECT UPDATE'));
  });

  it('merging', () => {
    assert.ok(getSignalNames('merging the PR this afternoon').includes('PROJECT UPDATE'));
  });

  it('launching', () => {
    const names = getSignalNames('launching the new service tomorrow');
    assert.ok(names.includes('WIN'));
    assert.ok(names.includes('PROJECT UPDATE'));
  });

  it('completing', () => {
    const names = getSignalNames('completing the migration this week');
    assert.ok(names.includes('WIN'));
    assert.ok(names.includes('PROJECT UPDATE'));
  });

  it('releasing', () => {
    const names = getSignalNames('releasing v2.0 on Friday');
    assert.ok(names.includes('WIN'));
    assert.ok(names.includes('PROJECT UPDATE'));
  });

  it('achieving', () => {
    assert.ok(getSignalNames('achieving the quarterly target').includes('WIN'));
  });

  it('rolling out', () => {
    assert.ok(getSignalNames('rolling out the new config').includes('PROJECT UPDATE'));
  });

  it('deploys', () => {
    const names = getSignalNames('she deploys to prod every Friday');
    assert.ok(names.includes('WIN'));
    assert.ok(names.includes('PROJECT UPDATE'));
  });

  it('launches', () => {
    const names = getSignalNames('he launches the service tomorrow');
    assert.ok(names.includes('WIN'));
    assert.ok(names.includes('PROJECT UPDATE'));
  });

  it('ships', () => {
    const names = getSignalNames('the team ships fast');
    assert.ok(names.includes('WIN'));
    assert.ok(names.includes('PROJECT UPDATE'));
  });

  it('merges', () => {
    assert.ok(getSignalNames('she merges the PR').includes('PROJECT UPDATE'));
  });

  it('releases', () => {
    const names = getSignalNames('he releases a new version weekly');
    assert.ok(names.includes('WIN'));
    assert.ok(names.includes('PROJECT UPDATE'));
  });

  it('release cut', () => {
    assert.ok(getSignalNames('did the release cut for v3.4').includes('PROJECT UPDATE'));
  });
});

// ---------------------------------------------------------------------------
// TestClassifyCJK — per-language signal detection
// ---------------------------------------------------------------------------
describe('classify CJK', () => {
  const CJK_CASES = {
    DECISION: {
      ja: ['\u30c1\u30fc\u30e0\u3067\u6c7a\u5b9a\u3057\u305f', '\u6c7a\u5b9a\u3057\u305f'],
      ko: ['\uacb0\uc815\ud588\uc2b5\ub2c8\ub2e4', '\uacb0\uc815\ud588\uc2b5\ub2c8\ub2e4'],
      zh: ['\u6211\u4eec\u51b3\u5b9a\u4e86\u8fd9\u4e2a\u65b9\u6848', '\u51b3\u5b9a\u4e86'],
    },
    INCIDENT: {
      ja: ['\u30a4\u30f3\u30b7\u30c7\u30f3\u30c8\u304c\u767a\u751f\u3057\u307e\u3057\u305f', '\u30a4\u30f3\u30b7\u30c7\u30f3\u30c8'],
      ko: ['\uc7a5\uc560\uac00 \ubc1c\uc0dd\ud588\uc2b5\ub2c8\ub2e4', '\uc7a5\uc560'],
      zh: ['\u53d1\u751f\u4e86\u6545\u969c\u9700\u8981\u5904\u7406', '\u6545\u969c'],
    },
    '1:1 CONTENT': {
      ja: ['\u30de\u30cd\u30fc\u30b8\u30e3\u30fc\u3068\u30ef\u30f3\u30aa\u30f3\u30ef\u30f3\u3057\u305f', '\u30ef\u30f3\u30aa\u30f3\u30ef\u30f3'],
      ko: ['\uc6d0\uc628\uc6d0 \ubbf8\ud305\uc744 \ud588\uc2b5\ub2c8\ub2e4', '\uc6d0\uc628\uc6d0'],
      zh: ['\u4eca\u5929\u6709\u4e00\u5bf9\u4e00\u4f1a\u8bae', '\u4e00\u5bf9\u4e00'],
    },
    WIN: {
      ja: ['\u65b0\u6a5f\u80fd\u3092\u30ea\u30ea\u30fc\u30b9\u3057\u305f', '\u30ea\u30ea\u30fc\u30b9\u3057\u305f'],
      ko: ['\uc11c\ube44\uc2a4\ub97c \ucd9c\uc2dc\ud588\uc5b4', '\ucd9c\uc2dc\ud588\uc5b4'],
      zh: ['\u65b0\u7248\u672c\u53d1\u5e03\u4e86', '\u53d1\u5e03\u4e86'],
    },
    ARCHITECTURE: {
      ja: ['\u30a2\u30fc\u30ad\u30c6\u30af\u30c1\u30e3\u306e\u898b\u76f4\u3057\u304c\u5fc5\u8981', '\u30a2\u30fc\u30ad\u30c6\u30af\u30c1\u30e3'],
      ko: ['\uc544\ud0a4\ud14d\ucc98 \ub9ac\ubdf0\ub97c \ud588\uc2b5\ub2c8\ub2e4', '\uc544\ud0a4\ud14d\ucc98'],
      zh: ['\u7cfb\u7edf\u67b6\u6784\u9700\u8981\u91cd\u65b0\u8bbe\u8ba1', '\u67b6\u6784'],
    },
    'PERSON CONTEXT': {
      ja: ['\u7530\u4e2d\u3055\u3093\u304c\u8a00\u3063\u3066\u305f', '\u8a00\u3063\u3066\u305f'],
      ko: ['\uae40 \ub9e4\ub2c8\uc800\uac00 \ub9d0\ud588\uc5b4', '\ub9d0\ud588\uc5b4'],
      zh: ['\u4ed6\u63d0\u5230\u4e86\u8fd9\u4e2a\u95ee\u9898', '\u63d0\u5230'],
    },
    'PROJECT UPDATE': {
      ja: ['\u4eca\u9031\u306e\u30b9\u30d7\u30ea\u30f3\u30c8\u3067\u5b8c\u4e86\u3059\u308b', '\u30b9\u30d7\u30ea\u30f3\u30c8'],
      ko: ['\uc774\ubc88 \uc2a4\ud504\ub9b0\ud2b8\uc5d0\uc11c \uc644\ub8cc', '\uc2a4\ud504\ub9b0\ud2b8'],
      zh: ['\u8fd9\u4e2a\u8fed\u4ee3\u7684\u8fdb\u5c55\u62a5\u544a', '\u8fed\u4ee3'],
    },
  };

  describe('Japanese signals', () => {
    for (const [signalName, langs] of Object.entries(CJK_CASES)) {
      const [prompt, pattern] = langs.ja;
      it(`${signalName} — ${pattern}`, () => {
        assert.ok(
          getSignalNames(prompt).includes(signalName),
          `Japanese pattern '${pattern}' should trigger ${signalName}`
        );
      });
    }
  });

  describe('Korean signals', () => {
    for (const [signalName, langs] of Object.entries(CJK_CASES)) {
      const [prompt, pattern] = langs.ko;
      it(`${signalName} — ${pattern}`, () => {
        assert.ok(
          getSignalNames(prompt).includes(signalName),
          `Korean pattern '${pattern}' should trigger ${signalName}`
        );
      });
    }
  });

  describe('Chinese signals', () => {
    for (const [signalName, langs] of Object.entries(CJK_CASES)) {
      const [prompt, pattern] = langs.zh;
      it(`${signalName} — ${pattern}`, () => {
        assert.ok(
          getSignalNames(prompt).includes(signalName),
          `Chinese pattern '${pattern}' should trigger ${signalName}`
        );
      });
    }
  });

  it('mixed CJK/English Japanese', () => {
    assert.ok(getSignalNames('\u306edecision\u306b\u3064\u3044\u3066').includes('DECISION'));
  });

  it('mixed CJK/English Chinese', () => {
    assert.ok(getSignalNames('\u6211\u4eecdecided\u4e86').includes('DECISION'));
  });

  it('mixed CJK/English Korean', () => {
    assert.ok(getSignalNames('\uc624\ub298 1:1 \ubbf8\ud305').includes('1:1 CONTENT'));
  });

  it('CJK overlap', () => {
    // Chinese delivery word triggers both WIN and PROJECT UPDATE
    const names = getSignalNames('\u65b0\u7248\u672c\u53d1\u5e03\u4e86');
    assert.ok(names.includes('WIN'));
    assert.ok(names.includes('PROJECT UPDATE'));
  });

  it('CJK false positive Japanese', () => {
    assert.deepStrictEqual(getSignalNames('\u666e\u901a\u306e\u4f1a\u8a71\u3067\u3059'), []);
  });

  it('CJK false positive Korean', () => {
    assert.deepStrictEqual(getSignalNames('\ucf54\ub4dc \ub9ac\ubdf0\ub97c \ud569\uc2dc\ub2e4'), []);
  });

  it('CJK false positive Chinese', () => {
    assert.deepStrictEqual(getSignalNames('\u4eca\u5929\u5929\u6c14\u4e0d\u9519'), []);
  });
});

// ---------------------------------------------------------------------------
// TestClassifyFalsePositives — must NOT trigger signals
// ---------------------------------------------------------------------------
describe('classify false positives', () => {
  const NO_SIGNAL_CASES = [
    ['downloading the markdown file', 'download \u2260 any trigger'],
    ['hello world', 'generic greeting'],
    ['just reading some code', 'generic activity'],
    ['the function returns an error', 'generic error'],
    ['I wonder about the implementation', 'wonder \u2260 won'],
    ['she is predecisioned on this', 'predecisioned \u2260 decision'],
    ['unshipped items in the backlog', 'unshipped \u2260 shipped'],
    ['acknowledged the problem', 'no trigger words'],
  ];

  for (const [prompt, reason] of NO_SIGNAL_CASES) {
    it(`no signal: ${reason}`, () => {
      assert.deepStrictEqual(
        getSignalNames(prompt), [],
        `Should not trigger: ${reason}`
      );
    });
  }

  it('empty string', () => {
    assert.deepStrictEqual(classify(''), []);
  });
});

// ---------------------------------------------------------------------------
// TestClassifyIntegration — subprocess tests for full stdin→stdout pipeline
// ---------------------------------------------------------------------------
describe('classify-message.js integration', () => {
  const SCRIPT = 'classify-message.js';

  it('valid JSON with signal', () => {
    const { stdout, rc } = runScript(SCRIPT, { prompt: 'we decided to use React' });
    assert.strictEqual(rc, 0);
    const data = JSON.parse(stdout);
    assert.ok('hookSpecificOutput' in data);
    assert.strictEqual(data.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    assert.ok(data.hookSpecificOutput.additionalContext.includes('DECISION'));
  });

  it('valid JSON no signal', () => {
    const { stdout, rc } = runScript(SCRIPT, { prompt: 'hello world' });
    assert.strictEqual(rc, 0);
    assert.strictEqual(stdout.trim(), '');
  });

  it('invalid JSON', () => {
    const result = spawnSync(process.execPath, [path.join(SCRIPT_DIR, SCRIPT)], {
      input: 'not json{{',
      encoding: 'utf-8',
      timeout: 10000,
    });
    assert.strictEqual(result.status, 0);
  });

  it('missing prompt', () => {
    const { rc } = runScript(SCRIPT, { foo: 'bar' });
    assert.strictEqual(rc, 0);
  });

  it('non-string prompt', () => {
    const { rc } = runScript(SCRIPT, { prompt: 123 });
    assert.strictEqual(rc, 0);
  });

  it('null prompt', () => {
    const { rc } = runScript(SCRIPT, { prompt: null });
    assert.strictEqual(rc, 0);
  });

  it('empty stdin', () => {
    const result = spawnSync(process.execPath, [path.join(SCRIPT_DIR, SCRIPT)], {
      input: '',
      encoding: 'utf-8',
      timeout: 10000,
    });
    assert.strictEqual(result.status, 0);
  });

  it('empty prompt', () => {
    const { rc } = runScript(SCRIPT, { prompt: '' });
    assert.strictEqual(rc, 0);
  });
});

// ---------------------------------------------------------------------------
// TestValidateWriteIntegration — subprocess tests for validate-write.js
// ---------------------------------------------------------------------------
describe('validate-write.js integration', () => {
  const SCRIPT = 'validate-write.js';
  let tmpdir;

  function makeMd(content, name = 'test.md') {
    const filePath = path.join(tmpdir, name);
    fs.writeFileSync(filePath, content, 'utf-8');
    return filePath;
  }

  function run(filePath) {
    return runScript(SCRIPT, { tool_input: { file_path: filePath } });
  }

  // Create/cleanup temp dir for each test in this suite
  // node:test doesn't have beforeEach at describe level, so we use a helper
  function withTmpDir(fn) {
    return () => {
      tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'validate-test-'));
      try {
        fn();
      } finally {
        fs.rmSync(tmpdir, { recursive: true, force: true });
      }
    };
  }

  // -- Skip rules --

  it('skip non-markdown', () => {
    const { stdout, rc } = run('/tmp/test.txt');
    assert.strictEqual(rc, 0);
    assert.strictEqual(stdout.trim(), '');
  });

  it('skip README', () => {
    const { stdout, rc } = run('/some/path/README.md');
    assert.strictEqual(rc, 0);
    assert.strictEqual(stdout.trim(), '');
  });

  it('skip translated READMEs', () => {
    for (const lang of ['ja', 'ko', 'zh-CN']) {
      const { stdout, rc } = run(`/some/path/README.${lang}.md`);
      assert.strictEqual(rc, 0, `README.${lang}.md should be skipped`);
      assert.strictEqual(stdout.trim(), '', `README.${lang}.md should produce no output`);
    }
  });

  it('skip CHANGELOG', () => {
    const { stdout, rc } = run('/some/path/CHANGELOG.md');
    assert.strictEqual(rc, 0);
    assert.strictEqual(stdout.trim(), '');
  });

  it('skip .claude dir', () => {
    const { stdout, rc } = run('/vault/.claude/commands/foo.md');
    assert.strictEqual(rc, 0);
    assert.strictEqual(stdout.trim(), '');
  });

  it('skip templates', () => {
    const { stdout, rc } = run('/vault/templates/Work Note.md');
    assert.strictEqual(rc, 0);
    assert.strictEqual(stdout.trim(), '');
  });

  it('skip thinking', () => {
    const { stdout, rc } = run('/vault/thinking/draft.md');
    assert.strictEqual(rc, 0);
    assert.strictEqual(stdout.trim(), '');
  });

  it('skip Windows path', withTmpDir(() => {
    // Backslash paths with .claude\ should be skipped after normalization
    const { stdout, rc } = run('C:\\vault\\.claude\\commands\\foo.md');
    assert.strictEqual(rc, 0);
    assert.strictEqual(stdout.trim(), '');
  }));

  // -- Frontmatter validation --

  it('missing frontmatter', withTmpDir(() => {
    const p = makeMd('No frontmatter here\n' + 'x'.repeat(300));
    const { stdout, rc } = run(p);
    assert.strictEqual(rc, 0);
    const data = JSON.parse(stdout);
    assert.strictEqual(data.hookSpecificOutput.hookEventName, 'PostToolUse');
    assert.ok(data.hookSpecificOutput.additionalContext.includes('Missing YAML frontmatter'));
  }));

  it('missing tags', withTmpDir(() => {
    const p = makeMd('---\ndate: 2026-04-05\ndescription: test\n---\n# Note\n[[Link]] ' + 'x'.repeat(300));
    const { stdout, rc } = run(p);
    assert.strictEqual(rc, 0);
    assert.ok(stdout.includes('Missing `tags`'));
  }));

  it('missing description', withTmpDir(() => {
    const p = makeMd('---\ndate: 2026-04-05\ntags:\n  - test\n---\n# Note\n[[Link]] ' + 'x'.repeat(300));
    const { stdout, rc } = run(p);
    assert.strictEqual(rc, 0);
    assert.ok(stdout.includes('Missing `description`'));
  }));

  it('missing date', withTmpDir(() => {
    const p = makeMd('---\ndescription: test\ntags:\n  - test\n---\n# Note\n[[Link]] ' + 'x'.repeat(300));
    const { stdout, rc } = run(p);
    assert.strictEqual(rc, 0);
    assert.ok(stdout.includes('Missing `date`'));
  }));

  // -- Wikilink validation --

  it('no wikilinks long note', withTmpDir(() => {
    const p = makeMd('---\ndate: 2026-04-05\ndescription: test\ntags:\n  - test\n---\n# Note\n' + 'x'.repeat(300));
    const { stdout, rc } = run(p);
    assert.strictEqual(rc, 0);
    assert.ok(stdout.includes('No [[wikilinks]]'));
  }));

  it('short note no wikilink ok', withTmpDir(() => {
    const p = makeMd('---\ndate: 2026-04-05\ndescription: test\ntags:\n  - test\n---\nShort note.');
    const { stdout, rc } = run(p);
    assert.strictEqual(rc, 0);
    assert.strictEqual(stdout.trim(), '');
  }));

  // -- Valid note --

  it('valid note no warnings', withTmpDir(() => {
    const p = makeMd(
      '---\ndate: 2026-04-05\ndescription: A valid test note\ntags:\n  - test\n---\n' +
      '# Note\n\nSome content with [[a wikilink]] and more text.\n' + 'x'.repeat(300)
    );
    const { stdout, rc } = run(p);
    assert.strictEqual(rc, 0);
    assert.strictEqual(stdout.trim(), '');
  }));

  // -- Type safety --

  it('null tool_input', () => {
    const { rc } = runScript(SCRIPT, { tool_input: null });
    assert.strictEqual(rc, 0);
  });

  it('non-string file_path', () => {
    const { rc } = runScript(SCRIPT, { tool_input: { file_path: 123 } });
    assert.strictEqual(rc, 0);
  });

  it('invalid JSON', () => {
    const result = spawnSync(process.execPath, [path.join(SCRIPT_DIR, SCRIPT)], {
      input: 'not json',
      encoding: 'utf-8',
      timeout: 10000,
    });
    assert.strictEqual(result.status, 0);
  });

  it('nonexistent file', () => {
    const { rc } = run('/nonexistent/path/note.md');
    assert.strictEqual(rc, 0);
  });

  it('empty object', () => {
    const { rc } = runScript(SCRIPT, {});
    assert.strictEqual(rc, 0);
  });
});
