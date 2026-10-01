## Reset strategy to Chart Trader

Run your SQL as a one-off data change. No code changes.

### Steps
1. Update the strategy settings (row 1) to:
   - Whale 0.5, Technicals 2.0, Prediction 0.5, Council 0.5
   - Preset: `chart-trader`
   - Note: "Manual reset to chart-trader after custom override"
   - Updated time: now
2. Read the row back to confirm the saved values, the auto-switch setting, and the time of the last auto-switch.
3. Report the result. Refreshing the preview clears the "UNSAVED" ×2.9 draft in the Strategy Weights panel, which should then show "Chart Trader".

### Note
If Auto-adaptive strategy is ON, the AI can change the preset again at its next check.
