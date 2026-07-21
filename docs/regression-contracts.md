# Regression contracts

`contracts/regression-contracts.json` is the release ledger for previously reported or high-risk behavior. A refactor may change implementation details, but it must not remove a contract, its executable evidence, or its release gate.

Rules:

1. Add a contract before fixing a newly reported regression.
2. Browser-visible behavior must point to a real Chrome result validated by `scripts/ui-stability-agent.js`.
3. `npm test` must pass on both the raw baseline and every opt-in replacement path before that replacement can become the default.
4. Raw xterm remains available as the rollback path until the replacement is explicitly accepted and has completed a real-session soak.
5. Tests use isolated data, tmux, and Chrome profiles. They must never attach to or mutate a user's live session.

Composer V2 is currently a dark launch. Open `/?input=v2` to enable the native bidirectional text composer, or `/?input=v2-raw` to keep the V2 switch visible while starting in raw-key mode. With no `input` query parameter, the existing raw xterm path remains unchanged.
