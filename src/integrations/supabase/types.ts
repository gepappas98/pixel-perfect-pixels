export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      composite_signals: {
        Row: {
          confidence: number | null
          council_signal_id: string | null
          created_at: string
          fingerprint: string | null
          id: string
          indicator_snapshot_id: string | null
          pattern_key: string | null
          prediction_snapshot_id: string | null
          reasoning: string | null
          recommendation: string | null
          symbol: string
          whale_alert_id: string | null
        }
        Insert: {
          confidence?: number | null
          council_signal_id?: string | null
          created_at?: string
          fingerprint?: string | null
          id?: string
          indicator_snapshot_id?: string | null
          pattern_key?: string | null
          prediction_snapshot_id?: string | null
          reasoning?: string | null
          recommendation?: string | null
          symbol: string
          whale_alert_id?: string | null
        }
        Update: {
          confidence?: number | null
          council_signal_id?: string | null
          created_at?: string
          fingerprint?: string | null
          id?: string
          indicator_snapshot_id?: string | null
          pattern_key?: string | null
          prediction_snapshot_id?: string | null
          reasoning?: string | null
          recommendation?: string | null
          symbol?: string
          whale_alert_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "composite_signals_council_signal_id_fkey"
            columns: ["council_signal_id"]
            isOneToOne: false
            referencedRelation: "council_signals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "composite_signals_indicator_snapshot_id_fkey"
            columns: ["indicator_snapshot_id"]
            isOneToOne: false
            referencedRelation: "indicator_snapshots"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "composite_signals_prediction_snapshot_id_fkey"
            columns: ["prediction_snapshot_id"]
            isOneToOne: false
            referencedRelation: "prediction_snapshots"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "composite_signals_whale_alert_id_fkey"
            columns: ["whale_alert_id"]
            isOneToOne: false
            referencedRelation: "whale_alerts"
            referencedColumns: ["id"]
          },
        ]
      }
      council_lessons: {
        Row: {
          conviction: number | null
          created_at: string
          entry_context: Json | null
          id: string
          lesson: string
          outcome: string
          pnl_pct: number | null
          realized_pnl: number | null
          source_trade_id: string | null
          symbol: string
          verdict: string | null
        }
        Insert: {
          conviction?: number | null
          created_at?: string
          entry_context?: Json | null
          id?: string
          lesson: string
          outcome: string
          pnl_pct?: number | null
          realized_pnl?: number | null
          source_trade_id?: string | null
          symbol: string
          verdict?: string | null
        }
        Update: {
          conviction?: number | null
          created_at?: string
          entry_context?: Json | null
          id?: string
          lesson?: string
          outcome?: string
          pnl_pct?: number | null
          realized_pnl?: number | null
          source_trade_id?: string | null
          symbol?: string
          verdict?: string | null
        }
        Relationships: []
      }
      council_signals: {
        Row: {
          conviction: number | null
          depth: string | null
          final_verdict: string
          id: string
          price_at: number | null
          reflection: string | null
          source_created_at: string
          source_id: string
          symbol: string
          synced_at: string
          token_id: string | null
        }
        Insert: {
          conviction?: number | null
          depth?: string | null
          final_verdict: string
          id?: string
          price_at?: number | null
          reflection?: string | null
          source_created_at?: string
          source_id: string
          symbol: string
          synced_at?: string
          token_id?: string | null
        }
        Update: {
          conviction?: number | null
          depth?: string | null
          final_verdict?: string
          id?: string
          price_at?: number | null
          reflection?: string | null
          source_created_at?: string
          source_id?: string
          symbol?: string
          synced_at?: string
          token_id?: string | null
        }
        Relationships: []
      }
      indicator_snapshots: {
        Row: {
          bb_lower: number | null
          bb_upper: number | null
          created_at: string
          id: string
          macd: number | null
          macd_signal: number | null
          price: number | null
          raw: Json | null
          rsi: number | null
          signal: string | null
          symbol: string
          timeframe: string
        }
        Insert: {
          bb_lower?: number | null
          bb_upper?: number | null
          created_at?: string
          id?: string
          macd?: number | null
          macd_signal?: number | null
          price?: number | null
          raw?: Json | null
          rsi?: number | null
          signal?: string | null
          symbol: string
          timeframe: string
        }
        Update: {
          bb_lower?: number | null
          bb_upper?: number | null
          created_at?: string
          id?: string
          macd?: number | null
          macd_signal?: number | null
          price?: number | null
          raw?: Json | null
          rsi?: number | null
          signal?: string | null
          symbol?: string
          timeframe?: string
        }
        Relationships: []
      }
      pipeline_runs: {
        Row: {
          ai_error: string | null
          ai_lessons_generated: number | null
          ai_status: string | null
          completed_at: string | null
          council: number | null
          duration_ms: number | null
          error_message: string | null
          id: string
          indicators: number | null
          job_name: string | null
          mode: string | null
          predictions: number | null
          result: Json | null
          signals: number | null
          started_at: string
          status: string
          trades: number | null
          variants_resolved: number
          whales: number | null
        }
        Insert: {
          ai_error?: string | null
          ai_lessons_generated?: number | null
          ai_status?: string | null
          completed_at?: string | null
          council?: number | null
          duration_ms?: number | null
          error_message?: string | null
          id?: string
          indicators?: number | null
          job_name?: string | null
          mode?: string | null
          predictions?: number | null
          result?: Json | null
          signals?: number | null
          started_at?: string
          status?: string
          trades?: number | null
          variants_resolved?: number
          whales?: number | null
        }
        Update: {
          ai_error?: string | null
          ai_lessons_generated?: number | null
          ai_status?: string | null
          completed_at?: string | null
          council?: number | null
          duration_ms?: number | null
          error_message?: string | null
          id?: string
          indicators?: number | null
          job_name?: string | null
          mode?: string | null
          predictions?: number | null
          result?: Json | null
          signals?: number | null
          started_at?: string
          status?: string
          trades?: number | null
          variants_resolved?: number
          whales?: number | null
        }
        Relationships: []
      }
      pipeline_settings: {
        Row: {
          id: number
          interval_minutes: number
          updated_at: string
        }
        Insert: {
          id?: number
          interval_minutes?: number
          updated_at?: string
        }
        Update: {
          id?: number
          interval_minutes?: number
          updated_at?: string
        }
        Relationships: []
      }
      prediction_snapshots: {
        Row: {
          created_at: string
          id: string
          market_slug: string
          no_price: number | null
          question: string | null
          raw: Json | null
          related_symbol: string | null
          updated_at: string
          volume_24h: number | null
          yes_price: number | null
        }
        Insert: {
          created_at?: string
          id?: string
          market_slug: string
          no_price?: number | null
          question?: string | null
          raw?: Json | null
          related_symbol?: string | null
          updated_at?: string
          volume_24h?: number | null
          yes_price?: number | null
        }
        Update: {
          created_at?: string
          id?: string
          market_slug?: string
          no_price?: number | null
          question?: string | null
          raw?: Json | null
          related_symbol?: string | null
          updated_at?: string
          volume_24h?: number | null
          yes_price?: number | null
        }
        Relationships: []
      }
      signal_pattern_stats: {
        Row: {
          avg_pnl_pct: number | null
          pattern_key: string
          sample_size: number
          updated_at: string
          win_rate: number | null
          wins: number
        }
        Insert: {
          avg_pnl_pct?: number | null
          pattern_key: string
          sample_size?: number
          updated_at?: string
          win_rate?: number | null
          wins?: number
        }
        Update: {
          avg_pnl_pct?: number | null
          pattern_key?: string
          sample_size?: number
          updated_at?: string
          win_rate?: number | null
          wins?: number
        }
        Relationships: []
      }
      strategy_config: {
        Row: {
          auto_switch_enabled: boolean
          auto_switch_interval_hours: number
          council_weight: number
          id: number
          last_auto_reasoning: string | null
          last_auto_switch_at: string | null
          prediction_weight: number
          preset_name: string
          technicals_weight: number
          updated_at: string
          whale_weight: number
        }
        Insert: {
          auto_switch_enabled?: boolean
          auto_switch_interval_hours?: number
          council_weight?: number
          id?: number
          last_auto_reasoning?: string | null
          last_auto_switch_at?: string | null
          prediction_weight?: number
          preset_name?: string
          technicals_weight?: number
          updated_at?: string
          whale_weight?: number
        }
        Update: {
          auto_switch_enabled?: boolean
          auto_switch_interval_hours?: number
          council_weight?: number
          id?: number
          last_auto_reasoning?: string | null
          last_auto_switch_at?: string | null
          prediction_weight?: number
          preset_name?: string
          technicals_weight?: number
          updated_at?: string
          whale_weight?: number
        }
        Relationships: []
      }
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
      trade_alerts: {
        Row: {
          created_at: string
          entry_price: number
          event_type: string
          exit_price: number
          id: string
          pnl: number
          pnl_pct: number
          side: string
          symbol: string
          trade_id: string
        }
        Insert: {
          created_at?: string
          entry_price: number
          event_type: string
          exit_price: number
          id?: string
          pnl: number
          pnl_pct: number
          side: string
          symbol: string
          trade_id: string
        }
        Update: {
          created_at?: string
          entry_price?: number
          event_type?: string
          exit_price?: number
          id?: string
          pnl?: number
          pnl_pct?: number
          side?: string
          symbol?: string
          trade_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "trade_alerts_trade_id_fkey"
            columns: ["trade_id"]
            isOneToOne: false
            referencedRelation: "trades"
            referencedColumns: ["id"]
          },
        ]
      }
      trades: {
        Row: {
          close_reason: string | null
          closed_at: string | null
          composite_signal_id: string | null
          created_at: string
          entry_fee: number | null
          entry_price: number
          exchange_order_id: string | null
          exit_fee: number | null
          exit_price: number | null
          gross_pnl: number | null
          id: string
          mode: string
          net_pnl: number | null
          pnl: number | null
          post_mortem_generated: boolean | null
          quantity: number
          side: string
          status: string
          stop_loss: number | null
          symbol: string
          take_profit: number | null
          total_fees: number | null
        }
        Insert: {
          close_reason?: string | null
          closed_at?: string | null
          composite_signal_id?: string | null
          created_at?: string
          entry_fee?: number | null
          entry_price: number
          exchange_order_id?: string | null
          exit_fee?: number | null
          exit_price?: number | null
          gross_pnl?: number | null
          id?: string
          mode?: string
          net_pnl?: number | null
          pnl?: number | null
          post_mortem_generated?: boolean | null
          quantity: number
          side: string
          status?: string
          stop_loss?: number | null
          symbol: string
          take_profit?: number | null
          total_fees?: number | null
        }
        Update: {
          close_reason?: string | null
          closed_at?: string | null
          composite_signal_id?: string | null
          created_at?: string
          entry_fee?: number | null
          entry_price?: number
          exchange_order_id?: string | null
          exit_fee?: number | null
          exit_price?: number | null
          gross_pnl?: number | null
          id?: string
          mode?: string
          net_pnl?: number | null
          pnl?: number | null
          post_mortem_generated?: boolean | null
          quantity?: number
          side?: string
          status?: string
          stop_loss?: number | null
          symbol?: string
          take_profit?: number | null
          total_fees?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "trades_composite_signal_id_fkey"
            columns: ["composite_signal_id"]
            isOneToOne: false
            referencedRelation: "composite_signals"
            referencedColumns: ["id"]
          },
        ]
      }
      whale_alerts: {
        Row: {
          chain: string | null
          created_at: string
          direction: string
          id: string
          raw: Json | null
          source: string
          symbol: string
          tx_hash: string | null
          usd_value: number
          wallet_address: string | null
        }
        Insert: {
          chain?: string | null
          created_at?: string
          direction: string
          id?: string
          raw?: Json | null
          source?: string
          symbol: string
          tx_hash?: string | null
          usd_value: number
          wallet_address?: string | null
        }
        Update: {
          chain?: string | null
          created_at?: string
          direction?: string
          id?: string
          raw?: Json | null
          source?: string
          symbol?: string
          tx_hash?: string | null
          usd_value?: number
          wallet_address?: string | null
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      cleanup_old_pipeline_data: {
        Args: never
        Returns: {
          deleted_composite_signals: number
          deleted_council_signals: number
          deleted_indicator_snapshots: number
          deleted_pipeline_runs: number
          deleted_prediction_snapshots: number
          deleted_trade_alerts: number
          deleted_variant_signals: number
          deleted_whale_alerts: number
        }[]
      }
      get_pipeline_cron_health: { Args: never; Returns: Json }
      get_portfolio_summary: {
        Args: never
        Returns: {
          avg_loss_usd: number
          avg_win_usd: number
          closed_count: number
          gross_loss: number
          gross_profit: number
          last_24h_closed: number
          last_24h_pnl: number
          loss_count: number
          open_count: number
          open_notional: number
          profit_factor: number
          realized_pnl: number
          win_count: number
          win_rate_pct: number
        }[]
      }
      reconcile_stuck_pipeline_runs: { Args: never; Returns: number }
      refresh_pattern_stats: { Args: never; Returns: number }
      set_pipeline_schedule: { Args: { _minutes: number }; Returns: number }
      trading_fee_rate: { Args: never; Returns: number }
      verify_cron_secret: { Args: { _secret: string }; Returns: boolean }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
