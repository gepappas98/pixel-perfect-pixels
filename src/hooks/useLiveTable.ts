import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

/**
 * Loads the most recent rows from a table and keeps them live via Realtime.
 */
export function useLiveTable<T>(table: string, limit = 20, orderBy = "created_at") {
  const [rows, setRows] = useState<T[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    (async () => {
      const { data, error: err } = await supabase
        .from(table as never)
        .select("*")
        .order(orderBy, { ascending: false })
        .limit(limit);
      if (!active) return;
      if (err) setError(err.message);
      else setRows((data ?? []) as T[]);
      setLoading(false);
    })();

    const channel = supabase
      .channel(`realtime:${table}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table }, (payload) => {
        setRows((prev) => [payload.new as T, ...prev].slice(0, limit));
      })
      .subscribe();

    return () => {
      active = false;
      supabase.removeChannel(channel);
    };
  }, [table, limit, orderBy]);

  return { rows, loading, error };
}
