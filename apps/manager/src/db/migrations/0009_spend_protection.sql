CREATE TABLE `app_pauses` (
	`id` text PRIMARY KEY NOT NULL,
	`install_id` text NOT NULL,
	`paused_at` integer NOT NULL,
	`paused_by` text NOT NULL,
	`reason` text NOT NULL,
	`detail_json` text,
	`worker_versions_json` text,
	`containers_json` text,
	`queues_json` text,
	`workflows_json` text,
	`job_id` text,
	`resume_job_id` text,
	`resumed_at` integer,
	`resumed_by` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `app_pauses_open_idx` ON `app_pauses` (`install_id`) WHERE resumed_at IS NULL;--> statement-breakpoint
CREATE TABLE `app_spend_settings` (
	`install_id` text PRIMARY KEY NOT NULL,
	`unusual_factor` integer,
	`auto_pause` text DEFAULT 'default' NOT NULL,
	`custom_triggers` integer DEFAULT false NOT NULL,
	`loop_on` integer DEFAULT true NOT NULL,
	`loop_level` text,
	`cap_on` integer DEFAULT true NOT NULL,
	`cap_amount` real,
	`cap_period` text DEFAULT 'day' NOT NULL,
	`budget_exempt` integer DEFAULT false NOT NULL,
	`cap_set_aside_until` integer,
	`updated_at` integer NOT NULL,
	`updated_by` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `app_usage_state` (
	`install_id` text PRIMARY KEY NOT NULL,
	`loop_checks` integer DEFAULT 0 NOT NULL,
	`unusual_since` integer,
	`limit_warned_day` integer,
	`last_checked_at` integer,
	`last_burn` real,
	`normal_burn` real
);
--> statement-breakpoint
CREATE TABLE `usage_activity` (
	`id` text PRIMARY KEY NOT NULL,
	`install_id` text,
	`at` integer NOT NULL,
	`kind` text NOT NULL,
	`by` text,
	`facts_json` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `usage_activity_install_at_idx` ON `usage_activity` (`install_id`,`at`);--> statement-breakpoint
CREATE INDEX `usage_activity_at_idx` ON `usage_activity` (`at`);--> statement-breakpoint
CREATE TABLE `usage_alert_firings` (
	`rule_id` text NOT NULL,
	`period_start` integer NOT NULL,
	`fired_at` integer NOT NULL,
	`value` real NOT NULL,
	PRIMARY KEY(`rule_id`, `period_start`)
);
--> statement-breakpoint
CREATE TABLE `usage_alert_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`install_id` text NOT NULL,
	`kind` text NOT NULL,
	`unit` text NOT NULL,
	`amount` real NOT NULL,
	`period` text NOT NULL,
	`created_at` integer NOT NULL,
	`created_by` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `usage_alert_rules_install_id_idx` ON `usage_alert_rules` (`install_id`);--> statement-breakpoint
CREATE TABLE `usage_daily` (
	`install_id` text NOT NULL,
	`product` text NOT NULL,
	`day` integer NOT NULL,
	`value` real NOT NULL,
	PRIMARY KEY(`install_id`, `product`, `day`)
);
--> statement-breakpoint
CREATE INDEX `usage_daily_install_day_idx` ON `usage_daily` (`install_id`,`day`);--> statement-breakpoint
CREATE INDEX `usage_daily_day_idx` ON `usage_daily` (`day`);--> statement-breakpoint
CREATE TABLE `usage_hourly` (
	`install_id` text NOT NULL,
	`product` text NOT NULL,
	`hour` integer NOT NULL,
	`value` real NOT NULL,
	PRIMARY KEY(`install_id`, `product`, `hour`)
);
--> statement-breakpoint
CREATE INDEX `usage_hourly_install_hour_idx` ON `usage_hourly` (`install_id`,`hour`);--> statement-breakpoint
CREATE INDEX `usage_hourly_hour_idx` ON `usage_hourly` (`hour`);