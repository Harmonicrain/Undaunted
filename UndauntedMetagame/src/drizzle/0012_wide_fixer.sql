CREATE TABLE `entitlements` (
	`userId` text NOT NULL,
	`entitlement` text NOT NULL,
	`duration` integer DEFAULT 0 NOT NULL,
	`activatedAt` integer NOT NULL,
	`source` text NOT NULL,
	PRIMARY KEY(`userId`, `entitlement`)
);
