const {test} = require('node:test');
const assert = require('node:assert/strict');
const {parseSnapshot, countAvailable} = require('../mqtt-array.js');

test('one full array maps 1 to occupied and 0 to empty', () => {
  const values = parseSnapshot('[1,0,1,0,1,1]');
  assert.equal(values.length, 6);
  assert.equal(countAvailable(values), 2);
});
test('unknown slots are not counted as available', () => {
  assert.equal(countAvailable(parseSnapshot('[null,1,0,null]')), 1);
});
test('supports adding and removing slots by snapshot length', () => {
  for (const length of [1,4,6,12,200]) assert.equal(parseSnapshot(JSON.stringify(Array(length).fill(0))).length, length);
});
test('rejects malformed and ambiguous snapshots rather than inventing vacant slots', () => {
  for (const payload of ['1 0 1 0', '1,0,1,0', '[]', '{}', 'null', '[1,2]', '[true,false]', '["1","0"]', '[0.1]', '[1,]', JSON.stringify(Array(201).fill(0))]) {
    assert.throws(() => parseSnapshot(payload), payload);
  }
});
