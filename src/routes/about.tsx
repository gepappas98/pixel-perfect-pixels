import { createFileRoute, Link } from "@tanstack/react-router";

export const Route = createFileRoute("/about")({
  head: () => ({
    meta: [
      { title: "About — Trading Command Center" },
      {
        name: "description",
        content:
          "Learn what the Trading Command Center is, how it works, and what the future holds. Simple explanation, no jargon.",
      },
    ],
  }),
  component: AboutPage,
});

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
              A simple guide for everyone — no experience needed.
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
        <section className="panel">
          <h2 className="panel-title">🤖 What is this page?</h2>
          <div className="mt-3 space-y-3 text-sm leading-relaxed text-foreground/90">
            <p>
              Imagine you have a <strong>super-smart robot</strong> that watches the crypto
              market all day and all night. It never sleeps, never gets tired, and never
              forgets anything.
            </p>
            <p>
              This page is like the <strong>control room</strong> where you can see what the
              robot is thinking. It shows you lots of numbers, colors, and charts — but
              really, it's just the robot telling you: <em>"Hey, look at this! Something
              interesting is happening!"</em>
            </p>
            <p>
              You don't have to be a math genius to use it. You just need to look at the
              green things (good signs) and the red things (warning signs) — and let the
              robot do the hard thinking.
            </p>
          </div>
        </section>

        {/* ── What it does ── */}
        <section className="panel">
          <h2 className="panel-title">🎯 What does it actually do?</h2>
          <p className="mt-3 text-sm leading-relaxed text-foreground/90">
            The robot has <strong>four special jobs</strong>. It does all four at the same
            time, every 10 minutes (or every 2 minutes if you want it to work faster):
          </p>

          <div className="mt-4 space-y-3">
            <div className="rounded-md border border-border/70 bg-background/30 p-3">
              <div className="font-mono text-sm font-semibold text-accent">
                1. 🐋 Watching the Whales
              </div>
              <p className="mt-1.5 text-sm text-foreground/90">
                "Whales" are people with a LOT of money. When they buy or sell big amounts,
                the price can move. The robot watches for these big moves and tells you
                which way the whales are swimming.
              </p>
            </div>

            <div className="rounded-md border border-border/70 bg-background/30 p-3">
              <div className="font-mono text-sm font-semibold text-accent">
                2. 📈 Reading the Charts
              </div>
              <p className="mt-1.5 text-sm text-foreground/90">
                The robot looks at how prices changed in the past. It uses special math
                tools (called "RSI" and "MACD" — you don't need to remember these!) to
                guess if a coin is going up or down next.
              </p>
            </div>

            <div className="rounded-md border border-border/70 bg-background/30 p-3">
              <div className="font-mono text-sm font-semibold text-accent">
                3. 🗳️ Listening to Predictions
              </div>
              <p className="mt-1.5 text-sm text-foreground/90">
                There are websites where people bet on what will happen — like "Will
                Bitcoin go to $100,000?" The robot reads these bets and uses them as
                another clue about the future.
              </p>
            </div>

            <div className="rounded-md border border-border/70 bg-background/30 p-3">
              <div className="font-mono text-sm font-semibold text-accent">
                4. 🧠 Asking a Smart AI Friend
              </div>
              <p className="mt-1.5 text-sm text-foreground/90">
                Finally, the robot asks a super-smart AI (like a very clever computer
                brain) to look at everything together and give a final opinion. The AI
                says things like "BUY", "SELL", or "HOLD" — just like a friend giving you
                advice.
              </p>
            </div>
          </div>
        </section>

        {/* ── How it works ── */}
        <section className="panel">
          <h2 className="panel-title">⚙️ How does it all work together?</h2>
          <div className="mt-3 space-y-3 text-sm leading-relaxed text-foreground/90">
            <p>
              Think of it like a <strong>team of friends</strong> helping you decide
              something important. Each friend has one job:
            </p>
            <ul className="ml-5 list-disc space-y-1.5">
              <li>One friend watches the whales 🐋</li>
              <li>One friend reads the charts 📈</li>
              <li>One friend checks what other people are betting 🗳️</li>
              <li>One friend is the smartest of all, and listens to everyone before deciding 🧠</li>
            </ul>
            <p>
              Then they all vote. If <strong>most of them agree</strong>, the robot shows a
              strong signal (like "BUY" or "SELL"). If they disagree, the robot shows
              "HOLD" or "WATCH" — which means <em>"let's wait and see"</em>.
            </p>
            <p>
              The robot also keeps notes. Every time it makes a mistake, it writes down a
              little lesson for next time. It's like when you touch a hot pan and learn
              not to do it again — the robot learns the same way, but with money!
            </p>
          </div>
        </section>

        {/* ── The panels ── */}
        <section className="panel">
          <h2 className="panel-title">🗺️ What are all these boxes on the page?</h2>
          <div className="mt-3 space-y-2 text-sm text-foreground/90">
            <p>Every box is like a window into the robot's brain. Here's what each one shows:</p>
            <ul className="ml-5 list-disc space-y-1.5">
              <li><strong>Composite Signals</strong> — the robot's final opinions, with green for buy and red for sell</li>
              <li><strong>Whale Flow</strong> — the biggest money moves happening right now</li>
              <li><strong>Technicals (4h)</strong> — the chart reading for each coin</li>
              <li><strong>Prediction Markets</strong> — what people are betting on</li>
              <li><strong>AI Council</strong> — the smart AI's opinion on each coin</li>
              <li><strong>Council Lessons</strong> — what the robot learned from past mistakes</li>
              <li><strong>AI Risk Summary</strong> — you can ask the AI about any coin you want</li>
              <li><strong>Pipeline Health</strong> — "is everything working okay?"</li>
              <li><strong>Portfolio Summary</strong> — how much money you've made or lost</li>
              <li><strong>Positions</strong> — the coins the robot has bought or sold right now</li>
              <li><strong>Closed Positions</strong> — coins the robot already finished with</li>
            </ul>
          </div>
        </section>

        {/* ── Paper vs real ── */}
        <section className="panel">
          <h2 className="panel-title">🎮 Is this real money?</h2>
          <div className="mt-3 space-y-3 text-sm leading-relaxed text-foreground/90">
            <p>
              Right now it's in <strong>"paper mode"</strong>. That means it's a{" "}
              <strong>practice game</strong> — like playing with fake money to see if you
              would have won or lost.
            </p>
            <p>
              When paper mode shows real profits over time, we can switch it to{" "}
              <strong>live mode</strong> — where it uses real money. But we only do that
              when we're absolutely sure it works. It's like practicing a sport for months
              before playing a real match.
            </p>
          </div>
        </section>

        {/* ── The future ── */}
        <section className="panel border-accent/30 bg-accent/5">
          <h2 className="panel-title text-accent">🚀 What's next? (The future)</h2>
          <div className="mt-3 space-y-3 text-sm leading-relaxed text-foreground/90">
            <p>
              This robot is still <strong>learning</strong>. Every day it gets a little
              smarter. Here are the exciting things we want to add:
            </p>
            <ul className="ml-5 list-disc space-y-1.5">
              <li>
                <strong>More coins</strong> — right now it watches about 100 coins. Soon,
                it will watch many more.
              </li>
              <li>
                <strong>Better learning</strong> — the robot will study its own mistakes
                more carefully and remember them longer.
              </li>
              <li>
                <strong>Auto-pilot mode</strong> — one day, it will make decisions all by
                itself, without you needing to press buttons.
              </li>
              <li>
                <strong>Real money trading</strong> — when the practice game shows good
                results for a long time, we turn on the real thing.
              </li>
              <li>
                <strong>Mobile phone app</strong> — so you can check on your robot from
                anywhere, anytime.
              </li>
              <li>
                <strong>More AI friends</strong> — we'll invite other smart AIs to the
                "council" so they can vote together.
              </li>
            </ul>
            <p className="rounded-md border border-warn/30 bg-warn/10 p-3 text-xs text-warn">
              ⚠️ <strong>Important:</strong> This is not financial advice. Cryptocurrency
              is risky. Always do your own research and never invest money you can't
              afford to lose.
            </p>
          </div>
        </section>

        {/* ── Contact ── */}
        <section className="panel border-bull/30 bg-bull/5">
          <h2 className="panel-title text-bull">📬 Interested in this tool?</h2>
          <div className="mt-3 space-y-3 text-sm leading-relaxed text-foreground/90">
            <p>
              If you're curious about this robot, want to try it yourself, or just want to
              say hello — send an email! I love talking about this stuff.
            </p>
            <p className="text-center">
              <a
                href="mailto:gepappas98@gmail.com?subject=Interested%20in%20the%20Trading%20Command%20Center"
                className="inline-flex items-center gap-2 rounded-md bg-bull px-4 py-2.5 font-mono text-sm font-semibold text-background transition hover:opacity-90"
              >
                ✉️ gepappas98@gmail.com
              </a>
            </p>
            <p className="text-center text-xs text-muted-foreground">
              Click the button or copy the address above.
            </p>
          </div>
        </section>

        <p className="pb-4 text-center text-[11px] text-muted-foreground">
          Made with 🤖 + ❤️ · Trading Command Center
        </p>
      </main>
    </div>
  );
}
