CREATE TABLE `slayerlinkpools` (
	`linkId` text NOT NULL,
	`userId` text NOT NULL,
	`pool` text NOT NULL,
	`poolHash` text NOT NULL,
	`createdAt` integer NOT NULL,
	`claimTransactionId` text,
	`claimCharacterId` text,
	`claimedRewards` text,
	`claimedAt` integer,
	PRIMARY KEY(`linkId`, `userId`)
);
--> statement-breakpoint
CREATE TABLE `slayerlinkxp` (
	`eventId` text NOT NULL,
	`linkId` text NOT NULL,
	`sourceUserId` text NOT NULL,
	`amount` integer NOT NULL,
	`source` text NOT NULL,
	`createdAt` integer NOT NULL,
	PRIMARY KEY(`eventId`, `linkId`)
);
--> statement-breakpoint
ALTER TABLE `slayerlinks` ADD `canceledAt` integer;--> statement-breakpoint
ALTER TABLE `slayerlinks` ADD `senderReleasedAt` integer;--> statement-breakpoint
ALTER TABLE `slayerlinks` ADD `targetReleasedAt` integer;--> statement-breakpoint
ALTER TABLE `slayerlinks` ADD `senderConfirmedRank` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `slayerlinks` ADD `targetConfirmedRank` integer DEFAULT 0 NOT NULL;