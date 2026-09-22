CREATE TABLE `escalationevents` (
	`userId` text NOT NULL,
	`seasonId` text NOT NULL,
	`updateVersion` integer NOT NULL,
	`requestHash` text NOT NULL,
	`level` integer NOT NULL,
	`xp` integer NOT NULL,
	`createdAt` integer NOT NULL,
	PRIMARY KEY(`userId`, `seasonId`, `updateVersion`)
);
--> statement-breakpoint
CREATE TABLE `escalationprogression` (
	`userId` text NOT NULL,
	`seasonId` text NOT NULL,
	`level` integer DEFAULT 0 NOT NULL,
	`xp` integer DEFAULT 0 NOT NULL,
	`updateVersion` integer DEFAULT 0 NOT NULL,
	`contentRevision` text NOT NULL,
	`requestHash` text NOT NULL,
	`updatedAt` integer NOT NULL,
	PRIMARY KEY(`userId`, `seasonId`)
);
--> statement-breakpoint
CREATE TABLE `escalationtalents` (
	`userId` text NOT NULL,
	`seasonId` text NOT NULL,
	`talentId` text NOT NULL,
	`rank` integer NOT NULL,
	PRIMARY KEY(`userId`, `seasonId`, `talentId`)
);
--> statement-breakpoint
CREATE TABLE `escalationunlocks` (
	`userId` text NOT NULL,
	`seasonId` text NOT NULL,
	`unlockId` text NOT NULL,
	`collectedAt` integer NOT NULL,
	PRIMARY KEY(`userId`, `seasonId`, `unlockId`)
);
