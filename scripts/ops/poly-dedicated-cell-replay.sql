-- Direct candidate-only replay of the pre-fix latest-position projection.
-- Intentionally bypasses the app, its actor serialization, and HTTP throttles.
SELECT p.trader_wallet_id,
       p.condition_id,
       p.token_id,
       p.shares,
       p.current_value_usdc,
       p.raw
FROM poly_trader_position_snapshots AS p
JOIN (
  SELECT trader_wallet_id, condition_id, token_id, max(captured_at) AS captured_at
  FROM poly_trader_position_snapshots
  GROUP BY trader_wallet_id, condition_id, token_id
) AS latest
  ON latest.trader_wallet_id = p.trader_wallet_id
 AND latest.condition_id = p.condition_id
 AND latest.token_id = p.token_id
 AND latest.captured_at = p.captured_at
ORDER BY p.captured_at DESC;
