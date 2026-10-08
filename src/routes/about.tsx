import { createFileRoute, Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { SupportDeveloper } from "@/components/trading/SupportDeveloper";

export const Route = createFileRoute("/about")({
  head: () => ({
    meta: [
      { title: "About — Research Lab" },
      {
        name: "description",
        content:
          "A complete guide to the Research Lab: what it does, how it works, and the technology behind it. Written for both newcomers and experienced traders.",
      },
    ],
  }),
  component: AboutPage,
});

/* ───────────── Reusable UI pieces ───────────── */

function ProNote({ children }: { children: ReactNode }) {
  return (
    <div className="mt-3 rounded-md border border-accent/30 bg-accent/5 p-3">
      <div className="mb-2 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-widest text-accent">
        🔬 For the pros
      </div>
      <div className="space-y-1.5 font-mono text-[11px] leading-relaxed text-foreground/85">
        {children}
      </div>
    </div>
  );
}

function Section({
  emoji,
  title,
  subtitle,
  children,
}: {
  emoji: string;
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  return (
    <section className="panel">
      <div className="mb-3 flex items-start gap-3">
        <span className="text-2xl leading-none">{emoji}</span>
        <div>
          <h2 className="panel-title">{title}</h2>
          {subtitle && (
            <p className="mt-0.5 text-[10px] uppercase tracking-widest text-muted-foreground">
              {subtitle}
            </p>
          )}
        </div>
      </div>
      <div className="space-y-3 text-sm leading-relaxed text-foreground/90">
        {children}
      </div>
    </section>
  );
}

type TagKind = "core" | "advanced" | "pro";

function FeatureCard({
  emoji,
  name,
  tag,
  children,
}: {
  emoji: string;
  name: string;
  tag?: TagKind;
  children: ReactNode;
}) {
  const tagTone =
    tag === "pro"
      ? "border-accent/40 bg-accent/10 text-accent"
      : tag === "advanced"
        ? "border-bull/40 bg-bull/10 text-bull"
        : "border-border bg-muted text-muted-foreground";
  return (
    <div className="rounded-md border border-border/70 bg-background/30 p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-lg leading-none">{emoji}</span>
          <span className="font-mono text-xs font-semibold uppercase tracking-wider text-accent">
            {name}
          </span>
        </div>
        {tag && (
          <span
            className={`shrink-0 rounded border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider ${tagTone}`}
          >
            {tag}
          </span>
        )}
      </div>
      <div className="mt-2 text-xs leading-relaxed text-muted-foreground">
        {children}
      </div>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-md border border-border/70 bg-background/30 p-2.5">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div className="mt-0.5 font-mono text-base font-semibold text-foreground">
        {value}
      </div>
      {hint && (
        <div className="mt-0.5 text-[9px] text-muted-foreground">{hint}</div>
      )}
    </div>
  );
}

/* ───────────── The page ───────────── */

function AboutPage() {
  return (
    <div className="min-h-screen">
      <header className="border-b border-border px-5 py-4 sm:px-8">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="font-mono text-base font-semibold tracking-tight">
              About this tool
            </h1>
            <p className="mt-0.5 text-xs text-muted-foreground">
              A guide for everyone — from total beginners to professional traders.
            </p>
          </div>
          <Link
            to="/"
            className="rounded-md border border-border bg-muted px-3 py-1.5 text-xs font-semibold text-foreground transition hover:bg-muted/80"
          >
            ← Back to dashboard
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-3xl space-y-6 p-5 sm:p-8">
        {/* ── Intro ── */}
        <Section
          emoji="🤖"
          title="What is this?"
          subtitle="One sentence, then the long version"
        >
          <p className="rounded-md border border-accent/30 bg-accent/5 p-3 text-foreground">
            <strong>One sentence:</strong> A fully-autonomous crypto trading bot
            that watches whales, reads charts, consults AI, learns from its
            mistakes, and manages risk — all in one screen.
          </p>
          <p>
            Imagine you have a <strong>super-smart robot</strong> that watches the
            crypto market 24/7. It never sleeps, never gets tired, never forgets.
            Every few minutes it wakes up, gathers 4 different kinds of evidence,
            votes on what to do, opens or closes trades, and writes down what it
            learned.
          </p>
          <p>
            The universe of coins it watches is <strong>not fixed</strong>. Every
            6 hours it re-asks the market: <em>Which coins actually have real
            volume right now?</em> — and rebuilds its watchlist from the answer.
            No dead coins, no manual maintenance, no missed opportunities.
          </p>
          <p>
            This page is the robot's <strong>control room</strong>. It shows you
            everything the robot sees, thinks, and decides — in real time.
          </p>
          <ProNote>
            <p>
              <strong>Architecture:</strong> serverless pipeline on Supabase +
              TanStack Start. React frontend, PostgreSQL with row-level security,
              external APIs: Binance (spot), Hyperliquid (perps), Polymarket
              (prediction markets), Groq (LLM inference).
            </p>
            <p>
              <strong>Execution model:</strong> stateless functions orchestrated
              in a single pipeline run. Atomic mutex on the runs table prevents
              concurrent execution. Partial unique indexes enforce integrity
              constraints at the DB level.
            </p>
          </ProNote>
        </Section>

        {/* ── The 4 jobs ── */}
        <Section
          emoji="🎯"
          title="What the robot does"
          subtitle="4 evidence sources to 1 decision"
        >
          <p>
            Every cycle, the robot gathers <strong>four kinds of evidence</strong>.
            Think of it like a courtroom: four independent witnesses testify, and
            then the judge (the robot) decides.
          </p>

          <div className="mt-4 space-y-3">
            <FeatureCard emoji="🐋" name="1. Whale Tracking" tag="core">
              <p>
                Whales are traders with <strong>serious money</strong>. When
                they buy or sell big amounts, prices move. The robot watches both
                Binance (spot market) and Hyperliquid (perpetual futures) for
                large trades. When it detects accumulation (buying) or
                distribution (selling), that's evidence.
              </p>
              <ProNote>
                <p>
                  <strong>Sources:</strong> Hyperliquid{" "}
                  <code>recentTrades</code> per coin + Binance{" "}
                  <code>aggTrades</code> per pair + CoinLobster (BingX, OKX,
                  Bybit, Coinbase, DEX).
                </p>
                <p>
                  <strong>Thresholds (per-market):</strong> BTC/ETH/BNB $50k,
                  SOL/XRP/ADA/DOGE $25k, mid-caps $5k–15k, memecoins $3k.
                  Hyperliquid floors are 2x Binance floors.
                </p>
                <p>
                  <strong>Direction logic:</strong> for single-trade signals,
                  accumulation if buy-USD &gt; sell-USD x 1.15. For hot-queue
                  symbols, direction comes from <em>aggregated buy_ratio</em>{" "}
                  across multiple trades (requires at least 3 samples).
                </p>
              </ProNote>
            </FeatureCard>

            <FeatureCard emoji="📈" name="2. Technical Analysis" tag="core">
              <p>
                The robot reads the <strong>price history</strong> of every coin
                across <strong>three timeframes</strong> (4h, 1h, 1d). It
                calculates classic indicators: RSI (is the coin overbought or
                oversold?), MACD (is momentum shifting?), Bollinger Bands (is
                the price unusually stretched?), Aroon (trend strength),
                VWAP (fair-value), and Smart Money Concepts (order blocks,
                BOS/ChoCh, FVG, liquidity sweeps).
              </p>
              <p>
                Then it classifies each coin as <strong>bullish</strong>,{" "}
                <strong>bearish</strong>, or <strong>neutral</strong> — and
                combines the three timeframes into a single multi-timeframe
                score.
              </p>
              <ProNote>
                <p>
                  <strong>Indicators:</strong> RSI (14), MACD (12, 26, 9),
                  Bollinger Bands (20, 2 sigma), Aroon (25), VWAP (24h), ATR
                  (14), SMC detector.
                </p>
                <p>
                  <strong>Strict neutral band:</strong> RSI 44–56 stays{" "}
                  <em>neutral</em> unless MACD momentum exceeds 5% of |MACD|.
                  This eliminated the false-bullish bias from earlier versions.
                </p>
                <p>
                  <strong>Multi-timeframe score:</strong> base +1.0 for
                  primary (4h), x1.3 if fast (1h) agrees, x0.7 if it opposes.
                  Same for trend (1d). Max +1.69 when all three align.
                </p>
                <p>
                  <strong>Data:</strong> 100 candles per timeframe. Freshness
                  gate: 6h max age.
                </p>
              </ProNote>
            </FeatureCard>

            <FeatureCard emoji="🗳️" name="3. Prediction Markets" tag="core">
              <p>
                There are websites where people <strong>bet real money</strong> on
                future events — like Will Bitcoin reach $130,000 by 2026?. The
                robot reads these markets (from <strong>Polymarket</strong>) and
                uses them as another opinion.
              </p>
              <p>
                <strong>Important nuance:</strong> Yes doesn't always mean
                bullish. If a market asks Will Bitcoin <em>dip</em> to $65k?,
                a 19% yes probability is actually <strong>bullish</strong>{" "}
                (because most traders think it won't fall that far). The robot
                parses the <em>wording</em> to figure out the correct direction.
              </p>
              <p>
                It also scales the influence based on <strong>conviction</strong>:
                a market at 93% yes carries more weight than one at 55%.
              </p>
              <ProNote>
                <p>
                  <strong>Source:</strong> Polymarket Gamma API,{" "}
                  <code>tag_slug=crypto</code>, limit 200 events per cycle.
                </p>
                <p>
                  <strong>Magnitude scaling:</strong>{" "}
                  <code>mag = (|up - 0.5| x 2 - 0.2) / 0.8</code>, bounded
                  [0, 1]. Neutral band 40–60% contributes 0.
                </p>
                <p>
                  <strong>Direction parser:</strong> regex on question text.
                  Bullish keywords: reach, hit, above, surpass, ATH. Bearish:
                  dip, drop, below, crash.
                </p>
                <p>
                  <strong>Freshness gate:</strong> 30 minutes.
                </p>
              </ProNote>
            </FeatureCard>

            <FeatureCard emoji="🧠" name="4. AI Council (Groq)" tag="pro">
              <p>
                Finally, the robot asks a <strong>super-smart AI</strong> (via
                Groq, running OpenAI's GPT-OSS-20B) to look at everything
                together. The AI acts like a <strong>confirmation layer</strong> —
                it weighs all the evidence and votes: BUY, SELL, HOLD, or AVOID.
              </p>
              <p>
                <strong>Adaptive scheduling:</strong> how often the AI is
                consulted depends on the market regime. In trending markets it
                refreshes every 15 minutes; in calm markets every 40. This keeps
                costs low without sacrificing responsiveness when it matters.
              </p>
              <ProNote>
                <p>
                  <strong>Model:</strong> <code>openai/gpt-oss-20b</code> via
                  Groq's OpenAI-compatible endpoint. Temperature 0.2, 15s
                  timeout, <code>max_completion_tokens: 4096</code> (fixed from
                  an earlier 800-token overflow that caused empty responses).
                </p>
                <p>
                  <strong>Regime-aware cadence:</strong> 15 min trending, 25
                  min default, 40 min calm. Council verdict TTL: 20 / 30 / 45
                  min respectively.
                </p>
                <p>
                  <strong>Batching:</strong> up to 15 candidates per request,
                  sorted by whale USD. Deterministic fallback always active —
                  if Groq is down, rule-based council takes over.
                </p>
              </ProNote>
            </FeatureCard>
          </div>
        </Section>

        {/* ── Dynamic universe ── */}
        <Section
          emoji="🌐"
          title="Dynamic universe (what to watch)"
          subtitle="The watchlist rebuilds itself every 6 hours"
        >
          <p>
            Traditional trading bots have a <strong>fixed list</strong> of coins.
            That list goes stale: new coins get listed and are missed, dead
            coins waste resources, and no one notices until weeks later.
          </p>
          <p>
            This robot does something different. Every <strong>6 hours</strong>{" "}
            it asks Hyperliquid (a major derivatives exchange) for the total
            24-hour trading volume of every coin it supports (~250 coins). Then
            it:
          </p>
          <ul className="ml-5 list-disc space-y-1.5">
            <li>
              <strong>Keeps</strong> coins above <strong>$5 million</strong>{" "}
              daily volume.
            </li>
            <li>
              <strong>Drops</strong> coins that fall below{" "}
              <strong>$3 million</strong>. The gap between the two thresholds
              (called a <em>hysteresis band</em>) prevents coins from
              flip-flopping in and out on small volume swings.
            </li>
            <li>
              <strong>Verifies</strong> each coin is actually tradable on
              Binance, so we can pull real price history for it.
            </li>
            <li>
              <strong>Pins</strong> certain coins that must always be watched:
              BTC, ETH, SOL (market benchmarks), plus any coin with an open
              trade (so we never lose track of live positions).
            </li>
            <li>
              <strong>Caps</strong> the final list at <strong>150 coins</strong>{" "}
              to keep the pipeline predictable and fast.
            </li>
          </ul>
          <ProNote>
            <p>
              <strong>Source of truth:</strong>{" "}
              <code>POST api.hyperliquid.xyz/info</code> with{" "}
              <code>type: "metaAndAssetCtxs"</code> — 1 call returns all coins
              with <code>dayNtlVlm</code> (24h notional USD).
            </p>
            <p>
              <strong>Hysteresis:</strong> add if at least $5M, remove if
              below $3M. Reduces churn by ~80% empirically.
            </p>
            <p>
              <strong>Snapshot stability:</strong> resolved watchlists are
              persisted in <code>dynamic_watchlist_snapshots</code> with a 6h
              TTL. Each cycle either reads the cached snapshot or refreshes it.
            </p>
            <p>
              <strong>Fallback:</strong> if Hyperliquid or Binance is
              unreachable, the robot uses a static 50-coin core list so it
              never crashes.
            </p>
          </ProNote>
        </Section>

        {/* ── Hot whale queue ── */}
        <Section
          emoji="⚡"
          title="Hot Whale Queue (intra-cycle discovery)"
          subtitle="Why 6 hours is too slow — and how we fixed it"
        >
          <p>
            The dynamic universe refreshes every <strong>6 hours</strong>. But
            crypto moves faster than that. A coin can spike in volume at 13:00,
            attract significant whale flow, and be completely quiet by 14:00.
            With a 6-hour refresh, we would miss it entirely.
          </p>
          <p>
            The <strong>Hot Whale Queue</strong> solves this. Whenever the robot
            detects whale activity (at least $25K) on a coin that is{" "}
            <em>not</em> currently in the watchlist, it adds that coin to a{" "}
            <strong>temporary hot list</strong>. That list is consulted on the
            very next cycle — no waiting for the 6-hour refresh.
          </p>
          <p>Hot entries expire quickly:</p>
          <ul className="ml-5 list-disc space-y-1.5">
            <li>
              A hot coin stays <strong>active for 30 minutes</strong> after its
              last whale alert.
            </li>
            <li>
              If no new whale activity arrives, it drops out of the hot list.
            </li>
            <li>
              A cleanup job removes stale entries after <strong>120 minutes</strong>.
            </li>
            <li>
              Maximum <strong>20 hot coins</strong> can be in the queue at once.
            </li>
          </ul>
          <p>
            There's also an <strong>aggregated directional signal</strong>: when
            a hot coin has multiple whale alerts, the robot calculates the{" "}
            <em>buy ratio</em> across all of them. A single $40K buy might be a
            hedge, a liquidation aftermath, or a market-maker rebalance — but
            a 70% buy ratio across 5 or more trades is real accumulation. Only{" "}
            <strong>3 or more samples</strong> with a strong skew produce a
            direction, and each direction comes with a{" "}
            <strong>confidence score</strong>.
          </p>
          <ProNote>
            <p>
              <strong>Storage:</strong> <code>hot_whale_signals</code> table
              (PK on symbol, rolling upsert on every observation). 30-min
              window, 120-min TTL, cleaned once per pipeline run.
            </p>
            <p>
              <strong>Direction rules:</strong> accumulation if{" "}
              <code>buy_ratio &gt;= 0.65</code> AND{" "}
              <code>alert_count &gt;= 3</code>. Symmetric for distribution.
              Otherwise null.
            </p>
            <p>
              <strong>Confidence formula:</strong>{" "}
              <code>0.7 x clarity + 0.3 x sample_factor</code>, where{" "}
              <code>clarity = |buy_ratio - 0.5| x 2</code> and{" "}
              <code>sample_factor = min(1, count / 10)</code>.
            </p>
            <p>
              <strong>Conviction boost:</strong> when a hot coin has at least
              $50K total and at least 70% confidence, the composite score
              receives an additive bonus (up to +0.30) in the direction of the
              whale flow.
            </p>
            <p>
              <strong>Dynamic thresholds:</strong> sparse hot coins (e.g.,
              perp-only contracts without candle data) get buy/sell thresholds
              lowered from ±1.5 to ±0.75 — but only when the whale aggregate
              already qualifies for a boost.
            </p>
          </ProNote>
        </Section>

        {/* ── Provenance tagging ── */}
        <Section
          emoji="🏷️"
          title="Provenance tagging"
          subtitle="Every action knows where it came from"
        >
          <p>
            Not all coins are equal. Some were in the original curated list,
            some came from public exchanges, some arrived as <em>hot</em>{" "}
            discoveries, and some are held because we already have an open
            position. The robot <strong>tags</strong> every alert, trade, and
            signal with its origin, so it can answer questions like:
          </p>
          <ul className="ml-5 list-disc space-y-1.5">
            <li>
              <em>Do hot-discovered coins perform better or worse than the
              original list?</em>
            </li>
            <li>
              <em>How often does an open-position pin save us from losing
              track of a trade?</em>
            </li>
            <li>
              <em>Is the dynamic watchlist actually adding value, or is the
              static core list just as good?</em>
            </li>
          </ul>
          <p>The current tags are:</p>
          <ul className="ml-5 list-disc space-y-1.5">
            <li>
              <strong>always-include</strong> — BTC, ETH, SOL (never dropped)
            </li>
            <li>
              <strong>open-position</strong> — has an active trade
            </li>
            <li>
              <strong>revolutx</strong> — manually curated
            </li>
            <li>
              <strong>hl-dynamic</strong> — auto-selected by Hyperliquid volume
            </li>
            <li>
              <strong>hot-whale</strong> — intra-cycle discovery
            </li>
            <li>
              <strong>core-fallback</strong> — cold-start safety list
            </li>
          </ul>
          <ProNote>
            <p>
              <strong>Storage:</strong> <code>tags[]</code> column on{" "}
              <code>trade_alerts</code>, and <code>source_tags[]</code> on{" "}
              <code>trades</code>, <code>composite_signals</code>, and{" "}
              <code>strategy_variant_signals</code>. All indexed with GIN for
              fast filtering.
            </p>
            <p>
              <strong>Query pattern:</strong>{" "}
              <code>WHERE source_tags @&gt; ARRAY['hot-whale']</code> —
              efficient containment queries.
            </p>
          </ProNote>
        </Section>

        {/* ── The learning system ── */}
        <Section
          emoji="📚"
          title="The learning system"
          subtitle="How the robot gets smarter over time"
        >
          <p>
            This is what makes the robot <strong>unusual</strong>. Every time a
            trade closes — whether it made money or lost money — the robot asks
            the AI to write a <strong>short lesson</strong>: What should I
            remember for the next time I see this coin?
          </p>

          <p>
            Then, before the next decision, it <strong>reads its own notes</strong>.
            It's like a student who keeps a notebook and reviews it before every
            exam.
          </p>

          <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
            <Stat label="Max lessons kept" value="5" hint="per symbol, most recent" />
            <Stat label="Post-mortems per cycle" value="5" hint="token budget cap" />
            <Stat label="Lesson model" value="Groq" hint="max 4096 tokens" />
          </div>

          <ProNote>
            <p>
              <strong>RAG pattern (Retrieval-Augmented Generation):</strong>{" "}
              lessons stored in <code>council_lessons</code> table, indexed by
              symbol. Fetched before each Groq batch, injected into the prompt
              as <code>past_lessons: ["[win] ...", "[loss] ..."]</code>.
            </p>
            <p>
              <strong>Post-mortem generation:</strong> after every close, Groq
              is asked for a single-sentence lesson. Temperature 0.3, max 4096
              tokens. Outcome derived from realized PnL: win / loss / breakeven.
            </p>
            <p>
              <strong>System prompt instruction:</strong> Weigh past_lessons as
              real experience: a lesson from a [loss] reduces confidence in
              repeating the same mistake; a [win] increases confidence in the
              same pattern.
            </p>
          </ProNote>
        </Section>

        {/* ── Risk management ── */}
        <Section
          emoji="🛡️"
          title="Risk management"
          subtitle="The rules that protect the portfolio"
        >
          <p>
            This is the most important part. A trading bot without risk
            management is <strong>gambling</strong>. This bot has strict rules:
          </p>

          <div className="mt-3 grid grid-cols-2 gap-2">
            <Stat label="Risk per trade" value="0.25%" hint="of equity, incl. fees" />
            <Stat label="Portfolio cap" value="2.0%" hint="total open risk" />
            <Stat label="Daily loss limit" value="2.0%" hint="hard stop for the day" />
            <Stat label="Max positions" value="8" hint="concurrent open trades" />
            <Stat label="Stop loss" value="-3%" hint="from entry price" />
            <Stat label="Take profit" value="+4%" hint="from entry price" />
          </div>

          <p className="mt-3">
            Every trade's quantity is calculated so that if the stop loss hits,
            the total loss (including fees) doesn't exceed{" "}
            <strong>0.25% of the current equity</strong>. This means the size
            of each trade <em>automatically shrinks or grows</em> based on how
            the account is doing.
          </p>

          <p>
            And the daily loss limit: if the portfolio has lost{" "}
            <strong>2% today</strong> (realized + unrealized), the robot{" "}
            <strong>stops opening new trades</strong> for the rest of the day
            (Athens timezone).
          </p>

          <p>
            <strong>Circuit breaker:</strong> if critical data feeds (whale
            activity or technical indicators) fail completely, the robot{" "}
            <strong>stops opening new trades entirely</strong> — it only closes
            existing positions until data flow resumes. It also logs a
            system-level alert.
          </p>

          <ProNote>
            <p>
              <strong>Position sizing formula:</strong> quantity ={" "}
              <code>maxTradeRisk / (|entry - stop| + (entry + stop) x fee_rate)</code>.
              Fee rate 0.05% per side (Binance taker).
            </p>
            <p>
              <strong>Portfolio risk:</strong> sum of{" "}
              <code>|entry - stop| x qty + fees</code> across all open trades.
              Gate rejects new trades if adding would exceed 2%.
            </p>
            <p>
              <strong>Dynamic settings:</strong> TP/SL/hold durations are now
              read from a config table with a 30s cache — no redeploy needed to
              adjust them.
            </p>
            <p>
              <strong>Circuit breaker:</strong> triggered when{" "}
              <code>indicators=0</code> or <code>whales=0</code> for a cycle.
              Pipeline status becomes <code>degraded</code> and a{" "}
              <code>feed_error</code> alert is written.
            </p>
          </ProNote>
        </Section>

        {/* ── Signal rotation ── */}
        <Section
          emoji="🔄"
          title="Signal rotation"
          subtitle="When a stronger opportunity appears"
        >
          <p>
            Normally, if all 8 slots are taken, new signals are ignored. But
            that means a <strong>77% confidence signal</strong> might get
            skipped because a <strong>62% trade</strong> is occupying a slot.
          </p>

          <p>
            So the robot does something clever: when the portfolio is full and
            a <strong>much stronger</strong> signal appears, it can close the{" "}
            <strong>weakest trade</strong> to make room. Only if <em>all</em>{" "}
            of these are true:
          </p>

          <ul className="ml-5 list-disc space-y-1.5">
            <li>New signal is <strong>at least 75%</strong> confidence</li>
            <li>
              It's <strong>at least 10 points stronger</strong> than the
              weakest open trade's original confidence
            </li>
            <li>
              The weakest trade is <strong>at least 30 min old</strong> (no
              flickering)
            </li>
            <li>
              The weakest trade has PnL <strong>at most +0.5%</strong> (never
              cut a winner)
            </li>
            <li>Only <strong>1 rotation per cycle</strong></li>
            <li>
              The rotated-out symbol goes on <strong>15 min cooldown</strong>
            </li>
          </ul>

          <ProNote>
            <p>
              <strong>Selection:</strong> rotate out the trade with the lowest
              PnL%, tie-broken by lowest original signal confidence.
            </p>
            <p>
              <strong>Close reason:</strong> <code>rotated_out</code>. Shows in
              Closed Positions with amber color. Tagged with source provenance.
            </p>
            <p>
              <strong>Risk re-check:</strong> after rotation,{" "}
              <code>canOpenTrade</code> is re-invoked. If still rejected (e.g.,
              daily loss limit already hit), the new trade doesn't open — the
              rotation is wasted but harmless.
            </p>
          </ProNote>
        </Section>

        {/* ── Time-based exits ── */}
        <Section
          emoji="⏱️"
          title="Time-based exits"
          subtitle="Guaranteed turnover, even in sideways markets"
        >
          <p>
            In a flat market, prices drift sideways for days. A normal bot would
            just sit there with the same trades open forever. Not this one.
          </p>

          <ul className="ml-5 list-disc space-y-1.5">
            <li>
              <strong>Stale exit</strong> — if a trade is{" "}
              <strong>at least 48 hours old</strong> and its PnL is within{" "}
              <strong>±1%</strong> (essentially flat), close it. No reason to
              keep capital tied up in nothing.
            </li>
            <li>
              <strong>Expired exit</strong> — if a trade is{" "}
              <strong>at least 7 days old</strong> regardless of PnL, close it.
              This is a hard cap: nothing stays open forever.
            </li>
          </ul>

          <p>
            This creates <strong>guaranteed turnover</strong>, which means more
            closed trades, which means more lessons learned, which means a
            smarter robot next month.
          </p>

          <ProNote>
            <p>
              <strong>Constants:</strong> read from{" "}
              <code>pipeline_settings.trading_settings</code> (30s cache).
              Defaults: <code>stale_exit_hours = 48</code>,{" "}
              <code>stale_exit_min_pnl_pct = 1.0</code>,{" "}
              <code>max_hold_hours = 168</code>.
            </p>
            <p>
              <strong>Check order:</strong> stop-loss, take-profit, expired,
              stale. First matching rule wins.
            </p>
          </ProNote>
        </Section>

        {/* ── Fees ── */}
        <Section
          emoji="💸"
          title="Trading fees"
          subtitle="Every number you see is net"
        >
          <p>
            Real trading costs money. Every trade here is charged a fee on the
            way in <em>and</em> on the way out, exactly like a real exchange
            would. So the profit and loss you see on screen is what you would
            actually keep — never an optimistic figure.
          </p>

          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
            <Stat label="Fee per side" value="0.05%" hint="entry and exit" />
            <Stat label="Round trip" value="0.10%" hint="total per trade" />
            <Stat label="Shown PnL" value="Net" hint="fees already deducted" />
          </div>

          <ProNote>
            <p>
              <strong>Single source of truth:</strong>{" "}
              <code>TRADING_FEE_RATE = 0.0005</code> in{" "}
              <code>src/lib/fees.ts</code>, mirrored by{" "}
              <code>public.trading_fee_rate()</code> in SQL. Change both together.
            </p>
            <p>
              <strong>Storage:</strong> <code>entry_fee</code> saved on open,
              actual fees plus gross and net PnL on close. The{" "}
              <code>pnl</code> column always holds <em>net</em> PnL.
            </p>
          </ProNote>
        </Section>

        {/* ── Strategy presets ── */}
        <Section
          emoji="🎛️"
          title="Strategy presets & weights"
          subtitle="Nine ways to look at the same market"
        >
          <p>
            The four evidence sources don't have to count equally. A{" "}
            <strong>preset</strong> decides how loud each one is. Prefer chart
            signals? Turn technicals up. Trust big-money flow? Turn whales up.
          </p>

          <ul className="ml-5 list-disc space-y-1.5">
            <li><strong>Balanced</strong> — all four sources weighted evenly.</li>
            <li><strong>Whale-Focused</strong> — large-money flow leads.</li>
            <li><strong>Chart Trader</strong> — technicals lead the decision.</li>
            <li><strong>Sentiment-First</strong> — prediction markets lead.</li>
            <li><strong>AI-Driven</strong> — the AI council gets the loudest vote.</li>
            <li><strong>Conservative</strong> — needs broad agreement before acting.</li>
            <li><strong>BB + Aroon Timing</strong> — volatility + trend confirmation.</li>
            <li><strong>VWAP + RSI Intraday</strong> — momentum within fair-value band.</li>
            <li><strong>SMC Pro (BOS + ChoCh)</strong> — market structure reversal signals.</li>
          </ul>

          <p>
            You can also drag the sliders yourself. Changed weights show an{" "}
            <strong>UNSAVED</strong> badge until you press Save — nothing takes
            effect before that.
          </p>

          <p>
            <strong>Auto-adaptive strategy:</strong> when enabled, the robot
            periodically reviews <em>which preset is actually winning</em> and
            can promote the top performer. If the current preset has a
            proven-losing record (below 40% win rate or negative PnL over 10 or
            more trades), it's automatically demoted.
          </p>

          <ProNote>
            <p>
              <strong>Presets:</strong> <code>src/lib/strategy.presets.ts</code>.
              Weights multiply the per-source score before thresholding.
            </p>
            <p>
              <strong>Deterministic fallback:</strong> if the AI-selection call
              fails, the robot picks the preset with the best{" "}
              <code>win_rate x total_pnl_pct</code> over the last 7 days
              (minimum 10 resolved trades). No stuck states.
            </p>
            <p>
              <strong>Auto-demote:</strong> current preset is force-replaced if
              it has at least 10 resolved trades AND (win rate below 40% OR
              total PnL below 0). Prevents the system from staying on a losing
              strategy.
            </p>
          </ProNote>
        </Section>

        {/* ── Shadow variants ── */}
        <Section
          emoji="🧪"
          title="Shadow testing (Variant Performance)"
          subtitle="All 9 presets compete, without risking anything"
        >
          <p>
            On every cycle, all nine presets are scored in parallel — not just
            the active one. The others still record what they <em>would</em>{" "}
            have traded. It's a permanent, honest contest running in the
            background.
          </p>

          <ul className="ml-5 list-disc space-y-1.5">
            <li>
              Each shadow trade assumes <strong>$1,000</strong>, take profit{" "}
              <strong>+4%</strong>, stop <strong>-3%</strong>.
            </li>
            <li>
              Unresolved after <strong>72 hours</strong> means closed at market
              as <em>expired</em>.
            </li>
            <li>
              Outcomes are checked against real <strong>1-hour candles</strong>{" "}
              — 4x more precise than the earlier 4-hour approach.
            </li>
            <li>
              Shadow results <strong>never</strong> touch the real paper
              portfolio.
            </li>
          </ul>

          <p>
            The Variant Performance panel then ranks the presets by win rate and
            hypothetical profit, so you can see which style is actually working
            in current conditions before you switch to it.
          </p>

          <ProNote>
            <p>
              <strong>Table:</strong> <code>strategy_variant_signals</code>{" "}
              (outcome: <code>open</code> / <code>win</code> / <code>loss</code>{" "}
              / <code>expired</code>). Resolver:{" "}
              <code>resolveVariantOutcomes()</code> using 1h candles with
              high/low touch detection.
            </p>
            <p>
              <strong>Why 1h candles:</strong> a single 4h candle can contain
              both a TP and SL touch. The resolution loop checks SL first, so
              a both-touched 4h bar was previously misrecorded as a loss.
              1h granularity eliminates this.
            </p>
            <p>
              <strong>Panel query:</strong> filters on resolved outcomes
              server-side — a plain recency query hits the 1,000-row API cap
              and returns only freshly-open rows.
            </p>
          </ProNote>
        </Section>

        {/* ── Automation ── */}
        <Section
          emoji="⏰"
          title="Automation & housekeeping"
          subtitle="What runs by itself"
        >
          <p>
            Nothing here needs you to be at the screen. A scheduler triggers the
            full cycle around the clock, a watchdog repairs anything that stalls,
            and a periodic cleanup keeps the data small and fast.
          </p>

          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
            <Stat label="Pipeline" value="2–10 min" hint="round the clock" />
            <Stat label="Watchdog" value="5 min" hint="clears stalled runs" />
            <Stat label="Cleanup" value="Weekly" hint="Monday 03:00 UTC" />
          </div>

          <p className="mt-3">
            The cleanup removes only data nobody reads any more. Things you care
            about are kept <strong>forever</strong>: every trade, every lesson,
            and every buy/sell signal.
          </p>

          <ul className="ml-5 list-disc space-y-1.5">
            <li>
              <strong>Kept forever</strong> — trades, council lessons, buy/sell
              signals, portfolio history.
            </li>
            <li>
              <strong>Removed after 7 days</strong> — whale alerts, watch/hold
              signals, shadow variant signals, indicator and prediction
              snapshots, run history.
            </li>
            <li>
              <strong>Removed after 30 days</strong> — trade alerts.
            </li>
          </ul>

          <ProNote>
            <p>
              <strong>Jobs:</strong> <code>trading-pipeline-auto</code>,{" "}
              <code>reconcile-stuck-pipeline-runs</code>,{" "}
              <code>refresh-pattern-stats</code>.
            </p>
            <p>
              <strong>Hot-queue cleanup:</strong> invoked once per pipeline run,
              removes hot-whale entries older than 120 minutes.
            </p>
            <p>
              <strong>Stall repair:</strong> runs left in <code>running</code>{" "}
              past the timeout are marked <code>error</code> or{" "}
              <code>degraded</code> so the{" "}
              <code>pipeline_runs_one_active</code> index stops blocking new
              runs.
            </p>
          </ProNote>
        </Section>

        {/* ── The panels ── */}
        <Section
          emoji="🖥️"
          title="The panels"
          subtitle="Every box on the dashboard, explained"
        >
          <div className="grid grid-cols-1 gap-2">
            <FeatureCard emoji="📣" name="Composite Signals" tag="core">
              The robot's <strong>final verdict</strong> per coin. Combines all
              4 evidence sources into a single recommendation:{" "}
              <em>buy</em> / <em>sell</em> / <em>hold</em> / <em>watch</em>,
              with a confidence percentage.
              <ProNote>
                <p>
                  <strong>Scoring:</strong> whale ±weight, technicals
                  ±1.69 x weight, prediction ±0.5 x magnitude x weight, AI
                  council ±0.75 x conviction x weight. Hot-whale boost: up to
                  +0.30 additive.
                </p>
                <p>
                  <strong>Thresholds:</strong> buy if score &gt;= 1.5, sell if
                  &lt;= -1.5, sparse hot-whale symbols use ±0.75, hold if
                  |score| &lt; 0.5.
                </p>
                <p>
                  <strong>Fingerprint:</strong> deterministic hash of all
                  inputs, excluding timestamps. Same inputs produce an upsert.
                </p>
              </ProNote>
            </FeatureCard>

            <FeatureCard emoji="🐋" name="Whale Flow" tag="core">
              Live feed of large-money trades detected in the last cycle.
              Green = accumulation, red = distribution. Includes both
              watchlist coins and hot-queue discoveries.
            </FeatureCard>

            <FeatureCard emoji="📊" name="Technicals (4h)" tag="core">
              All tracked coins, deduplicated per symbol. Shows RSI, current
              price, and the classification (bullish / bearish / neutral).
              Sorted with bullish first.
            </FeatureCard>

            <FeatureCard emoji="🔮" name="Prediction Markets" tag="core">
              Top markets per symbol, ranked by 24h volume. Yes probability
              displayed as a progress bar. Volume shown for reliability
              context. Markets with less than $500 volume or more than 95% odds
              are filtered out.
            </FeatureCard>

            <FeatureCard emoji="🧠" name="AI Council" tag="pro">
              Real-time verdicts from the Groq AI + deterministic fallback.
              Each entry shows the final verdict, conviction %, and a
              one-sentence rationale. Depth badge indicates whether the verdict
              came from <em>ai-batch</em> (Groq) or <em>ai-synthesis</em>{" "}
              (deterministic).
            </FeatureCard>

            <FeatureCard emoji="📚" name="Council Lessons" tag="pro">
              Post-mortems from closed trades. Each row shows the symbol,
              outcome (win/loss/breakeven), and the AI-generated lesson. These
              lessons are fed back into future Groq prompts as past_lessons —
              the learning loop.
            </FeatureCard>

            <FeatureCard emoji="💼" name="Positions" tag="core">
              Currently open trades, with live PnL calculation every 30 seconds.
              Fee-aware: entry fee + estimated exit fee both included.
              Source tags shown for each position.
            </FeatureCard>

            <FeatureCard emoji="📋" name="Closed Positions" tag="core">
              History of closed trades with full timestamps, reason (target hit
              / stop hit / stale exit / expired / rotated out), and PnL.
            </FeatureCard>

            <FeatureCard emoji="📈" name="Portfolio Summary" tag="core">
              Aggregate metrics: realized PnL, open notional, 24h PnL, win
              rate, profit factor, avg win/loss. RPC-driven from a single
              SQL function.
            </FeatureCard>

            <FeatureCard emoji="❤️" name="Pipeline Health" tag="core">
              Cron monitoring. Shows last successful run, next scheduled run,
              consecutive failures, and an expandable list of recent errors.
              Runs marked <em>degraded</em> indicate a critical feed was
              unavailable.
            </FeatureCard>

            <FeatureCard emoji="🤖" name="AI Risk Summary" tag="pro">
              On-demand deep-dive on any tracked coin. Type a symbol and
              optional context, get a 3-point risk summary: key risks,
              volatility outlook, actionable takeaway. Powered by
              Pollinations.ai.
            </FeatureCard>

            <FeatureCard emoji="🎛️" name="Strategy" tag="advanced">
              The active strategy preset and its evidence weights. Shows how
              strongly whale flow, technicals, prediction markets, and the AI
              council influence each composite signal.
            </FeatureCard>

            <FeatureCard emoji="🌡️" name="Market Regime" tag="advanced">
              A fast read of the market environment: bullish, bearish, or
              neutral technical signals across the tracked universe. The panel
              also shows the data window used when the freshest candles are
              unavailable.
            </FeatureCard>

            <FeatureCard emoji="🏁" name="Variant Performance" tag="pro">
              Compares all 9 strategy presets in shadow mode. Each variant
              receives the same market snapshot, so you can see which approach
              would have produced the strongest signals before promoting it.
            </FeatureCard>

            <FeatureCard emoji="🚨" name="Trade Alerts" tag="core">
              A compact feed of important trade events: entries, exits, stale
              or expired positions, stop-loss and take-profit outcomes,
              rotations, plus system-level feed errors and circuit breaker
              events. Every entry is tagged with its source provenance.
            </FeatureCard>

            <FeatureCard emoji="🧪" name="Diagnostic" tag="advanced">
              The system's inspection window for recent pipeline runs, cleanup
              configuration, shadow conflicts, and serialized errors. Use it to
              verify what the bot decided and why when a signal looks unusual.
            </FeatureCard>
          </div>
        </Section>

        {/* ── Protections ── */}
        <Section
          emoji="🔐"
          title="Protections & safeguards"
          subtitle="What stops things from going wrong"
        >
          <p>
            Every action that could waste resources or delete data is{" "}
            <strong>PIN-protected</strong> (server-side, cannot be bypassed
            from the browser):
          </p>

          <ul className="ml-5 list-disc space-y-1.5">
            <li>
              <strong>Run pipeline</strong> — manual triggers require PIN.
              Prevents accidental API quota burn.
            </li>
            <li>
              <strong>Reset data</strong> — requires PIN. Preserves trades and
              lessons; only clears transient data.
            </li>
          </ul>

          <p className="mt-2">Additional safeguards:</p>

          <ul className="ml-5 list-disc space-y-1.5">
            <li>
              <strong>Atomic mutex:</strong> only one pipeline can run at a
              time. Concurrent invocations are rejected at the DB level.
            </li>
            <li>
              <strong>Partial unique index:</strong> only one open trade per
              symbol is allowed. The DB enforces this regardless of
              application logic.
            </li>
            <li>
              <strong>Freshness gates:</strong> stale data (indicators more
              than 6h old, predictions more than 30 min old, council TTL
              regime-aware) is ignored.
            </li>
            <li>
              <strong>Circuit breaker:</strong> if critical feeds fail, new
              entries are blocked. Existing positions still close normally.
            </li>
            <li>
              <strong>Paper mode default:</strong> live trading requires two
              explicit env flags plus valid API credentials.
            </li>
          </ul>

          <ProNote>
            <p>
              <strong>PIN validation:</strong> server-side only, checked inside
              the <code>createServerFn</code> handler. Client bundles contain
              no secrets.
            </p>
            <p>
              <strong>Pipeline lock:</strong> partial unique index on{" "}
              <code>pipeline_runs (job_name) WHERE status = 'running'</code>.
              Concurrent inserts fail with Postgres error code 23505.
            </p>
            <p>
              <strong>Feed failure response:</strong>{" "}
              <code>indicators=0</code> or <code>whales=0</code> triggers a{" "}
              <code>feed_error</code> alert and marks the run as{" "}
              <code>degraded</code> — pipeline continues in close-only mode
              until feeds recover.
            </p>
          </ProNote>
        </Section>

        {/* ── Tech stack ── */}
        <Section
          emoji="⚙️"
          title="Under the hood"
          subtitle="The stack, for the curious"
        >
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat label="Frontend" value="React 19" hint="TanStack Start" />
            <Stat label="Backend" value="Supabase" hint="PostgreSQL + RLS" />
            <Stat label="AI" value="Groq" hint="GPT-OSS-20B" />
            <Stat label="Tests" value="87+" hint="Vitest suites" />
          </div>

          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat label="Exchanges" value="3" hint="Binance, Bybit, Hyperliquid" />
            <Stat label="Data feeds" value="4" hint="spot, perps, prediction, AI" />
            <Stat label="Watchlist" value="150" hint="dynamic cap" />
            <Stat label="Cycle time" value="60-90s" hint="full pipeline" />
          </div>

          <ProNote>
            <p>
              <strong>Stack:</strong> TanStack Start + React 19 + TypeScript,
              Tailwind CSS, shadcn/ui, React Query, Supabase (Postgres +
              PostgREST + Realtime).
            </p>
            <p>
              <strong>Concurrency:</strong> custom <code>pMap</code> helper
              with configurable parallel workers. Default 15 — keeps rate
              limits happy across 150+ per-coin requests.
            </p>
            <p>
              <strong>Unit tests:</strong> Vitest with 87+ tests covering{" "}
              <code>ruleBased()</code>, <code>evaluateMultiTimeframe()</code>,{" "}
              <code>predictionMagnitude()</code>,{" "}
              <code>checkMtfGate()</code>, and{" "}
              <code>computeAggregate()</code> — the pure functions at the core
              of signal generation.
            </p>
            <p>
              <strong>Caching:</strong> Hyperliquid universe cached 60s,
              Binance exchangeInfo cached 24h, AI verdicts cached 25 min,
              trading settings cached 30s.
            </p>
          </ProNote>
        </Section>

        {/* ── The future ── */}
        <Section
          emoji="🚀"
          title="What's next"
          subtitle="The roadmap"
        >
          <p>
            The robot is <strong>not finished</strong>. It's in active
            development. Here's what's coming:
          </p>

          <ul className="ml-5 list-disc space-y-1.5">
            <li>
              <strong>Perp-only support</strong> — fetch candles directly from
              Hyperliquid for contracts without a Binance spot listing (kPEPE,
              kSHIB, kBONK, etc.).
            </li>
            <li>
              <strong>Higher universe cap</strong> — currently bounded at 150
              coins; expanding to 200+ with tuned concurrency.
            </li>
            <li>
              <strong>Vector-embedding lessons</strong> — cross-symbol
              learning (this pattern on SOL also worked on AVAX).
            </li>
            <li>
              <strong>Backtesting engine</strong> — replay historical data
              against the current logic to validate strategy changes before
              they go live.
            </li>
            <li>
              <strong>Webhook notifications</strong> — push alerts to
              Telegram or Discord on significant events.
            </li>
            <li>
              <strong>Live trading mode</strong> — when paper mode proves
              consistently profitable over 30+ days, live execution becomes
              available (with additional safety gates).
            </li>
            <li>
              <strong>Mobile PWA</strong> — installable companion for
              monitoring and notifications.
            </li>
          </ul>

          <p className="rounded-md border border-warn/30 bg-warn/10 p-3 text-xs text-warn">
            ⚠️ <strong>Important:</strong> This is not financial advice.
            Cryptocurrency markets are extremely volatile. The bot is in paper
            mode — no real money is at risk. Even after 30+ days of paper
            profits, live deployment should only be done with funds you can
            afford to lose entirely.
          </p>
        </Section>

        {/* ── Contact ── */}
        <section className="panel border-bull/30 bg-bull/5">
          <div className="flex items-start gap-3">
            <span className="text-3xl leading-none">📬</span>
            <div className="flex-1">
              <h2 className="panel-title text-bull">Interested in this tool?</h2>
              <p className="mt-2 text-sm leading-relaxed text-foreground/90">
                Whether you're a complete beginner curious about algorithmic
                trading, an experienced trader looking for a modular bot
                framework, or someone with ideas to improve it — I'd love to
                hear from you.
              </p>
              <div className="mt-3 flex flex-wrap items-center gap-3">
                <a
                  href="mailto:gepappas98@gmail.com?subject=Interested%20in%20the%20Trading%20Command%20Center"
                  className="inline-flex items-center gap-2 rounded-md bg-bull px-4 py-2.5 font-mono text-sm font-semibold text-background transition hover:opacity-90"
                >
                  ✉️ gepappas98@gmail.com
                </a>
              </div>
              <p className="mt-2 text-[11px] text-muted-foreground">
                Click the button or copy the address above. I reply to every email.
              </p>
            </div>
          </div>
        </section>

        {/* ── Support the developer ── */}
        <SupportDeveloper />

        <p className="pb-4 text-center text-[11px] text-muted-foreground">
          Made with 🤖 + ❤️ · Research Lab · v2.2
        </p>

        <div className="flex justify-center pt-2">
          <Link
            to="/"
            className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90"
          >
            ← Back to dashboard
          </Link>
        </div>
      </main>
    </div>
  );
}
