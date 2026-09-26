export function formatPrice(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(Number(value))) return "—";
  const v = Number(value);
  const abs = Math.abs(v);
  let digits: number;
  if (abs === 0) digits = 2;
  else if (abs >= 100) digits = 2;
  else if (abs >= 1) digits = 4;
  else if (abs >= 0.01) digits = 4;
  else digits = 8;
  return v.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}
