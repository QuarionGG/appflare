CREATE TABLE `emdash_upgrades` (
	`id` text PRIMARY KEY NOT NULL,
	`install_id` text NOT NULL,
	`repo` text NOT NULL,
	`base_ref` text NOT NULL,
	`base_sha` text NOT NULL,
	`target_version` text NOT NULL,
	`status` text NOT NULL,
	`preparation_job_id` text NOT NULL,
	`build_id` text,
	`merged_build_id` text,
	`write_token_id` text,
	`branch` text,
	`head_sha` text,
	`pr_number` integer,
	`pr_url` text,
	`merge_sha` text,
	`report_json` text,
	`error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`install_id`) REFERENCES `installs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `emdash_upgrades_install_id_idx` ON `emdash_upgrades` (`install_id`);--> statement-breakpoint
CREATE INDEX `emdash_upgrades_build_id_idx` ON `emdash_upgrades` (`build_id`);--> statement-breakpoint
ALTER TABLE `github_tokens` ADD `for_repository_updates` integer DEFAULT false NOT NULL;