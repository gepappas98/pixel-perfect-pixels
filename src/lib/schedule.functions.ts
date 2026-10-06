import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

export const getSchedule = createServerFn({ method: "GET" }).handler(async () => {
  // Read schedule from the canonical client; this prevents legacy Lovable
  // server-side Supabase secrets from reporting the retired schedule.
  const { supabase } = await import("@/integrations/supabase/client");
  const { data } = await (supabase.from as any)("pipeline_settings")
    .select("interval_minutes")
    .eq("id", 1)
    .maybeSingle();
  return { minutes: (data?.interval_minutes as number) ?? 0 };
});

export const setSchedule = createServerFn({ method: "POST" })
  .validator((d) => z.object({ minutes: z.union([z.literal(0), z.literal(2), z.literal(5), z.literal(10)]) }).parse(d))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await (supabaseAdmin.rpc as any)("set_pipeline_schedule", { _minutes: data.minutes });
    if (error) throw new Error(error.message);
    return { minutes: data.minutes };
  });
