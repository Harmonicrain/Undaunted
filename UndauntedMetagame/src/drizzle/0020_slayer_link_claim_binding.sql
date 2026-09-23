CREATE TABLE `progressionrequests` (
	`requestId` text PRIMARY KEY NOT NULL,
	`userId` text NOT NULL,
	`requestHash` text NOT NULL,
	`appliedAt` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `slayerlinkpools` ADD `servedAt` integer;