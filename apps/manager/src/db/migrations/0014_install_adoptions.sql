CREATE TABLE `install_adoptions` (
	`install_id` text PRIMARY KEY NOT NULL,
	`imported_app_id` text NOT NULL,
	`app_name` text NOT NULL,
	`primary_url` text,
	`inventory_json` text NOT NULL,
	`adopted_at` integer NOT NULL,
	FOREIGN KEY (`install_id`) REFERENCES `installs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `install_adoptions_imported_app_id_unique` ON `install_adoptions` (`imported_app_id`);