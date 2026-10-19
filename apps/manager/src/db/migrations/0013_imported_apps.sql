CREATE TABLE `imported_app_workers` (
	`account_id` text NOT NULL,
	`worker_name` text NOT NULL,
	`app_id` text NOT NULL,
	PRIMARY KEY(`account_id`, `worker_name`),
	FOREIGN KEY (`app_id`) REFERENCES `imported_apps`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `imported_app_workers_app_id_idx` ON `imported_app_workers` (`app_id`);--> statement-breakpoint
CREATE TABLE `imported_apps` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`display_name` text NOT NULL,
	`primary_worker` text NOT NULL,
	`inventory_json` text NOT NULL,
	`imported_at` integer NOT NULL,
	`refreshed_at` integer NOT NULL
);
