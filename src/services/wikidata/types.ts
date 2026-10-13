/**
 * @fileoverview Domain types for the Wikidata REST and SPARQL APIs.
 * @module services/wikidata/types
 */

/** A label or description map from the REST entity endpoint (plain string values). */
export type LocalizedStringMap = Record<string, string>;

/** Aliases map from the REST entity endpoint (plain string array values). */
export type AliasMap = Record<string, string[]>;

// ---------------------------------------------------------------------------
// REST API — raw response shapes
// ---------------------------------------------------------------------------

/** Raw search result item from /v1/search/items or /v1/search/properties. */
export type RawSearchResult = {
  id: string;
  /** Display label — nested { language, value } in REST v1.5. */
  'display-label'?: { language: string; value: string } | null;
  /** Description — nested { language, value } in REST v1. Note: the field is "description", not "display-description". */
  description?: { language: string; value: string } | null;
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

/**
 * Raw snak value. `value` carries `content`, whose shape varies by data type; `somevalue`
 * (an unknown value) and `novalue` (an explicit absence) carry no `content`.
 */
export type RawStatementValue = {
  type: 'value' | 'somevalue' | 'novalue';
  content?: unknown;
};

/** Raw snak — a property/value pair. The main value, each qualifier, and each reference part are one. */
export type RawSnak = {
  property: {
    id: string;
    data_type?: string | null;
  };
  value: RawStatementValue;
};

/** Raw reference: an ordered group of snaks citing one source. */
export type RawReference = {
  hash?: string;
  parts?: RawSnak[];
};

/** Raw statement object. */
export type RawStatement = RawSnak & {
  id: string;
  rank: 'normal' | 'preferred' | 'deprecated';
  qualifiers?: RawSnak[];
  references?: RawReference[];
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
    /** The offending entity ID on a `no-such-entity` error. Only the first bad ID is named. */
    id?: string;
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

/** The entity kind a non-item entity-ID value names — one per Wikibase entity-ID data type. */
export type EntityIdKind = 'property' | 'lexeme' | 'form' | 'sense' | 'entity-schema';

/** Normalized statement value. */
export type StatementValue =
  | { type: 'wikibase-item'; qid: string; label?: string | undefined }
  /** A property, lexeme, form, sense, or entity-schema reference (`P279`, `L37633-F1`, `E10`) — never labelled. */
  | { type: 'entity-id'; entityType: EntityIdKind; id: string }
  | { type: 'time'; time: string; precision: number }
  | {
      type: 'quantity';
      amount: string;
      unit?: string | undefined;
      /** Uncertainty range, verbatim from upstream; absent on an unbounded quantity. */
      upperBound?: string | undefined;
      lowerBound?: string | undefined;
      unitLabel?: string | undefined;
    }
  | { type: 'string' | 'external-id' | 'url'; value: string }
  | { type: 'monolingualtext'; text: string; language: string }
  | {
      type: 'globe-coordinate';
      latitude: number;
      longitude: number;
      precision?: number | undefined;
    }
  /** An unknown value (`somevalue`) or an explicit absence (`novalue`) — no data by design. */
  | { type: 'somevalue' | 'novalue' }
  | { type: 'other'; raw: unknown };

/** Normalized snak — a qualifier or a reference part. */
export type NormalizedSnak = { property: string; value: StatementValue };

/** Normalized statement. */
export type NormalizedStatement = {
  id: string;
  rank: 'normal' | 'preferred' | 'deprecated';
  property: string;
  value: StatementValue;
  qualifiers?: NormalizedSnak[];
  /** One entry per upstream reference, in upstream order, each holding its own parts. */
  references?: Array<{ parts: NormalizedSnak[] }>;
};
