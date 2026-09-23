CREATE TABLE `slayerlinkrequests` (
	`actor` text NOT NULL,
	`requestId` text NOT NULL,
	`requestHash` text NOT NULL,
	`response` text NOT NULL,
	`appliedAt` integer NOT NULL,
	PRIMARY KEY(`actor`, `requestId`)
);
