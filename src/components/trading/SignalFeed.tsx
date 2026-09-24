// src/components/trading/SignalFeed.tsx
import React, { useEffect, useState } from 'react';

export interface SignalFeedProps {
  // Optional: allow injecting initial signals or providing a fetch function later
  signals?: { id: string; name: string; value?: string }[];
  onRefresh?: () => void;
  fetchSignals?: () => Promise<{ id: string; name: string; value?: string }[]>;
}

const SignalFeed: React.FC<SignalFeedProps> = ({
  signals: initialSignals,
  onRefresh,
  fetchSignals,
}) => {
  const [auto, setAuto] = useState<boolean>(false);
  const [cadence, setCadence] = useState<'2' | '5' | '10'>('2');
  const [signals, setSignals] = useState<{ id: string; name: string; value?: string }[]>(
    initialSignals || []
  );
  const [loading, setLoading] = useState<boolean>(false);

  useEffect(() => {
    // If no initial signals were provided and a fetch function exists, load data
    if (!initialSignals && fetchSignals) {
      setLoading(true);
      fetchSignals()
        .then((data) => {
          setSignals(data || []);
          setLoading(false);
        })
        .catch(() => setLoading(false));
    }
  }, [initialSignals, fetchSignals]);

  // Update local signals if initialSignals prop changes
  useEffect(() => {
    if (initialSignals) {
      setSignals(initialSignals);
    }
  }, [initialSignals]);

  const runPipeline = () => {
    onRefresh?.();
  };

  const cadenceLabel = (m: string) => `Every ${m} min`;

  return (
    <section className="signal-feed-card bg-white rounded-lg shadow-md p-4" aria-label="Signal Feed">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-base font-semibold text-gray-800">Signal Feed</h2>
        <div className="flex items-center space-x-2">
          <span className="text-sm text-gray-600">Auto</span>
          <button
            aria-label="Toggle auto"
            onClick={() => setAuto((v) => !v)}
            className="w-12 h-6 rounded-full p-0.5 border"
            style={{
              backgroundColor: auto ? '#38a169' : '#e2e8f0',
              display: 'inline-flex',
              alignItems: 'center',
            }}
          >
            <span
              style={{
                width: 22,
                height: 22,
                borderRadius: '50%',
                background: '#fff',
                display: 'block',
                transition: 'transform 0.2s',
                transform: auto ? 'translateX(26px)' : 'translateX(0)',
              }}
            />
          </button>
        </div>
      </div>

      <div className="flex space-x-2 mb-3">
        {(['2', '5', '10'] as const).map((m) => (
          <button
            key={m}
            className={`px-3 py-1 rounded border ${
              cadence === m ? 'bg-blue-600 text-white' : 'bg-white text-gray-700'
            }`}
            onClick={() => setCadence(m)}
          >
            {cadenceLabel(m)}
          </button>
        ))}
      </div>

      <div className="flex items-center justify-between mb-2">
        <button
          className="px-3 py-2 bg-indigo-600 text-white rounded hover:bg-indigo-700"
          onClick={runPipeline}
        >
          Run pipeline
        </button>
        <div className="text-sm text-gray-600">Composite signals</div>
      </div>

      <div
        className="border rounded-md bg-gray-50 p-2 mb-3"
        style={{ minHeight: 96 }}
        aria-label="Composite signals list"
      >
        {loading ? (
          <div className="text-sm text-gray-500">Loading…</div>
        ) : signals.length === 0 ? (
          <div className="text-sm text-gray-500">No signals</div>
        ) : (
          <ul className="divide-y">
            {signals.map((s) => (
              <li key={s.id} className="flex justify-between py-1.5 text-sm">
                <span>{s.name}</span>
                <span className="font-semibold">{s.value ?? '—'}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="border-t pt-2 mt-2">
        <div className="text-sm font-semibold mb-1">Whale flow</div>
        <div className="text-xs text-gray-600">Data source: local mock / data layer</div>
      </div>

      <div className="border-t pt-2 mt-2">
        <div className="text-sm font-semibold mb-1">Technicals (4h)</div>
        <div className="text-xs text-gray-600">Loading…</div>
      </div>

      <div className="border-t pt-2 mt-2">
        <div className="text-sm font-semibold mb-1">Whale Radar feed live</div>
        <div className="text-xs text-gray-600">Synced feed live</div>
      </div>
    </section>
  );
};

export default SignalFeed;
