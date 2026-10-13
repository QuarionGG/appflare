-- Channels made before a failed pause was news hear about it too: each one's
-- saved events gain `app_pause_failed` (pausing an app did not finish, so it
-- may still be running), which new channels get by default. An events list
-- that does not read as JSON is left as it is.
UPDATE `notification_channels`
SET `events_json` = (
  SELECT json_group_array(`value`) FROM (
    SELECT `value` FROM json_each(`notification_channels`.`events_json`)
    UNION ALL
    SELECT 'app_pause_failed'
    WHERE 'app_pause_failed' NOT IN (SELECT `value` FROM json_each(`notification_channels`.`events_json`))
  )
)
WHERE json_valid(`events_json`) AND json_type(`events_json`) = 'array';
