import * as cheerio from 'cheerio';
import type { Cheerio, CheerioAPI } from 'cheerio';
import type { AnyNode } from 'domhandler';
import { ApiError } from './errors.js';
import { isBusinessNameRegister } from './identifiers.js';
import type { DataRecord, DataTable, Field, SearchItem, Section } from './types.js';

export const clean = (value: string | null | undefined): string => (value ?? '').replace(/[\uE000-\uF8FF]/g, '').replace(/\s+/g, ' ').trim();
export const fieldKey = (value: string): string => value.replace(/[^\p{L}\p{N}]+(.)/gu, (_, char: string) => char.toUpperCase()).replace(/^[A-Z]/, c => c.toLowerCase());
export const nullable = (value: string): string | null => /^(?:not specified|not provided|not applicable|n\/a|[-—–])?$/i.test(clean(value)) ? null : clean(value);
export function parseDate(value: string | null): string | null {
  if (!value) return null;
  const match = value.match(/^(\d{1,2}) (January|February|March|April|May|June|July|August|September|October|November|December) (\d{4})$/i);
  if (!match) return null;
  const months = ['january','february','march','april','may','june','july','august','september','october','november','december'];
  const month = months.indexOf(match[2].toLowerCase()), day = Number(match[1]), year = Number(match[3]);
  const date = new Date(Date.UTC(year, month, day));
  return date.getUTCMonth() === month && date.getUTCDate() === day ? date.toISOString().slice(0, 10) : null;
}
export function loadVisible(html: string): CheerioAPI {
  const $ = cheerio.load(html);
  $('script,style,template,[hidden],[aria-hidden="true"],.visually-hidden').remove();
  $('[style]').each((_, el) => {
    if (/(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test($(el).attr('style') ?? '')) $(el).remove();
  });
  return $;
}
function text($: CheerioAPI, root: AnyNode): string {
  const copy = $(root).clone();
  // Rendered diagrams are presentation whose text varies between renders; the ownership visualiser's
  // data is exported as BODS statements. While laying out, it measures node labels as SVG elements
  // (g/text) placed outside the svg, so those stragglers are excluded as well.
  copy.find('button,[role=button],input,select,[role=navigation],.pagination,.repeater-pagination,svg,canvas,g,defs,text').remove();
  copy.find('br').replaceWith('\n');
  copy.find('p,div,li,tr,h1,h2,h3,h4,th,td').append('\n');
  return copy.text().split('\n').map(clean).filter(Boolean).join('\n');
}
/** CIPA's disclosure controls read "Show previous addresses" / "Hide Previous Statuses"; the group is the noun phrase. */
const disclosureLabel = (value: string): string => {
  const label = clean(value).replace(/^(?:show|hide)\s+/i, '');
  return label ? label[0].toUpperCase() + label.slice(1) : '';
};
/** The visible heading of a disclosure box, read-only group box or titled repeater; nothing is inferred. */
function groupLabel($: CheerioAPI, el: AnyNode): string | null {
  const node = $(el);
  if (node.hasClass('cat-expando-box')) {
    return disclosureLabel(node.attr('data-label') ?? node.children('.expando-trigger-wrapper').find('.cat-expando-trigger').first().text()) || null;
  }
  if (node.hasClass('cat-repeater')) return clean(node.children('.repeater-title').first().text()) || null;
  const header = node.children('.cat-box-header').first();
  return header.length ? clean(header.find('[data-label-type$="-title"]').first().text()) || null : null;
}
/** Ancestors of an element up to, but excluding, the record or panel it belongs to. */
function ancestorsWithin($: CheerioAPI, el: AnyNode, boundary: AnyNode): AnyNode[] {
  const ancestors: AnyNode[] = [];
  for (let node = $(el).parent(); node.length && node[0] !== boundary; node = node.parent()) ancestors.push(node[0]);
  return ancestors;
}
/** Nearest on-screen sub-heading above an element, ignoring the section's own title. */
function groupOf($: CheerioAPI, el: AnyNode, boundary: AnyNode, sectionLabel: string | null): string | null {
  for (const ancestor of ancestorsWithin($, el, boundary)) {
    const label = groupLabel($, ancestor);
    if (label && label !== sectionLabel) return label;
  }
  return null;
}
/** A previous-values disclosure (statuses, addresses, names), as opposed to a list of previous people. */
function historicDisclosure($: CheerioAPI, el: AnyNode, boundary: AnyNode): Cheerio<AnyNode> | null {
  const box = ancestorsWithin($, el, boundary).find(ancestor => $(ancestor).hasClass('cat-expando-box'));
  if (!box || $(box).find('.cat-repeater-child').length) return null;
  return /\b(?:previous|historic|former|ceased)\b/i.test(groupLabel($, box) ?? '') ? $(box) : null;
}
const withGroup = (field: Field, group: string | null): Field => group ? { ...field, group } : field;
export function extractFields($: CheerioAPI, root: AnyNode, state: Record<string, any> = {}, sectionLabel: string | null = null): Field[] {
  const fields: Field[] = [];
  // Read-only attribute wrappers plus the plain summary paragraphs CIPA uses for e.g. "Share register: …".
  for (const el of $(root).find('.cat-attribute-readonly-wrapper,p[data-label-type="repeater-summary"]').toArray()) {
    const node = $(el);
    const boundary = node.parents('.cat-repeater-child').first()[0] ?? root;
    if (node.is('p')) {
      if (node.closest('.cat-repeater-child-summary').length) continue; // That text is the record's own summary line.
      const bold = node.children('b,strong').first();
      const whole = clean(node.text());
      const label = bold.length && whole.startsWith(clean(bold.text())) && /^\s*:/.test(whole.slice(clean(bold.text()).length)) ? clean(bold.text()) : null;
      const displayValue = label ? clean(whole.slice(label.length).replace(/^\s*:\s*/, '')) : whole;
      if (!displayValue) continue;
      fields.push(withGroup({ key: label ? fieldKey(label) : 'value', label, value: nullable(displayValue), displayValue }, groupOf($, el, boundary, sectionLabel)));
      continue;
    }
    const valueNode = node.find('.dd.value').first();
    if (!valueNode.length || valueNode.closest('.cat-attribute-readonly-wrapper')[0] !== el) continue;
    // A history list wrapper repeats its items' text in one value; the items are read individually.
    if (valueNode.find('.cat-attribute-readonly-wrapper .dd.value').length) continue;
    const historic = historicDisclosure($, el, boundary);
    let label = clean(node.find('.dt').first().text()) || clean(node.attr('data-label')) || null;
    // "Show Previous Statuses" items carry no label of their own; the current value beside them does.
    if (!label && historic) label = clean(historic.prev('.shr-current-section').find('.dt').first().text()) || null;
    const group = groupOf($, el, boundary, sectionLabel);
    const attribute = node.attr('data-attribute-name');
    // History items get a distinct key so a key-indexed consumer never overwrites the current value with an old one.
    const key = historic ? (attribute ? `previous${attribute[0].toUpperCase()}${attribute.slice(1)}` : label ? fieldKey(`previous ${label}`) : fieldKey(group ?? 'previous value'))
      : attribute || (label ? fieldKey(label) : 'value');
    const displayValue = clean(valueNode.text());
    const field: Field = { key, label, value: nullable(displayValue), displayValue };
    const machine = state[node.attr('id') ?? '']?.attributeValue;
    if (machine === null || ['string','number','boolean'].includes(typeof machine)) {
      // Only enrich visible fields, never export hidden form state or backend identifiers.
      if (!/(?:ids?|key|token|password)$/i.test(key)) field.machineValue = machine;
    }
    fields.push(withGroup(field, group));
  }
  return fields;
}
function tableCell($: CheerioAPI, cell: AnyNode): { value: string; stale: boolean } {
  const visible = clean($(cell).text());
  const accessible = clean($(cell).find('[role="cell"][aria-label]').first().attr('aria-label'));
  const date = accessible.match(/^Completed on (\d{1,2} [A-Za-z]+ \d{4})\b/);
  // CIPA reuses timeline components across pages without always refreshing aria-label.
  const stale = !!date && parseDate(visible) !== null && parseDate(date[1]) !== parseDate(visible);
  return { value: stale ? visible : accessible || visible, stale };
}
export function extractTables($: CheerioAPI, root: AnyNode): DataTable[] {
  return $(root).find('table').toArray().map(table => ({
    headers: $(table).find('thead th').toArray().map(el => clean($(el).text())),
    rows: $(table).find('tbody > tr').toArray().filter(row => !$(row).find('.cat-timeline-item.today').length).map(row => $(row).children('td,th').toArray().map(cell => tableCell($, cell).value)),
  }));
}
export function parseSection(html: string, label: string, state: Record<string, any> = {}): Section {
  const $ = loadVisible(html), root = $.root()[0];
  if ($('.cat-loading-component').length) throw new ApiError('UPSTREAM_LAYOUT_CHANGED', 'CIPA still has unloaded components. Refusing to return incomplete fields.', 502, true);
  const fields = extractFields($, root, state, label);
  const records: DataRecord[] = $('.cat-repeater-child[role=listitem]').toArray().map(el => ({
    title: clean($(el).attr('aria-label')) || clean($(el).find('h4').first().text()) || null,
    // The lines under a record's name: a corporate shareholder's office, a secretary's country, and so on.
    summary: $(el).children('.cat-repeater-child-summary').find('[data-label-type="repeater-summary"]').toArray().map(p => clean($(p).text())).filter(Boolean),
    group: groupOf($, el, root, label),
    fields: extractFields($, el, state, label), text: text($, el),
  }));
  const tables = extractTables($, root), body = text($, root);
  // Observed empty notes: "No auditors added yet", "No new beneficial owners added", "No authorised agents added yet",
  // "No accounting officers added yet", "No share allocations have been added yet", "All current directors have been removed".
  // The "Note" label and the message are adjacent without whitespace in the rendered text ("NoteNo …").
  const emptyMessage = /(?:\b(?:note)?no (?:[a-z]+ ){0,5}?(?:added|found|available|recorded)\b|\bhave been removed\b|no data|nothing to display)/i.test(body);
  const restricted = /(?:log in|login|sign in).*(?:required|to view|to access)|not authorised|not authorized|access denied/i.test(body);
  const status = restricted ? 'restricted' : emptyMessage && !records.length && !fields.some(f => f.value !== null) && !tables.some(t => t.rows.length) ? 'empty' : 'available';
  // An empty table or a heading alone can also legitimately represent an empty section.
  const headingOnly = clean(body) === clean(label) || clean(body) === `${clean(label)} Completed`;
  const warnings = restricted ? ['CIPA requires additional access for this section.'] : [];
  if ($('tbody td').toArray().some(cell => tableCell($, cell).stale)) warnings.push('CIPA supplied stale accessibility timestamps; affected filing cells use their visible date without a time.');
  return { label, status: headingOnly ? 'empty' : status, fields, records, tables, text: body,
    pagesFetched: 1, total: parseTotal(body), complete: !restricted, warnings };
}
export function parseTotal(text: string): number | null {
  const match = text.match(/\b([\d,]+) results?\b/i);
  return match ? Number(match[1].replaceAll(',', '')) : null;
}
export function parseSearch(html: string): { items: SearchItem[]; hasMore: boolean; total: number | null } {
  const $ = loadVisible(html);
  const items = $('.search-result').toArray().map(el => {
    const card = $(el), title = clean(card.find('a.searchView').first().text());
    if (!title) throw new ApiError('UPSTREAM_LAYOUT_CHANGED', 'A CIPA search result has no readable name.');
    const tokens = card.find('.tokenized-line .token').toArray().map(el => clean($(el).text()));
    // Only company cards end with their UIN. A business name is free text, so a number at the end of one is part of the name.
    const match = isBusinessNameRegister(tokens[1]) ? null : title.match(/^(.*?)\s*\((BW\d+)\)$/i);
    // The card shows the current address, then separate "previous names" and "previous addresses" disclosures.
    const notes = card.find('.dd.value').toArray().map(note => ({ value: clean($(note).text()), group: groupOf($, note, el, null) }));
    const current = notes.filter(note => !note.group).map(note => note.value);
    const previous = (pattern: RegExp) => notes.filter(note => note.group && pattern.test(note.group) && note.value).map(note => note.value);
    return { name: match?.[1].trim() ?? title, uin: match?.[2].toUpperCase() ?? null,
      status: tokens[0] || null, register: tokens[1] || null, entityType: tokens.slice(2).find(value => !/^Registered on\b/i.test(value)) || null,
      registeredOn: parseDate((tokens.find(value => /^Registered on\b/i.test(value)) ?? '').replace(/^Registered on\s+/i, '')),
      address: current[0] || null, previousNames: previous(/\bnames?\b/i), previousAddresses: previous(/\baddress(?:es)?\b/i),
      fields: extractFields($, el), text: text($, el) };
  });
  if (!items.length && !/Your search returned no results|No results found using the given search criteria/i.test($.root().text())) {
    throw new ApiError('UPSTREAM_LAYOUT_CHANGED', 'CIPA returned neither result cards nor an explicit no-results message.');
  }
  const next = $('[aria-label="Next Page"], [data-label="Next Page"]').first();
  const hasMore = next.length > 0 && !next.is('[disabled],[aria-disabled="true"]') && !next.hasClass('disabled');
  return { items, hasMore, total: parseTotal($.root().text()) };
}
export function mergeSection(target: Section, next: Section) {
  const unique = <T>(a: T[], b: T[]): T[] => {
    const seen = new Set(a.map(value => JSON.stringify(value)));
    return [...a, ...b.filter(value => { const key = JSON.stringify(value); if (seen.has(key)) return false; seen.add(key); return true; })];
  };
  target.fields = unique(target.fields, next.fields);
  target.records = unique(target.records, next.records);
  target.warnings = unique(target.warnings, next.warnings);
  // Keep each page's table separately: identical rows may be legitimate separate entries.
  target.tables.push(...next.tables);
  target.text += '\n\n--- Next page ---\n' + next.text;
  target.pagesFetched++;
}

/** These are specifically the public visualiser's BODS records, not arbitrary UI state. */
export function parseOwnershipStatements(state: Record<string, any>): Record<string, unknown>[] | null {
  const node = Object.values(state).find(node => node?.widget === 'visualiser' && typeof node.widgetData?.jsonData === 'string');
  if (!node) return null;
  try {
    const data = JSON.parse(node.widgetData.jsonData);
    if (!Array.isArray(data) || data.some(statement => !statement || !['entityStatement','personStatement','ownershipOrControlStatement'].includes(statement.statementType))) return null;
    return data;
  } catch { return null; }
}

export function deduplicateSearch(items: SearchItem[]): SearchItem[] {
  const seen = new Set<string>();
  return items.filter(item => {
    const key = item.uin ?? JSON.stringify([item.name,item.register,item.registeredOn,item.address,item.text]);
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}
