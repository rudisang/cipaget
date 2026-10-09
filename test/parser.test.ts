import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDate, parseSearch, parseSection, parseOwnershipStatements, deduplicateSearch, mergeSection } from '../src/parser.js';

// Fixtures below mirror the public register's markup as captured live (class names, data attributes, nesting).
const expando = (trigger: string, body: string, label?: string) => `<div class="cat-expando-box cat-box expando"${label ? ` data-label="${label}"` : ''}><div class="expando-trigger-wrapper"><a role="button" aria-expanded="true" class="cat-expando-trigger expando-trigger" data-label="${trigger}"><span>${trigger}</span></a></div><div class="expandoContainer"><div id="x_expando">${body}</div></div></div>`;
const note = (value: string, attribute?: string) => `<div class="cat-attribute-readonly-wrapper" data-nodetype="record"${attribute ? ` data-attribute-name="${attribute}"` : ''}><span class="dd value" role="note">${value}</span></div>`;
const card = (title: string, tokens: string[], body: string) => `<li><div class="cat-card search-result" role="group"><div class="cat-card-body"><a class="cat-btn simple link searchView" role="link">${title}</a><div class="tokenized-line">${tokens.map(t => `<span class="token">${t}</span>`).join(' ')}</div>${body}</div></div></li>`;

test('search: entities, previous names versus previous addresses, explicit empty and unknown layouts', () => {
  const html = card('Example &amp; Sons (BW00000123456)', ['Removed / Cancelled', 'Companies', 'Private company', 'Registered on 29 January 2018'],
    note('Plot 2482b, Tshekedi Crescent, Gaborone, Botswana', 'FullAddress') +
    expando('Hide previous names', note('Former Example Limited (17 March 1975 - 06 February 2020)')) +
    expando('Hide previous addresses', note('Deloitte House, Plot 64518, Fairgrounds, Gaborone, Botswana (17 March 1975 - 11 June 2023)') + note('Plot 1, Gaborone, Botswana (2010 - 2018)'))) +
    '<a aria-label="Next Page" aria-disabled="true"></a>';
  const result = parseSearch(html);
  const item = result.items[0];
  assert.equal(item.uin,'BW00000123456');
  assert.equal(item.name,'Example & Sons');
  assert.equal(item.registeredOn,'2018-01-29');
  assert.equal(item.address,'Plot 2482b, Tshekedi Crescent, Gaborone, Botswana');
  assert.deepEqual(item.previousNames,['Former Example Limited (17 March 1975 - 06 February 2020)']);
  assert.deepEqual(item.previousAddresses,['Deloitte House, Plot 64518, Fairgrounds, Gaborone, Botswana (17 March 1975 - 11 June 2023)','Plot 1, Gaborone, Botswana (2010 - 2018)']);
  assert.deepEqual(item.fields.map(f => [f.key, f.group ?? null]), [['FullAddress', null], ['previousNames', 'Previous names'], ['previousAddresses', 'Previous addresses'], ['previousAddresses', 'Previous addresses']]);
  assert.equal(result.hasMore,false);
  assert.deepEqual(parseSearch('<h2>Search Results</h2><p>Your search returned no results</p>').items,[]);
  assert.deepEqual(parseSearch('<h2>Search Results</h2><p>No results found using the given search criteria</p>').items,[]);
  assert.throws(()=>parseSearch('<h2>Service unavailable</h2>'),{code:'UPSTREAM_LAYOUT_CHANGED'});
});

test('section: distinguish null from zero/false, retain repeated fields, exclude hidden templates', () => {
  const field = (id:string,label:string,value:string) => `<div class="cat-attribute-readonly-wrapper" id="${id}" data-attribute-name="${label}"><div class="dt">${label}</div><div class="dd value">${value}</div></div>`;
  const html = `<h2>General Details</h2>${field('a','Constitution','Not specified')}${field('b','Shares','0')}${field('c','Exempt','No')}${field('d','Address','Current')}${field('e','Address','Previous')}<div style="display:none">${field('x','Secret','DO NOT RETURN')}</div>`;
  const section = parseSection(html,'General Details',{a:{attributeValue:null},b:{attributeValue:0},c:{attributeValue:false},x:{attributeValue:'HIDDEN'}});
  assert.equal(section.fields.length,5);
  assert.equal(section.fields[0].value,null);
  assert.equal(section.fields[0].displayValue,'Not specified');
  assert.equal(section.fields[1].value,'0');
  assert.equal(section.fields[2].machineValue,false);
  assert.equal(section.fields.filter(f=>f.key==='Address').length,2);
  assert.ok(!section.text.includes('DO NOT RETURN'));
});
test('legacy business-name search results may omit both UIN and entity subtype',()=>{
  const r=parseSearch('<div class="search-result"><a class="searchView">Example Shop</a><div class="tokenized-line"><span class="token">Removed / Cancelled</span><span class="token">Business names</span><span class="token">Registered on 17 June 2010</span></div><span class="dd value"></span></div>');
  assert.equal(r.items[0].uin,null);assert.equal(r.items[0].entityType,null);assert.equal(r.items[0].registeredOn,'2010-06-17');assert.equal(r.items[0].address,null);
});
test('a business name whose own name ends in a company number is not reported as that company',()=>{
  const r=parseSearch('<div class="search-result"><a class="searchView">Example Shop (BW00000123456)</a><div class="tokenized-line"><span class="token">Registered</span><span class="token">Business Names</span><span class="token">Registered on 03 June 2019</span></div></div>').items[0];
  assert.equal(r.uin,null);assert.equal(r.name,'Example Shop (BW00000123456)');
});
test('overlapping source pages are deduplicated without merging distinct unnumbered entities',()=>{
  const item=parseSearch('<div class="search-result"><a class="searchView">Example Shop</a></div>').items[0];
  assert.equal(deduplicateSearch([item,item,{...item,address:'Different office'}]).length,2);
  assert.equal(deduplicateSearch([{...item,uin:'BW00000123456'},{...item,uin:'BW00000123456',name:'Changed display'}]).length,1);
});

test('section: record boundaries, tables, and empty versus missing', () => {
  const section = parseSection('<h2>Directors</h2><div role="listitem" class="cat-repeater-child" aria-label="Example Person"><h4>Example Person</h4><p>Appointment: 1 January 2020</p></div><table><thead><tr><th>Shares</th></tr></thead><tbody><tr><td>1,000</td></tr></tbody></table>','Directors');
  assert.equal(section.records[0].title,'Example Person');
  assert.deepEqual(section.tables[0].rows,[['1,000']]);
  assert.equal(parseSection('<h2>Auditors</h2><p>No auditors added yet.</p>','Auditors').status,'empty');
  assert.throws(()=>parseSection('<div class="cat-loading-component">Loading</div>','Directors'),{code:'UPSTREAM_LAYOUT_CHANGED'});
});
test('empty notes observed on external, close, guarantee, removed companies and business names are empty, not available',()=>{
  const notes=['No authorised agents added yet.','All current directors have been removed. You need to add at least one director.','No new beneficial owners added',
    'No accounting officers added yet.','All current members have been removed. You need to add at least one member.','All current proprietors have been removed. You need to add at least one proprietor.'];
  for(const note of notes)assert.equal(parseSection(`<h2>Section</h2><span>Note</span><div class="errors-text">${note}</div>`,'Section').status,'empty',note);
  // A real zero remains data even next to an empty note.
  const allocations=parseSection('<h2>Share Allocations</h2><div class="errors-text">No share allocations have been added yet.</div><div class="cat-attribute-readonly-wrapper" data-attribute-name="TotalShare"><div class="dt">Total number of shares</div><div class="dd value">0</div></div>','Share Allocations');
  assert.equal(allocations.status,'available');assert.equal(allocations.fields[0].value,'0');
  // "No" as a field value is not an empty note.
  const nominee=parseSection('<h2>Directors</h2><div role="listitem" class="cat-repeater-child" aria-label="Example Person"><div class="cat-attribute-readonly-wrapper" data-attribute-name="HasNominator"><div class="dt">Has nominator</div><div class="dd value">No</div></div></div>','Directors');
  assert.equal(nominee.status,'available');
});
test('strict dates preserve calendar validity',()=>{
  assert.equal(parseDate('29 February 2024'),'2024-02-29');
  assert.equal(parseDate('29 February 2025'),null);
  assert.equal(parseDate('31 April 2024'),null);
  assert.equal(parseDate('Unknown'),null);
});
test('filing tables keep accessible timestamps and omit the decorative Today row',()=>{
  const section=parseSection('<table><thead><tr><th>Date</th><th>Item</th></tr></thead><tbody><tr><td><div class="cat-timeline-item today">Today</div></td><td></td></tr><tr><td><div role="cell" aria-label="Completed on 23 April 2026 08:42 CAT">23 April 2026</div></td><td>Restoration</td></tr></tbody></table>','Filings');
  assert.deepEqual(section.tables[0].rows,[['Completed on 23 April 2026 08:42 CAT','Restoration']]);
});
test('rendered diagram labels are presentation, not section text',()=>{
  // Observed: while laying out, the visualiser keeps a node label as a <g> beside the <svg>, not inside it.
  const html='<h2>Visualisation</h2><div class="visualizer-container"><div>Display depth</div><svg id="bods-svg"><g class="node"><text x="0" y="90"><tspan>Chandrakant Chauhan</tspan></text></g><g class="edgeLabel"><text><textPath>Owns 100%</textPath></text></g></svg><g class="node registeredEntity"><g class="label"><text><tspan>Sefalana Cash &amp; Carry Limited</tspan></text></g></g><defs></defs></div>';
  const section=parseSection(html,'Visualisation');
  assert.equal(section.text,'Visualisation\nDisplay depth');
  assert.equal(section.status,'available');
});
test('only public visualiser BODS data is exported from response state',()=>{
  const statements=[{statementID:'example',statementType:'entityStatement',name:'Example'}];
  assert.deepEqual(parseOwnershipStatements({a:{widget:'visualiser',widgetData:{jsonData:JSON.stringify(statements)}},secret:{attributeValue:'hidden'}}),statements);
  assert.equal(parseOwnershipStatements({a:{widget:'visualiser',widgetData:{jsonData:'not json'}}}),null);
  assert.equal(parseOwnershipStatements({a:{widget:'visualiser',widgetData:{jsonData:'[{"password":"hidden"}]'}}}),null);
});
test('filing pagination does not assign stale accessible timestamps to newer visible dates',()=>{
  const first=parseSection('<table><tbody><tr><td><div role="cell" aria-label="Completed on 23 April 2026 08:42 CAT">23 April 2026</div></td><td>Restoration</td></tr></tbody></table>','Filings');
  const next=parseSection('<table><tbody><tr><td><div role="cell" aria-label="Completed on 23 April 2026 08:42 CAT">17 October 2024</div></td><td>Directors</td></tr></tbody></table>','Filings');
  assert.deepEqual(next.tables[0].rows,[['17 October 2024','Directors']]);
  assert.equal(next.warnings.length,1);
  mergeSection(first,next);
  assert.equal(first.warnings.length,1);
  assert.equal(first.tables[0].rows[0][0],'Completed on 23 April 2026 08:42 CAT');
});

const attribute = (id: string, label: string, value: string, name = '') => `<div id="${id}" class="cat-attribute-readonly-wrapper" data-nodetype="attribute" data-label="${label}"${name ? ` data-attribute-name="${name}"` : ''}><div class="dl readonly-list"><div class="dt">${label} </div><div class="dd value">${value} </div></div></div>`;
const current = (inner: string) => `<div class="cat-box shr-current-section" data-nodetype="repeater">${inner}</div>`;
const history = (trigger: string, items: string[]) => `<div class="cat-expando-box cat-box expando glue-historic-single-value shr-prev-section"><div class="expando-trigger-wrapper"><a role="button" aria-expanded="true" class="cat-expando-trigger expando-trigger" data-label="${trigger}"><span>${trigger}</span></a></div><div class="expandoContainer"><div id="h_expando"><div id="false" class="cat-attribute-readonly-wrapper historic-single-value-list"><span class="dd value" role="note">${items.map(item => `<div class="repeater-child historic-single-value-item"><div id="false" class="cat-attribute-readonly-wrapper"><span class="dd value" role="note">${item}</span></div></div>`).join(' ')}</span></div></div></div></div>`;
const box = (label: string, heading: string, inner: string, tag = 'h2') => `<div class="cat-box" data-label="${label}"><div class="cat-box-header"><${tag} data-label-type="${heading}">${label} </${tag}></div>${inner}</div>`;

test('general: previous statuses and names keep their label, get a previous key and the disclosure as group; no aggregated duplicate', () => {
  const html = box('General Details', 'section-title',
    attribute('a1', 'Company Name', 'Example Limited', 'companyName') +
    current(attribute('s1', 'Company status', 'Registered (Effective from 23 April 2026) | Reason: Request for restoration under section 341(a)')) +
    history('Hide Previous Statuses', ['Removed (Effective from 11 March 2026 to 22 April 2026) | Reason: Deregistration due to failure to file annual return', 'Registered (Effective from 29 January 2018 to 10 March 2026)']) +
    attribute('d1', 'Incorporation Date', '29 January 2018', 'RegistrationDate') +
    box('Company Details', 'section-title', `<div class="cat-box glue-document-repeater readonly" data-label="Constitution"><div id="false" class="cat-attribute-readonly-wrapper"><div class="dl readonly-list"><div class="dt">Constitution </div><div class="dd value"><div class="cat-list"><div class="cat-list-tile"><div class="cat-view-document"><a href="/companies/document/XP-x"><span class="file-name">Constitution.pdf </span></a><span class="view-document-date">Uploaded 28 August 2026 14:21 CAT</span></div></div></div></div></div></div></div>` + attribute('m1', 'Annual return filing month', 'February', 'FilingMonth')));
  const section = parseSection(html, 'General Details', { s1: { attributeValue: 'registered' } });
  assert.deepEqual(section.fields.map(f => [f.key, f.label, f.group ?? null]), [
    ['companyName', 'Company Name', null],
    ['companyStatus', 'Company status', null],
    ['previousCompanyStatus', 'Company status', 'Previous Statuses'],
    ['previousCompanyStatus', 'Company status', 'Previous Statuses'],
    ['RegistrationDate', 'Incorporation Date', null],
    ['constitution', 'Constitution', 'Company Details'],
    ['FilingMonth', 'Annual return filing month', 'Company Details'],
  ]);
  assert.equal(section.fields[1].machineValue, 'registered');
  assert.equal(section.fields[2].value, 'Removed (Effective from 11 March 2026 to 22 April 2026) | Reason: Deregistration due to failure to file annual return');
  assert.equal(section.fields[3].value, 'Registered (Effective from 29 January 2018 to 10 March 2026)');
  assert.equal(section.fields[5].value, 'Constitution.pdf Uploaded 28 August 2026 14:21 CAT');
  assert.ok(section.text.includes('Removed (Effective from 11 March 2026 to 22 April 2026)'));
  assert.ok(!section.text.includes('Hide Previous Statuses'));
});

test('addresses: history items inherit the adjacent current label; "Share register" summary line becomes a labelled field', () => {
  const html = box('Addresses', 'section-title',
    current(attribute('r1', 'Registered Office Address', 'Plot 203, Independence Avenue, Gaborone, Botswana (Effective from 15 September 2025)')) +
    history('Hide Previous Addresses', ['Grant Thornton Business Services, Plot 50370, Acumen Park, Fairgrounds, Gaborone, Botswana (Effective from 12 October 1973 to 14 September 2025)']) +
    current(attribute('p1', 'Postal Address', 'P O Box 706, Gaborone, Botswana (Effective from 15 September 2025)')) +
    `<div class="cat-box heading-mbs" data-label="Location of Company Records" data-nodetype="repeater"><div class="cat-box-header"><h4 class="label" data-label-type="group-title">Location of Company Records </h4></div><div class="cat-box glue-record"><div data-nodetype="box"><p data-label-type="repeater-summary" data-nodetype="text" data-widget="glue-sub"><b>Share register</b>: Plot 203 Independence Avenue, Gaborone, Botswana (Effective from 15 September 2025)</p></div></div></div>`);
  const section = parseSection(html, 'Addresses');
  assert.deepEqual(section.fields.map(f => [f.key, f.label, f.value, f.group ?? null]), [
    ['registeredOfficeAddress', 'Registered Office Address', 'Plot 203, Independence Avenue, Gaborone, Botswana (Effective from 15 September 2025)', null],
    ['previousRegisteredOfficeAddress', 'Registered Office Address', 'Grant Thornton Business Services, Plot 50370, Acumen Park, Fairgrounds, Gaborone, Botswana (Effective from 12 October 1973 to 14 September 2025)', 'Previous Addresses'],
    ['postalAddress', 'Postal Address', 'P O Box 706, Gaborone, Botswana (Effective from 15 September 2025)', null],
    ['shareRegister', 'Share register', 'Plot 203 Independence Avenue, Gaborone, Botswana (Effective from 15 September 2025)', 'Location of Company Records'],
  ]);
});

test('people: record summary lines, previous-people list group, sub-headings and previous addresses inside a record', () => {
  const person = (name: string, summary: string, details: string) => `<div class="cat-repeater-child" role="listitem" aria-label="${name}"><div class="grid-x cat-repeater-child-summary expanded"><div class="child-summary-toggle-details"><a role="button" class="toggle-details-btn" data-label="More Details" aria-label="More Details ${name}" aria-expanded="true"></a></div><div class="child-summary-body"><h4 data-label-type="repeater-summary-title">${name}</h4><p data-label-type="repeater-summary" data-widget="glue-sub">${summary}</p></div></div><div class="expando-details"><div role="group" data-label="More Details" aria-label="More Details">${details}</div></div></div>`;
  const list = (children: string, title?: string) => `<div class="glue-repeater-standard repeater-wrapper"><div class="cat-repeater repeater-standard">${title ? `<h3 class="repeater-title" data-label-type="repeater-title">${title}</h3>` : ''}<div class="repeater-body" role="list">${children}</div></div></div>`;
  const prevAddress = `<div class="cat-expando-box cat-box expando column-indent shr-prev-section" data-widget="glue-expando"><div class="expando-trigger-wrapper"><a role="button" aria-expanded="true" class="cat-expando-trigger expando-trigger" data-label="Hide previous addresses"><span>Hide previous addresses</span></a></div><div class="expandoContainer"><div id="p_expando">${attribute('false', 'Postal Address', '7013 / Tlokweng, Mmaratanang, Tlokweng, Botswana (Effective from 29 January 2019 to 29 January 2019)')}</div></div></div>`;
  const nominee = `<div class="cat-box" data-label="Nominee/Alternate Director Details" data-nodetype="box"><div class="cat-box-header"><h5 class="label" data-label-type="group-title">Nominee/Alternate Director Details </h5></div>${attribute('n1', 'Does the Director above have an Alternate Director?', 'Yes', 'HasNominator')}<div class="cat-box" data-label="Postal Address">${current(attribute('false', 'Full Name', 'Neo Lele Bogatsu'))}</div></div>`;
  const html = box('Directors', 'section-title',
    list(person('Aido Proprietary Limited (BW00008005890)', 'Botswana', attribute('t1', 'Nationality', 'Botswana', 'Nationality') + current(attribute('false', 'Postal Address', 'P O Box 211081, Bontleng, Gaborone, Botswana (Effective from 29 January 2019)')) + prevAddress + nominee + attribute('t2', 'Appointment Date', '29 January 2019', 'StartDate'))) +
    expando('Hide Previous Directors', list(person('Thomas Pritchard', '', attribute('t3', 'Appointment Date', '04 September 2019', 'StartDate') + attribute('t4', 'Ceased date', '01 May 2023', 'EndDate')), 'Previous Directors'), 'Previous Directors'));
  const section = parseSection(html, 'Directors', { t1: { attributeValue: 'BW' } });
  assert.equal(section.records.length, 2);
  const [current1, previous] = section.records;
  assert.equal(current1.title, 'Aido Proprietary Limited (BW00008005890)');
  assert.deepEqual(current1.summary, ['Botswana']);
  assert.equal(current1.group, null);
  assert.deepEqual(current1.fields.map(f => [f.key, f.label, f.group ?? null]), [
    ['Nationality', 'Nationality', null],
    ['postalAddress', 'Postal Address', null],
    ['previousPostalAddress', 'Postal Address', 'Previous addresses'],
    ['HasNominator', 'Does the Director above have an Alternate Director?', 'Nominee/Alternate Director Details'],
    ['fullName', 'Full Name', 'Nominee/Alternate Director Details'],
    ['StartDate', 'Appointment Date', null],
  ]);
  assert.equal(current1.fields[0].machineValue, 'BW');
  assert.equal(previous.title, 'Thomas Pritchard');
  assert.deepEqual(previous.summary, []);
  assert.equal(previous.group, 'Previous Directors');
  assert.deepEqual(previous.fields.map(f => [f.key, f.value, f.group ?? null]), [['StartDate', '04 September 2019', null], ['EndDate', '01 May 2023', null]]);
  // Section-level fields are the same copies, so a flat consumer sees identical keys and groups.
  assert.deepEqual(section.fields, [...current1.fields, ...previous.fields]);
  assert.equal(section.status, 'available');
});
