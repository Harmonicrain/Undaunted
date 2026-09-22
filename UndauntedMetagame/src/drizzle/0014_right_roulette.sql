CREATE TABLE `bounties` (
	`userId` text PRIMARY KEY NOT NULL,
	`payload` text NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `wallets` (
	`userId` text NOT NULL,
	`currencyId` text NOT NULL,
	`amount` integer DEFAULT 0 NOT NULL,
	`updatedAt` integer NOT NULL,
	PRIMARY KEY(`userId`, `currencyId`)
);
