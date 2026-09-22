CREATE TABLE `slayerlinkinvites` (
	`inviteId` text PRIMARY KEY NOT NULL,
	`senderId` text NOT NULL,
	`targetId` text NOT NULL,
	`senderSlot` integer NOT NULL,
	`createdAt` integer NOT NULL,
	`expiresAt` integer NOT NULL,
	`status` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `slayerlinks` (
	`linkId` text PRIMARY KEY NOT NULL,
	`senderId` text NOT NULL,
	`targetId` text NOT NULL,
	`senderSlot` integer NOT NULL,
	`targetSlot` integer NOT NULL,
	`createdAt` integer NOT NULL,
	`endsAt` integer NOT NULL,
	`progress` integer DEFAULT 0 NOT NULL
);
