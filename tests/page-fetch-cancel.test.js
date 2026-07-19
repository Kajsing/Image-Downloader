const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const popupSource = fs.readFileSync(path.join(__dirname, '..', 'popup.js'), 'utf8');

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist`);
  const bodyStart = source.indexOf('{', start);
  let depth = 0;

  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }

  throw new Error(`Could not extract ${name}`);
}

test('page fetch cancellation aborts every controller registered to the session', () => {
  const cancelFunction = extractFunction(popupSource, 'cancelPageFetchSession');
  const aborted = [];
  const context = vm.createContext({ recordAbort(value) { aborted.push(value); } });
  vm.runInContext(`
    globalThis.__guidedMediaFetchControllers = new Map([
      ['session-1', new Set([
        { abort() { recordAbort('one'); } },
        { abort() { recordAbort('two'); } }
      ])]
    ]);
  `, context);
  vm.runInContext(cancelFunction, context);

  const result = vm.runInContext("cancelPageFetchSession('session-1')", context);
  assert.equal(result.cancelled, 2);
  assert.deepEqual(aborted, ['one', 'two']);
  assert.equal(context.__guidedMediaFetchControllers.has('session-1'), false);
});

test('page previews are retrieved individually from the page registry', () => {
  const readFunction = extractFunction(popupSource, 'readPagePreviewData');
  const context = vm.createContext({});
  vm.runInContext(`
    globalThis.__guidedMediaPreviewData = new Map([
      ['preview-1', 'data:image/jpeg;base64,one'],
      ['preview-2', 'data:image/jpeg;base64,two']
    ]);
  `, context);
  vm.runInContext(readFunction, context);

  assert.equal(
    vm.runInContext("readPagePreviewData('preview-2')", context),
    'data:image/jpeg;base64,two'
  );
  assert.equal(vm.runInContext("readPagePreviewData('missing')", context), '');
});
