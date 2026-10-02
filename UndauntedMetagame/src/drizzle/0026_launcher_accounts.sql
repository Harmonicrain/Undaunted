CREATE TABLE `launchercredentials` (
	`userId` text PRIMARY KEY NOT NULL,
	`usernameNormalized` text NOT NULL,
	`passwordHash` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `launchercredentials_usernameNormalized_unique` ON `launchercredentials` (`usernameNormalized`);--> statement-breakpoint
CREATE TABLE `launcherexchanges` (
	`codeHash` text PRIMARY KEY NOT NULL,
	`userId` text NOT NULL,
	`sessionId` text NOT NULL,
	`expiresAt` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `launchersessions` (
	`sessionId` text PRIMARY KEY NOT NULL,
	`userId` text NOT NULL,
	`accessHash` text NOT NULL,
	`accessExpiresAt` integer NOT NULL,
	`refreshHash` text NOT NULL,
	`refreshExpiresAt` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `launchersessions_accessHash_unique` ON `launchersessions` (`accessHash`);--> statement-breakpoint
CREATE UNIQUE INDEX `launchersessions_refreshHash_unique` ON `launchersessions` (`refreshHash`);