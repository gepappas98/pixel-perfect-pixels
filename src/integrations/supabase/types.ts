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
      prediction_snapshots: {
        Row: {
          created_at: string
          id: string
          market_slug: string
          no_price: number | null
          question: string | null
          raw: Json | null
          related_symbol: string | null
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
          volume_24h?: number | null
          yes_price?: number | null
        }
        Relationships: []
      }
      trades: {
        Row: {
          closed_at: string | null
          composite_signal_id: string | null
          created_at: string
          entry_price: number
          exchange_order_id: string | null
          exit_price: number | null
          id: string
          mode: string
          pnl: number | null
          quantity: number
          side: string
          status: string
          stop_loss: number | null
          symbol: string
          take_profit: number | null
        }
        Insert: {
          closed_at?: string | null
          composite_signal_id?: string | null
          created_at?: string
          entry_price: number
          exchange_order_id?: string | null
          exit_price?: number | null
          id?: string
          mode?: string
          pnl?: number | null
          quantity: number
          side: string
          status?: string
          stop_loss?: number | null
          symbol: string
          take_profit?: number | null
        }
        Update: {
          closed_at?: string | null
          composite_signal_id?: string | null
          created_at?: string
          entry_price?: number
          exchange_order_id?: string | null
          exit_price?: number | null
          id?: string
          mode?: string
          pnl?: number | null
          quantity?: number
          side?: string
          status?: string
          stop_loss?: number | null
          symbol?: string
          take_profit?: number | null
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
      [_ in never]: never
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
