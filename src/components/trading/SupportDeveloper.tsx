"use client";

import { useState } from "react";
import { Copy, Check } from "lucide-react";

const BTC_ADDRESS = "bc1q0d0ccaxuw065ezdulr68azp2fjhc0avaqf0pyz";

export function SupportDeveloper() {
  const [copied, setCopied] = useState(false);

  async function copyAddress() {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(BTC_ADDRESS);
      } else {
        const ta = document.createElement("textarea");
        ta.value = BTC_ADDRESS;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      console.error("Copy failed:", e);
    }
  }

  return (
    <div className="rounded-md border border-accent/30 bg-accent/5 p-3">
      <div className="flex items-start gap-3">
        <span className="text-2xl leading-none">☕</span>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold text-accent">
            Found Trading Command Center useful?
          </p>
          <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
            If this tool helped your trading or development workflow, consider
            tipping the developer. Every sat counts. 🙏
          </p>

          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            <code className="break-all rounded-md border border-border bg-background/50 px-2 py-1 font-mono text-[10px] text-foreground/90">
              {BTC_ADDRESS}
            </code>
            <button
              onClick={copyAddress}
              className={`flex shrink-0 items-center gap-1 rounded-md border px-2 py-1 text-[10px] font-semibold transition ${
                copied
                  ? "border-bull/40 bg-bull/10 text-bull"
                  : "border-accent/40 bg-accent/10 text-accent hover:bg-accent/20"
              }`}
              aria-label="Copy BTC address"
            >
              {copied ? (
                <>
                  <Check className="h-3 w-3" />
                  Copied!
                </>
              ) : (
                <>
                  <Copy className="h-3 w-3" />
                  Copy
                </>
              )}
            </button>
          </div>

          <p className="mt-1.5 text-[9px] text-muted-foreground">
            ⚠️ Bitcoin (BTC) on-chain only — do not send other coins to this
            address.
          </p>
        </div>
      </div>
    </div>
  );
}

export default SupportDeveloper;
