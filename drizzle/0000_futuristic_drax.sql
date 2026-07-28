CREATE TABLE `public_ai_usage` (
	`scope` text NOT NULL,
	`bucket` text NOT NULL,
	`count` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`scope`, `bucket`)
);
