import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cardLabel, headingIdentifies, identifierKind } from '../src/identifiers.js';
import { validateEntity } from '../src/client.js';
import { sectionKeyFor } from '../src/types.js';
import { fieldKey } from '../src/parser.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { RegistryProvider } from '../src/types.js';

test('company UINs and business-name registration numbers are the only accepted identifiers', () => {
  assert.equal(identifierKind('BW00000123456'), 'company');
  assert.equal(identifierKind('BN2019/11223'), 'businessName');
  for (const value of ['BN2019-11223', 'BN201911223', 'CO2018/15851', 'BW123', 'bn2019/11223', 'BN2019/', '']) assert.equal(identifierKind(value), null, value);
  assert.equal(validateEntity(' bn2019/11223 ').uin, 'BN2019/11223');
  assert.equal(validateEntity('bw00000123456').uin, 'BW00000123456');
  assert.throws(() => validateEntity('BN2019-11223'), { code: 'INVALID_UIN' });
  assert.throws(() => validateEntity('CO2018/15851'), { code: 'INVALID_UIN' });
});

test('card labels and headings identify companies by UIN and business names by name', () => {
  assert.equal(cardLabel('Example Limited', 'BW00000123456'), 'Example Limited (BW00000123456)');
  assert.equal(cardLabel('Example Hyper', 'BN2019/11223'), 'Example Hyper');
  assert.ok(headingIdentifies('Example Limited (BW00000123456)', 'BW00000123456', 'Example Limited'));
  assert.ok(!headingIdentifies('Example Limited (BW00000123457)', 'BW00000123456', 'Example Limited'));
  assert.ok(headingIdentifies('Example Hyper', 'BN2019/11223', 'Example Hyper'));
  assert.ok(!headingIdentifies('Example Hyper Two', 'BN2019/11223', 'Example Hyper'));
});

test('tab labels map to section keys regardless of case, with observed new tabs named', () => {
  assert.equal(sectionKeyFor('General details', fieldKey), 'general');
  assert.equal(sectionKeyFor('General Details', fieldKey), 'general');
  assert.equal(sectionKeyFor('Proprietors', fieldKey), 'proprietors');
  assert.equal(sectionKeyFor('Persons Authorised to Accept Service', fieldKey), 'authorisedPersons');
  assert.equal(sectionKeyFor('Accounting Officers', fieldKey), 'accountingOfficers');
  assert.equal(sectionKeyFor('Members', fieldKey), 'members');
  assert.equal(sectionKeyFor('Something New', fieldKey), 'somethingNew');
});

test('the entity routes accept an encoded business-name number and hand the provider the decoded form', async () => {
  const seen: string[] = [];
  const provider: RegistryProvider = {
    search: async o => ({ query: o.q, items: [], page: o.page, pageSize: o.pageSize, total: 0, hasMore: false, retrievedAt: 'now', source: 'CIPA' }),
    getEntity: async uin => { seen.push(`entity:${uin}`); return { uin, name: 'Example Hyper', status: 'Registered', entityType: 'Business name', availableSections: [], sections: {}, complete: true, warnings: [], retrievedAt: 'now', source: 'CIPA' }; },
    getDocuments: async uin => { seen.push(`documents:${uin}`); return { uin, name: 'Example Hyper', documents: [], complete: true, warnings: [], retrievedAt: 'now', source: 'CIPA' }; },
    close: async () => {},
  };
  const app = await buildApp({ ...loadConfig({}), prewarm: false }, provider);
  try {
    const entity = await app.inject('/v1/entities/BN2019%2F11223?include=general');
    assert.equal(entity.statusCode, 200); assert.equal(entity.json().data.uin, 'BN2019/11223');
    assert.equal((await app.inject('/v1/entities/bn2019%2f11223/documents')).statusCode, 200);
    assert.deepEqual(seen, ['entity:BN2019/11223', 'documents:BN2019/11223']);
    for (const url of ['/v1/entities/BN2019-11223', '/v1/entities/CO2018%2F15851', '/v1/entities/BN2019%2F11223%2F1']) assert.equal((await app.inject(url)).statusCode, 400, url);
  } finally { await app.close(); }
});
