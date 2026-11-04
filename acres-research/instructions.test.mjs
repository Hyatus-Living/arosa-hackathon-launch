import test from 'node:test';
import assert from 'node:assert/strict';
import {readdirSync, readFileSync} from 'node:fs';
import {baseInstructions, laneInstructions, judgeInstructions, dreamJudgeInstructions} from './instructions.mjs';

test('agent instructions carry no em dash and title answers with a colon', () => {
  const lane = {title: 'Zoning', charter: 'Read the zoning.'};
  for (const text of [baseInstructions(), laneInstructions(lane), judgeInstructions(), dreamJudgeInstructions()]) assert.doesNotMatch(text, /—/);
  assert.match(baseInstructions(), /# <Property or Jurisdiction>: <Topic>/);
});

// Returns the raw source of every string and template literal with its line, skipping comments and regex literals,
// so a dash inside a regex or a comment is never taken for copy and a "//" or "/*" inside a string hides nothing.
function stringLiterals(src) {
  const found = [];
  const braces = [];
  let i = 0;
  let last = '';
  const lineAt = at => src.slice(0, at).split('\n').length;
  const scanTo = isEnd => {
    while (!isEnd()) {
      i += src[i] === '\\' ? 2 : 1;
      if (i >= src.length) throw new Error(`unterminated literal near line ${lineAt(src.length)}`);
    }
  };
  // Reads one template segment, from a backtick or an interpolation's closing brace to the next backtick or "${".
  const templateSegment = from => {
    scanTo(() => src[i] === '`' || (src[i] === '$' && src[i + 1] === '{'));
    found.push({line: lineAt(from), text: src.slice(from, i)});
    if (src[i] === '`') {
      i++;
      last = '`';
      return;
    }
    braces.push(true);
    i += 2;
    last = '{';
  };
  const regexMayStart = () => {
    if (!last || /[(,=:[!&|?{};+\-*%<>~^]/.test(last)) return true;
    const word = src.slice(0, i).match(/([A-Za-z_$][\w$]*)\s*$/);
    return Boolean(word) && ['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'void', 'yield', 'await', 'delete', 'throw', 'new'].includes(word[1]);
  };
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      const end = src.indexOf('\n', i);
      i = end < 0 ? src.length : end;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      i = src.indexOf('*/', i + 2) + 2;
      continue;
    }
    if (c === "'" || c === '"') {
      const from = i++;
      scanTo(() => src[i] === c);
      found.push({line: lineAt(from), text: src.slice(from, ++i)});
      last = c;
      continue;
    }
    if (c === '`') {
      templateSegment(i++);
      continue;
    }
    if (c === '/' && regexMayStart()) {
      let inClass = false;
      i++;
      scanTo(() => {
        if (src[i] === '[') inClass = true;
        if (src[i] === ']') inClass = false;
        return src[i] === '/' && !inClass;
      });
      i++;
      while (/[a-z]/.test(src[i] ?? '')) i++;
      last = '/';
      continue;
    }
    if (c === '{') braces.push(false);
    if (c === '}' && braces.pop()) {
      templateSegment(i++);
      continue;
    }
    if (!/\s/.test(c)) last = c;
    i++;
  }
  return found;
}

test('literal scanner keeps strings and drops comments and regex literals', () => {
  const src = [
    "const glob = 'src/**/*.mjs'; // a — note",
    "const a = 'x // y — z';",
    "/* — */ const re = /['\"—]/g, half = 4 / 2;",
    "const t = `one ${ {k: 'k—v'}.k } two`;",
    'if (re.test(a)) return /—/.test(t);',
    "const tail = 'end — here';",
  ].join('\n');
  assert.deepEqual(stringLiterals(src).filter(s => s.text.includes('—')).map(s => s.line), [2, 4, 6]);
});

// Module strings reach the agent, the reader or an email, and skills are loaded into the agent's context like its
// instructions, so neither may carry an em dash.
test('research module strings and skills carry no em dash', () => {
  const root = new URL('./', import.meta.url);
  const files = readdirSync(root, {recursive: true});
  const read = f => readFileSync(new URL(f, root), 'utf8');
  const offenders = [
    ...files.filter(f => f.endsWith('.mjs') && !f.endsWith('.test.mjs')).flatMap(f =>
      stringLiterals(read(f)).filter(s => /—|\\u2014|\\u\{2014\}/i.test(s.text)).map(s => `${f}:${s.line}`)),
    ...files.filter(f => f.endsWith('SKILL.md')).flatMap(f =>
      read(f).split('\n').flatMap((line, i) => line.includes('—') ? [`${f}:${i + 1}`] : [])),
  ];
  assert.deepEqual(offenders, []);
});
