CREATE TABLE `cooldowns` (
	`userId` text NOT NULL,
	`cooldownId` text NOT NULL,
	`startedDate` text NOT NULL,
	`updatedAt` integer NOT NULL,
	PRIMARY KEY(`userId`, `cooldownId`)
);
