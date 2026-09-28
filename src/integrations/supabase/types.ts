strategy_variant_signals: {
  Row: {
    confidence: number | null
    created_at: string
    entry_price: number | null
    exit_price: number | null
    id: string
    outcome: string | null
    pnl_pct: number | null
    reasoning: string | null
    recommendation: string | null
    resolved_at: string | null
    score: number | null
    strategy_name: string
    symbol: string
  }
  Insert: {
    confidence?: number | null
    created_at?: string
    entry_price?: number | null
    exit_price?: number | null
    id?: string
    outcome?: string | null
    pnl_pct?: number | null
    reasoning?: string | null
    recommendation?: string | null
    resolved_at?: string | null
    score?: number | null
    strategy_name: string
    symbol: string
  }
  Update: {
    confidence?: number | null
    created_at?: string
    entry_price?: number | null
    exit_price?: number | null
    id?: string
    outcome?: string | null
    pnl_pct?: number | null
    reasoning?: string | null
    recommendation?: string | null
    resolved_at?: string | null
    score?: number | null
    strategy_name?: string
    symbol?: string
  }
  Relationships: []
}
