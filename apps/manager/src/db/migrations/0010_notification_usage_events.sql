-- Channels made before spend protection hear about it too: each one's saved
-- events gain the six spend protection events it does not have yet (an app's
-- unusual usage, a usage alert, a free daily limit running out, an app paused
-- or resumed, the monthly budget reached), which new channels get by default.
-- An events list that does not read as JSON is left as it is.
UPDATE `notification_channels`
SET `events_json` = (
  SELECT json_group_array(`value`) FROM (
    SELECT `value` FROM json_each(`notification_channels`.`events_json`)
    UNION ALL
    SELECT `value` FROM json_each('["usage_unusual","usage_alert","usage_limit_near","app_paused","app_resumed","budget_reached"]')
    WHERE `value` NOT IN (SELECT `value` FROM json_each(`notification_channels`.`events_json`))
  )
)
WHERE json_valid(`events_json`) AND json_type(`events_json`) = 'array';
