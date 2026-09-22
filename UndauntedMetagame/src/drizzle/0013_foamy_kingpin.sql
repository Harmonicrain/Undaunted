CREATE TABLE `progression` (
	`userId` text NOT NULL,
	`trackId` text NOT NULL,
	`generation` integer DEFAULT 0 NOT NULL,
	`totalPoints` integer DEFAULT 0 NOT NULL,
	`confirmedRank` integer DEFAULT 0 NOT NULL,
	`confirmedPremiumRank` integer DEFAULT 0 NOT NULL,
	`updatedAt` integer NOT NULL,
	PRIMARY KEY(`userId`, `trackId`)
);
--> statement-breakpoint
CREATE TABLE `progressionclaims` (
	`userId` text NOT NULL,
	`trackId` text NOT NULL,
	`generation` integer NOT NULL,
	`rankId` integer NOT NULL,
	`kind` text NOT NULL,
	`characterId` text NOT NULL,
	`claimedAt` integer NOT NULL,
	PRIMARY KEY(`userId`, `trackId`, `generation`, `rankId`, `kind`)
);
--> statement-breakpoint
CREATE TABLE `progressionobjectives` (
	`userId` text NOT NULL,
	`objectiveId` text NOT NULL,
	`progress` integer DEFAULT 0 NOT NULL,
	`completedCount` integer DEFAULT 0 NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	PRIMARY KEY(`userId`, `objectiveId`)
);
