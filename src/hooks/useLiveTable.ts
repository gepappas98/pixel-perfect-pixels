import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

/**
 * Loads the most recent rows from a table and keeps them live via Realtime.
 *
 * refresh() is intentionally exposed for write-then-read flows. Realtime is
 * asynchronous (and may be unavailable if a table is not in the publication),
 * so callers that just wrote a row can force an immediate authoritative read.
 */
export function useLiveTable<T>(table: string, limit = 20, orderBy = "created_at") {
  const [rows, setRows] = useState<T[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const { data, error: err } = await supabase
      .from(table as never)
      .select("*")
      .order(orderBy, { ascending: false })
      .limit(limit);

    if (err) {
      setError(err.message);
      return false;
    }

    setRows((data ?? []) as T[]);
    setError(null);
    return true;
  }, [table, limit, orderBy]);

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
        setRows((prev) => {
          const next = [payload.new as T, ...prev];
          const seen = new Set<string>();
          return next.filter((row) => {
            const id = String((row as { id?: string }).id ?? "");
            if (!id || seen.has(id)) return false;
            seen.add(id);
            return true;
          }).slice(0, limit);
        });
      })
      .on("postgres_changes", { event: "UPDATE", schema: "public", table }, (payload) => {
        setRows((prev) => prev.map((row) => (
          (row as { id?: string }).id === payload.new["id"] ? payload.new as T : row
        )));
      })
      .subscribe();

    return () => {
      active = false;
      supabase.removeChannel(channel);
    };
  }, [table, limit, orderBy]);

  return { rows, loading, error, refresh };
}
