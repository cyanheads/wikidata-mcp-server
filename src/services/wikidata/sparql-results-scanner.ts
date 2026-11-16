/**
 * @fileoverview Incremental reader for SPARQL 1.1 JSON result documents, used by the Query Service client.
 * @module services/wikidata/sparql-results-scanner
 */

import type { SparqlBinding, SparqlResponse } from './types.js';

/** One SPARQL 1.1 JSON result row: variable name → bound term. */
type SparqlRow = Record<string, SparqlBinding>;

/**
 * The marker of the trailer the Query Service appends to an HTTP 200 body when the query passes
 * its 60 s limit after rows have started streaming: the partial JSON, then the query text and a
 * stack trace naming this exception.
 */
const TIMEOUT_TRAILER = 'java.util.concurrent.TimeoutException';

/** What a scanned response body turned out to be. */
export type SparqlScanOutcome =
  | { kind: 'rows'; head: SparqlResponse['head']; bindings: SparqlRow[]; stoppedEarly: boolean }
  /** An HTML page (a rate-limit or maintenance page), not a result. */
  | { kind: 'html' }
  /** An incomplete document carrying the Query Service's timeout trailer. */
  | { kind: 'timeout' }
  /** Anything else that is not one complete, well-formed result document. */
  | { kind: 'malformed' };

/** A JSON container the scanner walks structurally: the root object, `results`, or `bindings`. */
interface Frame {
  /** True until the container's first member starts — only then may it close straight away. */
  empty: boolean;
  /** The current member's name; objects only. */
  key: string;
  role: 'root' | 'results' | 'bindings';
}

const isJsonSpace = (char: string): boolean =>
  char === ' ' || char === '\n' || char === '\r' || char === '\t';

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A row is an object of terms, each with a string `type` and `value`. */
function isRow(value: unknown): value is SparqlRow {
  if (!isObject(value)) return false;
  for (const term of Object.values(value)) {
    if (!isObject(term) || typeof term.type !== 'string' || typeof term.value !== 'string') {
      return false;
    }
  }
  return true;
}

const isHead = (value: unknown): value is SparqlResponse['head'] =>
  isObject(value) &&
  Array.isArray(value.vars) &&
  value.vars.every((name) => typeof name === 'string');

/**
 * Incremental reader for a SPARQL 1.1 JSON results document, fed decoded text in chunks as it
 * arrives. It walks the root object, `results`, and `bindings` structurally, skips every other
 * member, and captures `head` and each binding whole for `JSON.parse` — so it holds at most one
 * row's text unparsed, and stops at the row limit without reading the rest of the body.
 *
 * Each character is visited once: strings, escapes, and nested containers are tracked by state
 * that carries across chunk seams, captured text is gathered as slices and joined once per
 * value, and the timeout-trailer search overlaps each seam by one marker length. The scan is
 * linear in the body length.
 */
export class SparqlResultsScanner {
  private readonly maxRows: number;
  private readonly bindings: SparqlRow[] = [];
  private readonly frames: Frame[] = [];
  private head: SparqlResponse['head'] | undefined;
  /** Whether `results.bindings` was opened: a document without it carries no rows to report. */
  private sawBindings = false;
  /** Where the next character goes. */
  private mode: 'root' | 'key' | 'keyText' | 'colon' | 'value' | 'next' | 'raw' | 'done' = 'root';
  private state: 'reading' | 'full' | 'malformed' = 'reading';
  private html = false;
  private sawTrailer = false;
  /** The last characters scanned for the trailer, so a marker split by a seam is still found. */
  private trailerTail = '';

  /** Text of the key being read, or of the value being captured, gathered across chunks. */
  private parts: string[] = [];
  /** Where the current chunk's part of a key or captured value starts. */
  private partStart = 0;
  /** The raw value being skipped or captured: its target, open containers, and string state. */
  private capture: 'head' | 'row' | undefined;
  private depth = 0;
  private inString = false;
  private escaped = false;
  private scalar = false;

  /**
   * @param maxRows Most rows to keep. Reading stops when row `maxRows + 1` completes. Unset keeps
   *   every row.
   */
  constructor(maxRows = Number.POSITIVE_INFINITY) {
    this.maxRows = maxRows;
  }

  /** Scans the next chunk of decoded text. Returns false once no more input can change the outcome. */
  push(text: string): boolean {
    if (!this.sawTrailer) {
      const window = this.trailerTail + text;
      this.sawTrailer = window.includes(TIMEOUT_TRAILER);
      this.trailerTail = window.slice(-(TIMEOUT_TRAILER.length - 1));
    }
    if (this.state === 'reading') this.scan(text);
    // A malformed body is read on only to look for the trailer that would make it a timeout.
    if (this.state === 'malformed') return !this.html && !this.sawTrailer;
    return this.state === 'reading';
  }

  /** The outcome, once the body has ended or {@link push} has returned false. */
  finish(): SparqlScanOutcome {
    const complete = this.state === 'reading' && this.mode === 'done';
    if ((complete || this.state === 'full') && this.head && this.sawBindings) {
      const stoppedEarly = this.state === 'full';
      const bindings = stoppedEarly ? this.bindings.slice(0, this.maxRows) : this.bindings;
      return { kind: 'rows', head: this.head, bindings, stoppedEarly };
    }
    if (this.html) return { kind: 'html' };
    if (this.sawTrailer) return { kind: 'timeout' };
    return { kind: 'malformed' };
  }

  private fail(): void {
    this.state = 'malformed';
  }

  private scan(text: string): void {
    this.partStart = 0;
    for (let i = 0; i < text.length; i++) {
      const char = text[i] as string;
      switch (this.mode) {
        case 'raw':
          if (this.rawStep(text, i)) i--;
          break;
        case 'keyText':
          if (this.escaped) this.escaped = false;
          else if (char === '\\') this.escaped = true;
          else if (char === '"') this.endKey(text, i);
          break;
        default:
          if (!isJsonSpace(char)) this.structural(text, i);
      }
      if (this.state !== 'reading') return;
    }
    if (this.mode === 'keyText' || (this.mode === 'raw' && this.capture)) {
      this.parts.push(text.slice(this.partStart));
    }
  }

  /** One structural character outside any string: a token of the root, `results`, or `bindings`. */
  private structural(text: string, i: number): void {
    const char = text[i] as string;
    const frame = this.frames.at(-1);
    const inBindings = frame?.role === 'bindings';
    switch (this.mode) {
      case 'root':
        if (char === '{') {
          this.open('root');
        } else {
          this.html = char === '<';
          this.fail();
        }
        break;
      case 'key':
        if (char === '"') {
          this.mode = 'keyText';
          this.parts = [];
          this.partStart = i + 1;
        } else if (char === '}' && frame?.empty) {
          this.close();
        } else {
          this.fail();
        }
        break;
      case 'colon':
        if (char === ':') this.mode = 'value';
        else this.fail();
        break;
      case 'value':
        if (char === ']' && inBindings && frame.empty) this.close();
        else this.startValue(text, i);
        break;
      case 'next':
        if (char === ',') this.mode = inBindings ? 'value' : 'key';
        else if (char === (inBindings ? ']' : '}')) this.close();
        else this.fail();
        break;
      case 'done':
        // Anything but whitespace after the document.
        this.fail();
        break;
    }
  }

  private open(role: Frame['role']): void {
    if (role === 'bindings') this.sawBindings = true;
    this.frames.push({ role, key: '', empty: true });
    this.mode = role === 'bindings' ? 'value' : 'key';
  }

  private close(): void {
    this.frames.pop();
    this.mode = this.frames.length === 0 ? 'done' : 'next';
  }

  private endKey(text: string, i: number): void {
    this.parts.push(text.slice(this.partStart, i));
    let key: unknown;
    try {
      key = JSON.parse(`"${this.parts.join('')}"`);
    } catch {
      this.fail();
      return;
    }
    (this.frames.at(-1) as Frame).key = key as string;
    this.mode = 'colon';
  }

  /** A value starting at `text[i]`: a container to walk, or a raw value to capture or skip. */
  private startValue(text: string, i: number): void {
    const char = text[i] as string;
    const frame = this.frames.at(-1) as Frame;
    frame.empty = false;
    if (frame.role === 'root' && frame.key === 'results') {
      if (char === '{') this.open('results');
      else this.fail();
      return;
    }
    if (frame.role === 'results' && frame.key === 'bindings') {
      if (char === '[') this.open('bindings');
      else this.fail();
      return;
    }
    const isHeadValue = frame.role === 'root' && frame.key === 'head';
    this.capture = frame.role === 'bindings' ? 'row' : isHeadValue ? 'head' : undefined;
    this.parts = [];
    this.partStart = i;
    this.depth = 0;
    this.inString = false;
    this.escaped = false;
    this.scalar = false;
    this.mode = 'raw';
    if (char === '{' || char === '[') this.depth = 1;
    else if (char === '"') this.inString = true;
    else if (/[-0-9tfn]/.test(char)) this.scalar = true;
    else this.fail();
  }

  /**
   * One character of a raw value. Returns true when the value ended just before it — a bare
   * scalar's delimiter — so the caller scans that character again as structure.
   */
  private rawStep(text: string, i: number): boolean {
    const char = text[i] as string;
    if (this.scalar) {
      if (char === ',' || char === '}' || char === ']' || isJsonSpace(char)) {
        this.endValue(text, i);
        return true;
      }
      return false;
    }
    if (this.inString) {
      if (this.escaped) this.escaped = false;
      else if (char === '\\') this.escaped = true;
      else if (char === '"') {
        this.inString = false;
        if (this.depth === 0) this.endValue(text, i + 1);
      }
      return false;
    }
    if (char === '"') this.inString = true;
    else if (char === '{' || char === '[') this.depth++;
    else if (char === '}' || char === ']') {
      this.depth--;
      if (this.depth === 0) this.endValue(text, i + 1);
    }
    return false;
  }

  /** Ends the raw value at `text[end]` (exclusive): parses a captured value, drops a skipped one. */
  private endValue(text: string, end: number): void {
    this.mode = 'next';
    const target = this.capture;
    if (!target) return;
    this.parts.push(text.slice(this.partStart, end));
    let value: unknown;
    try {
      value = JSON.parse(this.parts.join(''));
    } catch {
      this.fail();
      return;
    }
    this.parts = [];
    if (target === 'head') {
      if (isHead(value)) this.head = value;
      else this.fail();
    } else if (isRow(value)) {
      this.bindings.push(value);
      if (this.bindings.length > this.maxRows) this.state = 'full';
    } else {
      this.fail();
    }
  }
}
