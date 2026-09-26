CREATE TABLE `bountyretirements` (
	`userId` text NOT NULL,
	`bountyId` text NOT NULL,
	`draftedAt` integer NOT NULL,
	PRIMARY KEY(`userId`, `bountyId`)
);
