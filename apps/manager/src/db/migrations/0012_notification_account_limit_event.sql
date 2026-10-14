-- Channels made before the account-level free limit warning that hear about
-- an app's free daily limit running out (`usage_limit_near`) hear about the
-- account's too: their saved events gain `usage_account_limit` (on Workers
-- Free, the whole account used 90% of a free daily limit, whatever used it),
-- which new channels get by default. A channel that left free limits out
-- stays as it is, and so does an events list that does not read as JSON.
UPDATE `notification_channels`
SET `events_json` = (
  SELECT json_group_array(`value`) FROM (
    SELECT `value` FROM json_each(`notification_channels`.`events_json`)
    UNION ALL
    SELECT 'usage_account_limit'
    WHERE 'usage_account_limit' NOT IN (SELECT `value` FROM json_each(`notification_channels`.`events_json`))
  )
)
WHERE json_valid(`events_json`) AND json_type(`events_json`) = 'array'
  AND 'usage_limit_near' IN (SELECT `value` FROM json_each(`notification_channels`.`events_json`));
