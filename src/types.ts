export const ENTRY_URL = 'https://www.cipa.co.bw/master/ui/start/CIPARegisterSearch';
export const SECTION_LABELS = {
  general: 'General Details', addresses: 'Addresses', directors: 'Directors',
  secretaries: 'Secretaries', shareholders: 'Shareholders', shareAllocations: 'Share Allocations',
  beneficialOwners: 'Beneficial Owners', auditors: 'Auditors', filings: 'Filings',
  visualisation: 'Visualisation', members: 'Members', owners: 'Owners',
  // Observed on external companies, close companies and business names respectively.
  authorisedPersons: 'Persons Authorised to Accept Service', accountingOfficers: 'Accounting Officers', proprietors: 'Proprietors',
} as const;
/** Business-name tabs use sentence case ("General details"); match labels case-insensitively. */
export function sectionKeyFor(label: string, toKey: (label: string) => string): string {
  const wanted = label.trim().toLowerCase();
  return Object.entries(SECTION_LABELS).find(([, value]) => value.toLowerCase() === wanted)?.[0] ?? toKey(label);
}
export type SectionName = keyof typeof SECTION_LABELS;
export interface Field {
  key: string;
  label: string | null;
  value: string | null;
  displayValue: string;
  machineValue?: string | number | boolean | null;
  /** The on-screen sub-heading or disclosure this field sits under, e.g. "Previous Statuses", "Interests". */
  group?: string;
}
export interface DataTable { headers: string[]; rows: string[][] }
export interface DataRecord {
  title: string | null;
  /** Lines shown under the title, such as a corporate shareholder's office or a secretary's country. */
  summary: string[];
  /** The list heading the record appears under, e.g. "Previous Directors"; null for the current list. */
  group: string | null;
  fields: Field[];
  text: string;
}
export interface Section {
  label: string;
  status: 'available' | 'empty' | 'unavailable' | 'restricted' | 'error';
  fields: Field[];
  records: DataRecord[];
  tables: DataTable[];
  text: string;
  pagesFetched: number;
  total: number | null;
  complete: boolean;
  warnings: string[];
  ownershipStatements?: Record<string, unknown>[];
  filingDetails?: Array<{ title: string; text: string; fields: Field[]; records: DataRecord[]; tables: DataTable[]; status: string; complete: boolean; pagesFetched: number; warnings: string[] }>;
}
export interface SearchItem {
  uin: string | null; name: string; status: string | null; register: string | null;
  entityType: string | null; registeredOn: string | null; address: string | null;
  previousNames: string[]; previousAddresses: string[]; fields: Field[]; text: string;
}
export interface SearchResult {
  query: string; items: SearchItem[]; page: number; pageSize: number;
  hasMore: boolean; total: number | null; retrievedAt: string; source: string;
  sourcePagesFetched?: number; warnings?: string[];
}
export interface EntityResult {
  uin: string; name: string; status: string | null; entityType: string | null;
  availableSections: Array<{ key: string; label: string }>;
  sections: Record<string, Section>;
  complete: boolean; warnings: string[]; retrievedAt: string; source: string;
}
export interface SearchOptions { q: string; page: number; pageSize: number }
export type DocumentKind = 'incorporationCertificate' | 'standardExtract';
export interface RegistryDocument {
  kind: DocumentKind; status: 'available' | 'unavailable' | 'restricted' | 'error';
  filename: string | null; mimeType: 'application/pdf'; encoding: 'base64';
  contentBase64: string | null; sizeBytes: number | null; sha256: string | null;
  retrievedAt: string | null; warnings: string[];
}
export interface DocumentsResult {
  uin:string; name:string; documents:RegistryDocument[]; complete:boolean; warnings:string[]; retrievedAt:string; source:string;
}
export interface EntityOptions { include: string[]; history: boolean; filingDetails: boolean; maxPages: number }
export interface RegistryProvider {
  readonly diagnostics?: { transport: 'browser' | 'hybrid'; hybridViews: number; hybridFallbacks: number; hybridResets: number; resetFallbacks: number; publicLinkHits: number; searchFallbacks: number };
  warmup?(signal: AbortSignal): Promise<void>;
  search(options: SearchOptions, signal: AbortSignal): Promise<SearchResult>;
  getEntity(uin: string, options: EntityOptions, signal: AbortSignal): Promise<EntityResult>;
  getDocuments?(uin:string, signal:AbortSignal):Promise<DocumentsResult>;
  close(): Promise<void>;
}
