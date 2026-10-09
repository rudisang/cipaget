/**
 * Public registry identifiers that CIPA's own "Name or number" search box accepts.
 * Companies carry a UIN (BW…) on their search card and heading. Business names show no
 * number anywhere in the public UI, but their registration number (BN<year>/<number>) is
 * accepted by the same search box and identifies the opened view's bootstrap.
 */
export const UIN_PATTERN = /^BW\d{5,20}$/;
export const BUSINESS_NAME_NUMBER_PATTERN = /^BN\d{4}\/\d{1,10}$/;
export type EntityKind = 'company' | 'businessName';
export function identifierKind(id: string): EntityKind | null {
  if (UIN_PATTERN.test(id)) return 'company';
  if (BUSINESS_NAME_NUMBER_PATTERN.test(id)) return 'businessName';
  return null;
}
export const isBusinessName = (id: string): boolean => BUSINESS_NAME_NUMBER_PATTERN.test(id);
/** The register a search card names for a business name. Such cards show no number at all. */
export const isBusinessNameRegister = (register: string | null | undefined): boolean => /^business names?$/i.test(register ?? '');
/** Accessible name of the public search-card link: companies append their UIN, business names do not. */
export const cardLabel = (name: string, id: string): string => (isBusinessName(id) ? name : `${name} (${id})`);
/** Whether a rendered level-1 heading identifies the requested entity. */
export function headingIdentifies(heading: string, id: string, name: string): boolean {
  if (!isBusinessName(id)) return heading.includes(`(${id})`);
  return heading === name || heading === `${name} (${id})`;
}
