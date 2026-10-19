export type Position = Readonly<{ line: number; character: number }>;
export type Range = Readonly<{ start: Position; end: Position }>;
export type SourceLocation = Readonly<{ uri: string; range: Range; documentVersion?: number }>;
export type Symbol = Readonly<{ id: string; name: string; kind: number; location: SourceLocation; extent: Range; detail: string; unresolved: boolean }>;
export type Direction = 'incoming' | 'outgoing';
export type CallEdge = Readonly<{ symbol: Symbol; sites: readonly SourceLocation[] }>;
export type ProviderId = 'local' | 'languageService' | 'none';
export type QueryStatus = 'ready' | 'empty' | 'building' | 'excluded' | 'notIndexed' | 'unsupported' | 'notFound' | 'ambiguous' | 'timeout' | 'cooldown' | 'cancelled' | 'error';
export type QueryResult<T> = Readonly<{ data: readonly T[]; status: QueryStatus; provider: ProviderId; revision: string; diagnostics: readonly string[] }>;
export type ViewStatus = 'idle' | 'loading' | 'refreshing' | 'ready' | 'empty' | 'failed' | 'retained' | 'stale';
export type QueryState<T> = Readonly<{ status: ViewStatus; data: readonly T[]; result?: QueryResult<T>; requestId: number; revision: string }>;
export interface RelationProvider {
  readonly id: ProviderId;
  revision(): string;
  supports(uri: string): boolean;
  describe(uri: string): { state: QueryStatus; note: string };
  prepare(source: SourceLocation & { name?: string }): Promise<QueryResult<Symbol>>;
  calls(symbol: Symbol, direction: Direction): Promise<QueryResult<CallEdge>>;
  invalidate(): void;
}
