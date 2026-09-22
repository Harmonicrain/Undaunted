CREATE TABLE `storepurchases` (
	`tokenHash` text PRIMARY KEY NOT NULL,
	`userId` text NOT NULL,
	`characterId` text NOT NULL,
	`skuId` text NOT NULL,
	`offerHash` text NOT NULL,
	`expiresAt` integer NOT NULL,
	`redeemedAt` integer
);
