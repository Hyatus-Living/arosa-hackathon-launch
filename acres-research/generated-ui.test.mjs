import test from 'node:test';
import assert from 'node:assert/strict';
import {generatedUiContent, generatedUiTool} from './generated-ui.mjs';

const valid = () => ({
  initialHeight: 320,
  placeholderMessages: ['Preparing the comparison…'],
  css: '#root{color:#26312a}',
  html: '<section><button id="go">Compare</button></section>',
  jsFunctions: '',
  jsExpressions: [],
});

test('generated UI content uses the complete CopilotKit OGUI shape and Arosa guidance', () => {
  const content = generatedUiContent(valid());
  assert.equal(content.initialHeight, 320);
  assert.equal(content.generating, false);
  assert.equal(content.cssComplete, true);
  assert.deepEqual(content.html, [valid().html]);
  assert.equal(content.htmlComplete, true);
  assert.equal(content.jsFunctionsComplete, true);
  assert.equal(content.jsExpressionsComplete, true);
  assert.match(generatedUiTool.description, /Match Arosa/);
  assert.doesNotMatch(generatedUiTool.description, /Match Acres/);
});

test('generated UI content rejects blank interfaces the renderer cannot use', () => {
  assert.throws(() => generatedUiContent({...valid(), html: '  '}), /shorter interface|normal answer/);
  assert.throws(() => generatedUiContent({...valid(), css: ''}), /shorter interface|normal answer/);
  assert.throws(() => generatedUiContent({...valid(), placeholderMessages: 'loading'}), /shorter interface|normal answer/);
  assert.throws(() => generatedUiContent({...valid(), placeholderMessages: ['a', 'b', 'c', 'd']}), /shorter interface|normal answer/);
});

test('generated UI content rejects external resources that its CSP would only break at render time', () => {
  assert.throws(
    () => generatedUiContent({...valid(), html: '<script src="https://cdn.example.test/chart.js"></script><section>Chart</section>'}),
    /external resources/,
  );
  assert.throws(
    () => generatedUiContent({...valid(), css: '@import url("https://cdn.example.test/site.css"); #root{color:red}'}),
    /external resources/,
  );
  assert.throws(
    () => generatedUiContent({...valid(), jsExpressions: ["fetch('https://api.example.test/data')"]}),
    /external resources/,
  );
});

test('generated UI content keeps the documented size and shape limits', () => {
  assert.throws(() => generatedUiContent({...valid(), html: 'x'.repeat(18001)}), /exceeded its limits/);
  assert.throws(() => generatedUiContent({...valid(), jsExpressions: [42]}), /exceeded its limits/);
  assert.throws(() => generatedUiContent({...valid(), initialHeight: 99}), /exceeded its limits/);
});
