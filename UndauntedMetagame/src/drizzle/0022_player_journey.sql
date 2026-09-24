CREATE TABLE `playerjourney` (
	`userId` text PRIMARY KEY NOT NULL,
	`nodes` text NOT NULL,
	`updateVersion` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
