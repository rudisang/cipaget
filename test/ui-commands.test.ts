import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commandsOf, expectedClickCommand, matchesClick } from '../src/ui-commands.js';

// Command shapes below are the ones observed on CIPA's public register pages (see docs/research.md).
const post = (...commands: unknown[]) => JSON.stringify({ returnChangesOnly: true, commands });
const pager = { types: ['pagination-update', 'view-node-fire-event'] };

test('pager controls expect their own page command, not a notification that shares the node id', () => {
  const next = expectedClickCommand({ id: '7ab38d4ae3586c6f-pageNext', role: 'button' });
  assert.deepEqual(next, { ...pager, id: '7ab38d4ae3586c6f' });
  // The "show previous directors" disclosure posts this for the same node moments before Next is clicked.
  assert.equal(matchesClick(commandsOf(post({ type: 'view-node-set-key-value', id: '7ab38d4ae3586c6f', key: 'ui-expanded', value: true })), next), false);
  assert.equal(matchesClick(commandsOf(post({ type: 'pagination-update', id: '7ab38d4ae3586c6f' })), next), true);
  assert.equal(matchesClick(commandsOf(post({ type: 'pagination-update', id: 'ffffffffffffffff' })), next), false);
  assert.deepEqual(expectedClickCommand({ id: 'f7839871cb79aa62-header-pageNext', role: 'button' }), { ...pager, id: 'f7839871cb79aa62' });
  assert.deepEqual(expectedClickCommand({ id: 'f7839871cb79aa62-header-results-per-page_menu_item_1', role: 'menuitem' }), { ...pager, id: 'f7839871cb79aa62' });
  // The filings timeline answers its page-size menu with a fired event instead of pagination-update.
  const filings = expectedClickCommand({ id: '50d823eda5051010-results-per-page_menu_item_2', role: 'menuitem' });
  assert.deepEqual(filings, { ...pager, id: '50d823eda5051010' });
  assert.equal(matchesClick(commandsOf(post({ type: 'view-node-fire-event', id: '50d823eda5051010', name: 'ui-filing-page' })), filings), true);
  assert.equal(matchesClick(commandsOf(post({ type: 'view-node-fire-event', id: '5ac6d556d82bcb2e', name: 'ui-tabsSelect' })), filings), false);
});

test('buttons and tabs expect their own command types', () => {
  const search = expectedClickCommand({ id: '3e13f0db7cb08aa8_btn', role: 'button' });
  assert.deepEqual(search, { types: ['view-node-button-click'], id: '3e13f0db7cb08aa8' });
  assert.equal(matchesClick(commandsOf(post({ type: 'view-node-set-attribute-value', id: '3e13f0db7cb08aa8', value: 'x' })), search), false);
  assert.equal(matchesClick(commandsOf(post({ type: 'view-node-set-attribute-value', id: 'abc', value: 'x' }, { type: 'view-node-button-click', id: '3e13f0db7cb08aa8' })), search), true);
  for (const id of [null, '07cbab986faba455_tab_3']) {
    const tab = expectedClickCommand({ id, role: 'tab' });
    assert.deepEqual(tab, { types: ['view-node-fire-event'] });
    for (const name of ['ui-tabsSelect', 'ui-wizardSelect']) assert.equal(matchesClick(commandsOf(post({ type: 'view-node-fire-event', id: '11236b55eec630e5', name })), tab), true);
    assert.equal(matchesClick(commandsOf(post({ type: 'view-node-set-key-value', id: '11236b55eec630e5', value: true })), tab), false);
  }
});

test('unknown controls accept any addressed command and malformed bodies match nothing', () => {
  assert.equal(expectedClickCommand({ id: 'custom-widget', role: null }), null);
  assert.equal(expectedClickCommand({}), null);
  assert.equal(matchesClick(commandsOf(post({ type: 'anything', id: 'abc' })), null), true);
  assert.equal(matchesClick(commandsOf(post({ type: 'anything' })), null), false);
  assert.deepEqual(commandsOf('not json'), []);
  assert.deepEqual(commandsOf(JSON.stringify({ commands: 'nope' })), []);
  assert.deepEqual(commandsOf(JSON.stringify({ commands: [null, 1, { type: 'ok' }] })), [{ type: 'ok' }]);
  assert.deepEqual(commandsOf(null), []);
});
