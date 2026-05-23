/**
 * @fileoverview Domain types for the Wikidata REST and SPARQL APIs.
 * @module services/wikidata/types
 */

/** A single label or description entry (REST API nested object form). */
export type LocalizedString = {
  language: string;
  value: string;
};

/** A label or description map from the REST entity endpoint. */
export type LocalizedStringMap = Record<string, LocalizedString>;

/** Aliases map from the REST entity endpoint. */
export type AliasMap = Record<string, LocalizedString[]>;

// ---------------------------------------------------------------------------
// REST API — raw response shapes
// ---------------------------------------------------------------------------

/** Raw search result item from /v1/search/items or /v1/search/properties. */
export type RawSearchResult = {
  id: string;
  /** Display label — nested { language, value } in REST v1.5. */
  'display-label'?: { language: string; value: string } | null;
  /** Display description — nested { language, value }. */
  'display-description'?: { language: string; value: string } | null;
  match?: {
    type: string;
    language: string;
  } | null;
};

/** Raw sitelink entry. */
export type RawSitelink = {
  title: string;
  url?: string | null;
  badges?: string[];
};

/** Raw statement value content shapes (varies by data type). */
export type RawStatementValue = {
  type: string;
  content: unknown;
};

/** Raw statement object. */
export type RawStatement = {
  id: string;
  rank: 'normal' | 'preferred' | 'deprecated';
  property: {
    id: string;
    data_type?: string | null;
  };
  value: RawStatementValue;
  qualifiers?: RawStatement[];
  references?: Array<{
    hash?: string;
    parts?: RawStatement[];
  }>;
};

/** Raw REST entity response (items or properties). */
export type RawEntity = {
  id: string;
  type: 'item' | 'property';
  data_type?: string | null;
  labels?: LocalizedStringMap;
  descriptions?: LocalizedStringMap;
  aliases?: AliasMap;
  statements?: Record<string, RawStatement[]>;
  sitelinks?: Record<string, RawSitelink>;
};

// ---------------------------------------------------------------------------
// MediaWiki wbgetentities API — raw response shapes
// ---------------------------------------------------------------------------

export type WbLabel = { language: string; value: string };
export type WbDescription = { language: string; value: string };

export type WbEntity = {
  id: string;
  type?: string;
  labels?: Record<string, WbLabel>;
  descriptions?: Record<string, WbDescription>;
  missing?: '';
};

export type WbGetEntitiesResponse = {
  entities?: Record<string, WbEntity>;
  success?: number;
  error?: {
    code: string;
    info: string;
  };
  servedby?: string;
};

// ---------------------------------------------------------------------------
// SPARQL endpoint — raw response shapes
// ---------------------------------------------------------------------------

/** Raw SPARQL 1.1 JSON result binding. */
export type SparqlBinding = {
  type: 'uri' | 'literal' | 'typed-literal' | 'bnode';
  value: string;
  'xml:lang'?: string;
  datatype?: string;
};

/** Raw SPARQL JSON response. */
export type SparqlResponse = {
  head: {
    vars: string[];
  };
  results: {
    bindings: Array<Record<string, SparqlBinding>>;
  };
};

// ---------------------------------------------------------------------------
// Normalized domain types returned by services
// ---------------------------------------------------------------------------

/** Normalized search result. */
export type SearchResult = {
  id: string;
  label: string;
  description: string;
  match: {
    type: string;
    language: string;
  };
};

/** Normalized statement value. */
export type StatementValue =
  | { type: 'wikibase-item'; qid: string; label?: string | undefined }
  | { type: 'time'; time: string; precision: number }
  | { type: 'quantity'; amount: string; unit?: string | undefined; unitLabel?: string | undefined }
  | { type: 'string' | 'external-id' | 'url'; value: string }
  | { type: 'monolingualtext'; text: string; language: string }
  | {
      type: 'globe-coordinate';
      latitude: number;
      longitude: number;
      precision?: number | undefined;
    }
  | { type: 'other'; raw: unknown };

/** Normalized statement. */
export type NormalizedStatement = {
  id: string;
  rank: 'normal' | 'preferred' | 'deprecated';
  property: string;
  value: StatementValue;
  qualifiers?: Array<{ property: string; value: StatementValue }>;
  references?: Array<{ property: string; value: StatementValue }>;
};
