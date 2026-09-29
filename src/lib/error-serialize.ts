/**
 * Robust error serialization για logging.
 * Πιάνει Error instances, Supabase-style errors, plain objects, circular refs.
 */
export function serializeError(e: unknown): string {
  if (e == null) return "unknown error";
  if (typeof e === "string") return e;

  if (e instanceof Error) {
    const parts = [e.message || e.name || "Error"];
    if (e.stack) {
      const firstFrame = e.stack.split("\n")[1]?.trim();
      if (firstFrame) parts.push(`at ${firstFrame}`);
    }
    const withCode = e as Error & {
      code?: unknown;
      details?: unknown;
      hint?: unknown;
    };
    if (typeof withCode.code === "string") parts.push(`code=${withCode.code}`);
    if (typeof withCode.details === "string")
      parts.push(`details=${withCode.details}`);
    if (typeof withCode.hint === "string") parts.push(`hint=${withCode.hint}`);
    return parts.join(" | ");
  }

  if (typeof e === "object") {
    const obj = e as Record<string, unknown>;

    // Supabase PostgrestError / similar
    if (typeof obj["message"] === "string" && obj["message"].length > 0) {
      const extras: string[] = [];
      if (typeof obj["code"] === "string") extras.push(`code=${obj["code"]}`);
      if (typeof obj["details"] === "string") extras.push(`details=${obj["details"]}`);
      if (typeof obj["hint"] === "string") extras.push(`hint=${obj["hint"]}`);
      return extras.length > 0
        ? `${obj["message"]} | ${extras.join(" | ")}`
        : obj["message"];
    }

    if (typeof obj["error"] === "string") return obj["error"];
    if (typeof obj["error"] === "object" && obj["error"] !== null) {
      return serializeError(obj["error"]);
    }

    try {
      const seen = new WeakSet();
      const json = JSON.stringify(
        obj,
        (_k, v) => {
          if (typeof v === "object" && v !== null) {
            if (seen.has(v)) return "[Circular]";
            seen.add(v);
          }
          return v;
        },
        2,
      );
      return json.slice(0, 1000);
    } catch {
      return "[unserializable object]";
    }
  }

  return String(e);
}
