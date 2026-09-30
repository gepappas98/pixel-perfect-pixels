import { createFileRoute, Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { SupportDeveloper } from "@/components/trading/SupportDeveloper";

export const Route = createFileRoute("/about")({
  head: () => ({
    meta: [
      { title: "About — Trading Command Center" },
      {
        name: "description",
        content:
          "A complete guide to the Trading Command Center: what it does, how it works, and the technology behind it. Written for both newcomers and experienced traders.",
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

function FeatureCard({
  emoji,
  name,
  tag,
  children,
}: {
  emoji: string;
  name: string;
  tag?: "core" | "advanced" | "pro";
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
            Every 15 minutes it wakes up, gathers 4 different kinds of evidence,
            votes on what to do, opens or closes trades, and writes down what it
            learned.
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
          subtitle="4 evidence sources → 1 decision"
        >
          <p>
            Every cycle, the robot gathers <strong>four kinds of evidence</strong>.
            Think of it like a courtroom: four independent witnesses testify, and
            then the judge (the robot) decides.
          </p>

          <div className="mt-4 space-y-3">
            <FeatureCard emoji="🐋" name="1. Whale Tracking" tag="core">
              <p>
                "Whales" are traders with <strong>serious money</strong>. When
                they buy or sell big amounts, prices move. The robot watches both
                Binance (spot market) and Hyperliquid (perpetual futures) for
                large trades. When it detects accumulation (buying) or
                distribution (selling), that's evidence.
              </p>
              <ProNote>
                <p>
                  <strong>Sources:</strong> Hyperliquid{" "}
                  <code>recentTrades</code> per coin + Binance{" "}
                  <code>aggTrades</code> per pair.
                </p>
                <p>
                  <strong>Thresholds (per-market):</strong> BTC/ETH/BNB $50k ·
                  SOL/XRP/ADA/DOGE $25k · mid-caps $5k–15k · memecoins $3k.
                  Hyperliquid floors are 2× Binance floors (perps print bigger
                  clips).
                </p>
                <p>
                  <strong>Direction logic:</strong> accumulation if buy-USD &gt;
                  sell-USD × 1.15, distribution if reverse. Requires a 15% skew
                  to avoid noise.
                </p>
              </ProNote>
            </FeatureCard>

            <FeatureCard emoji="📈" name="2. Technical Analysis" tag="core">
              <p>
                The robot reads the <strong>price history</strong> of every coin
                on a 4-hour timeframe. It calculates three classic indicators:
                RSI (is the coin overbought or oversold?), MACD (is momentum
                shifting?), and Bollinger Bands (is the price unusually stretched?).
              </p>
              <p>
                Then it classifies each coin as <strong>bullish</strong>,{" "}
                <strong>bearish</strong>, or <strong>neutral</strong>.
              </p>
              <ProNote>
                <p>
                  <strong>Indicators:</strong> RSI (14) · MACD (12, 26, 9) ·
                  Bollinger Bands (20, 2σ).
                </p>
                <p>
                  <strong>Classification rules:</strong> bullish if{" "}
                  <code>(RSI ≤ 45 ∧ momentum &gt; 0) ∨ (RSI &lt; 55 ∧ momentum &gt; 0.1% of |MACD|)</code>.
                  Symmetric for bearish.
                </p>
                <p>
                  <strong>Data:</strong> 100 candles × 4h = ~17 days lookback.
                  Freshness gate: 6h max age (one extra candle tolerance).
                </p>
              </ProNote>
            </FeatureCard>

            <FeatureCard emoji="🗳️" name="3. Prediction Markets" tag="core">
              <p>
                There are websites where people <strong>bet real money</strong> on
                future events — like "Will Bitcoin reach $130,000 by 2026?". The
                robot reads these markets (from <strong>Polymarket</strong>) and
                uses them as another opinion.
              </p>
              <p>
                <strong>Important nuance:</strong> "Yes" doesn't always mean
                bullish. If a market asks "Will Bitcoin <em>dip</em> to $65k?",
                a 19% yes probability is actually <strong>bullish</strong>{" "}
                (because most traders think it won't fall that far). The robot
                parses the <em>wording</em> to figure out the correct direction.
              </p>
              <ProNote>
                <p>
                  <strong>Source:</strong> Polymarket Gamma API,{" "}
                  <code>tag_slug=crypto</code>, limit 200 events/cycle.
                </p>
                <p>
                  <strong>Symbol matching:</strong> keyword-position ranking —
                  the coin whose name appears earliest in the question wins.
                  Avoids false positives on multi-coin markets.
                </p>
                <p>
                  <strong>Direction parser:</strong> regex on question text.
                  Bullish keywords: reach, hit, above, surpass, ATH. Bearish:
                  dip, drop, below, crash. Upward probability ={" "}
                  <code>yes</code> for bullish questions,{" "}
                  <code>1 − yes</code> for bearish. Bullish if &gt; 0.6, bearish
                  if &lt; 0.4.
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
                <strong>Adaptive scheduling:</strong> the AI is only queried
                when there's a meaningful reason (large whale flow, extreme RSI,
                or 25+ minutes since the last query). This keeps costs low and
                avoids rate limits.
              </p>
              <ProNote>
                <p>
                  <strong>Model:</strong> <code>openai/gpt-oss-20b</code> via
                  Groq's OpenAI-compatible endpoint. Temperature 0.2, max
                  output 1024 tokens, 15s timeout.
                </p>
                <p>
                  <strong>Trigger conditions:</strong> whale USD ≥ per-market
                  floor, OR RSI &lt; 30, OR RSI &gt; 70.
                </p>
                <p>
                  <strong>Batching:</strong> up to 15 candidates per request,
                  sorted by whale USD. Rate guard: min 25 min between batches,
                  25 min verdict TTL.
                </p>
                <p>
                  <strong>Deterministic fallback:</strong> if Groq is down or
                  rate-limited, a rule-based council (weighted votes from
                  technicals, whale flow, prediction direction) takes over.
                  No gap in coverage.
                </p>
              </ProNote>
            </FeatureCard>
          </div>
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
            the AI to write a <strong>short lesson</strong>: "What should I
            remember for the next time I see this coin?"
          </p>

          <p>Then, before the next decision, it <strong>reads its own notes</strong>. It's like a student who keeps a notebook and reviews it before every exam.</p>

          <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
            <Stat label="Max lessons kept" value="5" hint="per symbol, most recent" />
            <Stat label="Post-mortems per cycle" value="5" hint="token budget cap" />
            <Stat label="Lesson model" value="Groq" hint="same LLM as council" />
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
              is asked for a single-sentence lesson. Temperature 0.3, max 80
              tokens. Outcome derived from realized PnL: win / loss / breakeven.
            </p>
            <p>
              <strong>System prompt instruction:</strong> "Weigh past_lessons as
              real experience: a lesson from a [loss] reduces confidence in
              repeating the same mistake; a [win] increases confidence in the
              same pattern."
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
            <Stat label="Stop loss" value="−3%" hint="from entry price" />
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
            <strong>2% today</strong> (realized + unrealized), the robot
            <strong> stops opening new trades</strong> for the rest of the day
            (Athens timezone).
          </p>

          <ProNote>
            <p>
              <strong>Position sizing formula:</strong> quantity ={" "}
              <code>maxTradeRisk / (|entry − stop| + (entry + stop) × fee_rate)</code>.
              Fee rate 0.05% per side (Binance taker).
            </p>
            <p>
              <strong>Portfolio risk:</strong> sum of{" "}
              <code>|entry − stop| × qty + fees</code> across all open trades.
              Gate rejects new trades if adding would exceed 2%.
            </p>
            <p>
              <strong>Daily economic PnL:</strong> realized PnL since Athens
              midnight + unrealized PnL on all open trades (net of estimated
              exit fees). Athens timezone handles DST automatically.
            </p>
            <p>
              <strong>Entry filters:</strong> price drift ≤ 2% from signal
              price; signal age ≤ 15 min; symbol cooldown ≥ 15 min after close.
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
            <li>New signal is <strong>≥ 75%</strong> confidence</li>
            <li>It's <strong>≥ 10 points stronger</strong> than the weakest open trade's original confidence</li>
            <li>The weakest trade is <strong>≥ 30 min old</strong> (no flickering)</li>
            <li>The weakest trade has PnL <strong>≤ +0.5%</strong> (never cut a winner)</li>
            <li>Only <strong>1 rotation per cycle</strong></li>
            <li>The rotated-out symbol goes on <strong>15 min cooldown</strong></li>
          </ul>

          <ProNote>
            <p>
              <strong>Selection:</strong> rotate out the trade with the lowest{" "}
              PnL%, tie-broken by lowest original signal confidence.
            </p>
            <p>
              <strong>Close reason:</strong> <code>rotated_out</code>. Shows in
              Closed Positions with amber color.
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
              <strong>Stale exit</strong> — if a trade is <strong>≥ 48 hours old</strong>{" "}
              and its PnL is within <strong>±1%</strong> (essentially
              flat), close it. No reason to keep capital tied up in nothing.
            </li>
            <li>
              <strong>Expired exit</strong> — if a trade is <strong>≥ 7 days old</strong>{" "}
              regardless of PnL, close it. This is a hard cap: nothing stays
              open forever.
            </li>
          </ul>

          <p>
            This creates <strong>guaranteed turnover</strong>, which means more
            closed trades, which means more lessons learned, which means a
            smarter robot next month.
          </p>

          <ProNote>
            <p>
              <strong>Constants:</strong>{" "}
              <code>STALE_EXIT_HOURS = 48</code>,{" "}
              <code>STALE_EXIT_MIN_PNL_PCT = 1.0</code>,{" "}
              <code>MAX_HOLD_HOURS = 168</code>.
            </p>
            <p>
              <strong>Check order:</strong> stop-loss → take-profit → expired
              → stale. First matching rule wins.
            </p>
            <p>
              <strong>Close reasons:</strong> <code>stale_exit</code> /{" "}
              <code>expired</code>. Both shown in muted color in Closed
              Positions (they're neither wins nor losses).
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
              <code>TRADING_FEE_RATE = 0.0005</code> in <code>src/lib/fees.ts</code>,
              mirrored by <code>public.trading_fee_rate()</code> in SQL. Change both together.
            </p>
            <p>
              <strong>Storage:</strong> <code>entry_fee</code> saved on open,
              actual fees plus gross and net PnL on close. The <code>pnl</code>{" "}
              column always holds <em>net</em> PnL.
            </p>
            <p>
              <strong>Sizing:</strong> fees are included in the stop-distance
              denominator, so risk per trade stays at 0.25% after costs.
            </p>
          </ProNote>
        </Section>

        {/* ── Strategy presets ── */}
        <Section
          emoji="🎛️"
          title="Strategy presets & weights"
          subtitle="How much each witness counts"
        >
          <p>
            The four evidence sources don't have to count equally. A{" "}
            <strong>preset</strong> decides how loud each one is. Prefer chart
            signals? Turn technicals up. Trust big-money flow? Turn whales up.
          </p>

          <ul className="ml-5 list-disc space-y-1.5">
            <li><strong>Balanced</strong> — all four sources weighted evenly.</li>
            <li><strong>Chart Trader</strong> — technicals lead the decision.</li>
            <li><strong>Whale-Focused</strong> — large-money flow leads.</li>
            <li><strong>Sentiment-First</strong> — prediction markets lead.</li>
            <li><strong>AI-Driven</strong> — the AI council gets the loudest vote.</li>
            <li><strong>Conservative</strong> — needs broad agreement before acting.</li>
          </ul>

          <p>
            You can also drag the sliders yourself. Changed weights show an{" "}
            <strong>UNSAVED</strong> badge until you press Save — nothing takes
            effect before that.
          </p>

          <ProNote>
            <p>
              <strong>Presets:</strong> <code>src/lib/strategy.presets.ts</code>.
              Weights multiply the per-source score before thresholding.
            </p>
            <p>
              <strong>Auto-switch:</strong> optional 4h re-evaluation asks Groq
              which preset fits the current regime (max 600 output tokens, 20s
              timeout). Failures are logged and the active preset is kept.
            </p>
          </ProNote>
        </Section>

        {/* ── Shadow variants ── */}
        <Section
          emoji="🧪"
          title="Shadow testing (Variant Performance)"
          subtitle="All 6 presets compete, without risking anything"
        >
          <p>
            On every cycle, all six presets are scored in parallel — not just
            the active one. The five that aren't in charge still record what
            they <em>would</em> have traded. It's a permanent, honest contest
            running in the background.
          </p>

          <ul className="ml-5 list-disc space-y-1.5">
            <li>Each shadow trade assumes <strong>$1,000</strong>, take profit <strong>+4%</strong>, stop <strong>−3%</strong>.</li>
            <li>Unresolved after <strong>7 days</strong> → closed at market as <em>expired</em>.</li>
            <li>Outcomes are checked against real 4-hour candles — no guessing.</li>
            <li>Shadow results <strong>never</strong> touch the real paper portfolio.</li>
          </ul>

          <p>
            The Variant Performance panel then ranks the presets by win rate and
            hypothetical profit, so you can see which style is actually working
            in current conditions before you switch to it.
          </p>

          <ProNote>
            <p>
              <strong>Table:</strong> <code>strategy_variant_signals</code>
              (outcome: <code>open</code> / <code>win</code> / <code>loss</code> /{" "}
              <code>expired</code>). Resolver: <code>resolveVariantOutcomes()</code>{" "}
              using Binance 4h klines, high/low touch detection.
            </p>
            <p>
              <strong>Panel query:</strong> filters on resolved outcomes
              server-side — a plain recency query hits the 1,000-row API cap and
              returns only freshly-open rows.
            </p>
            <p>
              <strong>Bookkeeping:</strong> each run writes{" "}
              <code>variants_resolved</code> back to <code>pipeline_runs</code>.
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
            and a weekly cleanup keeps the data small and fast.
          </p>

          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
            <Stat label="Pipeline" value="10 min" hint="round the clock" />
            <Stat label="Watchdog" value="5 min" hint="clears stalled runs" />
            <Stat label="Cleanup" value="Weekly" hint="Monday 03:00 UTC" />
          </div>

          <p className="mt-3">
            The cleanup removes only data nobody reads any more. Things you care
            about are kept <strong>forever</strong>: every trade, every lesson,
            and every buy/sell signal.
          </p>

          <ul className="ml-5 list-disc space-y-1.5">
            <li><strong>Kept forever</strong> — trades, council lessons, buy/sell signals, portfolio history.</li>
            <li><strong>Removed after 7 days</strong> — whale alerts, watch/hold signals, shadow variant signals, indicator and prediction snapshots, run history.</li>
            <li><strong>Removed after 30 days</strong> — trade alerts.</li>
          </ul>

          <ProNote>
            <p>
              <strong>Jobs:</strong> <code>trading-pipeline-auto</code> (*/10),{" "}
              <code>reconcile-stuck-pipeline-runs</code> (*/5),{" "}
              <code>refresh-pattern-stats</code> (*/10).
            </p>
            <p>
              <strong>Cleanup hook:</strong>{" "}
              <code>cleanup_old_pipeline_data()</code> is invoked from the
              reconcile job inside a Monday 03:00–03:05 UTC window
              (<code>isodow = 1</code>), avoiding a separate cron entry.
            </p>
            <p>
              <strong>Stall repair:</strong> runs left in <code>running</code>{" "}
              past the timeout are marked <code>error</code> so the{" "}
              <code>pipeline_runs_one_active</code> index stops blocking new runs.
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
              with a confidence percentage. Only actionable signals survive
              filtering — weak ones are dropped.
              <ProNote>
                <p>
                  <strong>Scoring:</strong> whale ±1.0 · technicals ±1.0 ·
                  prediction ±0.5 · AI council ±0.75 (capped). Max ±3.25.
                </p>
                <p>
                  <strong>Thresholds:</strong> buy if score ≥ 1.5 · sell if ≤
                  −1.5 · watch if −1.5 &lt; score &lt; 1.5 with ≥ 2 sources ·
                  hold if |score| &lt; 0.5 (dropped).
                </p>
                <p>
                  <strong>High-conviction AVOID</strong> (≥ 60%) forces{" "}
                  <code>watch</code> regardless of raw score — a veto signal.
                </p>
                <p>
                  <strong>Fingerprint:</strong> deterministic SHA-style hash of
                  all inputs, excluding timestamps. Same inputs → same
                  fingerprint → upsert (no duplicates).
                </p>
              </ProNote>
            </FeatureCard>

            <FeatureCard emoji="🐋" name="Whale Flow" tag="core">
              Live feed of large-money trades detected in the last cycle.
              Green = accumulation, red = distribution. Each entry shows
              symbol, direction, USD value.
            </FeatureCard>

            <FeatureCard emoji="📊" name="Technicals (4h)" tag="core">
              103+ coins, deduplicated per symbol. Shows RSI, current price,
              and the classification (bullish / bearish / neutral).
              Sorted with bullish first.
            </FeatureCard>

            <FeatureCard emoji="🔮" name="Prediction Markets" tag="core">
              Top markets per symbol, ranked by 24h volume. Yes probability
              displayed as a progress bar. Volume shown for reliability
              context. Markets with &lt; $500 volume or &gt; 95% odds are
              filtered out.
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
              lessons are fed back into future Groq prompts as
              "past_lessons" — the learning loop.
            </FeatureCard>

            <FeatureCard emoji="💼" name="Positions" tag="core">
              Currently open trades, with live PnL calculation every 30 seconds.
              Fee-aware: entry fee + estimated exit fee both included.
              Fetches prices in a single batch request.
            </FeatureCard>

            <FeatureCard emoji="📋" name="Closed Positions" tag="core">
              History of closed trades with full timestamps (opened / closed),
              reason (target hit / stop hit / stale exit / expired / rotated
              out), and PnL. Filtered to exclude duplicate-cleanup rows.
            </FeatureCard>

            <FeatureCard emoji="📈" name="Portfolio Summary" tag="core">
              Aggregate metrics: realized PnL, open notional, 24h PnL, win
              rate, profit factor, avg win/loss. RPC-driven from a single
              SQL function.
            </FeatureCard>

            <FeatureCard emoji="❤️" name="Pipeline Health" tag="core">
              Cron monitoring. Shows last successful run, next scheduled run,
              consecutive failures, and an expandable list of recent errors
              with step-level attribution.
            </FeatureCard>

            <FeatureCard emoji="🤖" name="AI Risk Summary" tag="pro">
              On-demand deep-dive on any of ~150 coins. Type a symbol and
              optional context, get a 3-point risk summary: key risks,
              volatility outlook, actionable takeaway. Powered by Groq.
            </FeatureCard>

            <FeatureCard emoji="🎛️" name="Strategy" tag="advanced">
              The active strategy preset and its evidence weights. Shows how
              strongly whale flow, technicals, prediction markets, and the AI
              council influence each composite signal.
              <ProNote>
                <p>
                  <strong>Presets:</strong> conservative, balanced, aggressive,
                  momentum, contrarian, and whale-following variants can be
                  compared without changing the underlying risk limits.
                </p>
                <p>
                  <strong>Safety:</strong> strategy selection changes signal
                  scoring, not position sizing, stop-loss, take-profit, or the
                  paper-mode guardrails.
                </p>
              </ProNote>
            </FeatureCard>

            <FeatureCard emoji="🌡️" name="Market Regime" tag="advanced">
              A fast read of the market environment: bullish, bearish, or
              neutral technical signals across the tracked universe. The panel
              also shows the data window used when the freshest candles are
              unavailable.
              <ProNote>
                <p>
                  <strong>Resilient windows:</strong> technicals try 4h data from
                  the last 6h, then 24h, then 7 days instead of silently showing
                  an empty regime.
                </p>
              </ProNote>
            </FeatureCard>

            <FeatureCard emoji="🏁" name="Variant Performance" tag="pro">
              Compares the six strategy presets in shadow mode. Each variant
              receives the same market snapshot, so you can see which approach
              would have produced the strongest signals before promoting it.
              <ProNote>
                <p>
                  <strong>Shadow testing:</strong> variants are evaluated without
                  opening trades or changing the live preset. Results are kept
                  separate for transparent comparison and learning.
                </p>
              </ProNote>
            </FeatureCard>

            <FeatureCard emoji="🚨" name="Trade Alerts" tag="core">
              A compact feed of important trade events: entries, exits, stale
              or expired positions, stop-loss and take-profit outcomes, and
              rotations. It gives the latest action context without opening the
              full positions history.
            </FeatureCard>

            <FeatureCard emoji="🧪" name="Diagnostic" tag="advanced">
              The system's inspection window for recent pipeline runs, cleanup
              configuration, shadow conflicts, and serialized errors. Use it to
              verify what the bot decided and why when a signal looks unusual.
              <ProNote>
                <p>
                  <strong>Read-only:</strong> diagnostics expose audit data and
                  do not trigger a pipeline run, change a strategy, or modify a
                  trade.
                </p>
              </ProNote>
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
              lessons; only clears transient data (signals, technicals, whale
              alerts, predictions, council verdicts, pipeline runs).
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
              <strong>Freshness gates:</strong> stale data (indicators &gt; 6h,
              predictions &gt; 30 min, council &gt; 30 min) is ignored. Prevents
              decisions from outdated information.
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
              <strong>Trade integrity:</strong> partial unique index on{" "}
              <code>trades (symbol) WHERE status = 'open'</code>. Same error
              code caught and logged as <code>[ENTRY_SKIPPED]</code>.
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
            <Stat label="Runtime" value="Node 20+" hint="edge-ready" />
          </div>

          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat label="Exchanges" value="2" hint="Binance · Hyperliquid" />
            <Stat label="Data feeds" value="4" hint="spot · perps · prediction · AI" />
            <Stat label="Watchlist" value="97" hint="coins tracked" />
            <Stat label="Cycle time" value="~60s" hint="full pipeline" />
          </div>

          <ProNote>
            <p>
              <strong>Stack:</strong> TanStack Start + React 19 + TypeScript ·
              Tailwind CSS · shadcn/ui components · React Query for data
              fetching · Supabase (Postgres + PostgREST + Realtime).
            </p>
            <p>
              <strong>Concurrency:</strong> custom <code>pMap</code> helper
              with configurable parallel workers. Default 10 — keeps rate
              limits happy across 95+ per-coin requests.
            </p>
            <p>
              <strong>Batch optimization:</strong> single{" "}
              <code>/ticker/price</code> call fetches all Binance prices at
              once. Avoids N sequential HTTP requests per cycle.
            </p>
            <p>
              <strong>Caching:</strong> Hyperliquid universe cached 60s
              (shared across 3 call sites). AI verdicts cached 25 min. Failed
              universe fetches do <em>not</em> poison the cache.
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
              <strong>More coins</strong> — expanding from 95 to 200+ as the
              system proves stable at higher throughput.
            </li>
            <li>
              <strong>Better learning</strong> — vector embeddings for
              cross-symbol lessons ("this pattern on SOL also worked on AVAX").
            </li>
            <li>
              <strong>Backtesting engine</strong> — replay historical data
              against the current logic to validate strategy changes before
              they go live.
            </li>
            <li>
              <strong>Multi-timeframe analysis</strong> — currently 4h only;
              adding 1h and daily for confirmation.
            </li>
            <li>
              <strong>Live trading mode</strong> — when paper mode proves
              consistently profitable over 30+ days, live execution becomes
              available (with additional safety gates).
            </li>
            <li>
              <strong>Custom strategies</strong> — user-configurable weights
              for the 4 evidence sources, so different traders can tune the
              bot to their own style.
            </li>
            <li>
              <strong>Mobile app</strong> — native iOS/Android companion for
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
          Made with 🤖 + ❤️ · Trading Command Center · v2.1
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
