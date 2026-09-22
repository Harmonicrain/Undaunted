CREATE TABLE `friendblocks` (
	`ownerId` text NOT NULL,
	`blockedId` text NOT NULL,
	`createdAt` text NOT NULL,
	PRIMARY KEY(`ownerId`, `blockedId`)
);
--> statement-breakpoint
CREATE TABLE `friends` (
	`ownerId` text NOT NULL,
	`friendId` text NOT NULL,
	`status` text NOT NULL,
	`direction` text NOT NULL,
	`createdAt` text NOT NULL,
	PRIMARY KEY(`ownerId`, `friendId`)
);
