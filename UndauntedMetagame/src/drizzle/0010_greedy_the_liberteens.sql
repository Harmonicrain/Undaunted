-- Hand-trimmed from the drizzle-kit output.
--
-- drizzle-kit additionally emitted full table rebuilds (create __new_, copy,
-- DROP TABLE, rename) for `users` and `invitecodes`. Those exist only to change
-- the declared column type of two boolean columns from `boolean` to `integer`.
-- SQLite gives `boolean` NUMERIC affinity and `integer` INTEGER affinity, and
-- for the 0/1 values stored here the behaviour is identical, so the rebuild buys
-- nothing and would DROP the table holding every account.
--
-- The rebuild statements were removed. Keeping this migration purely additive.
-- The drift is pre-existing and harmless, but it is now also invisible to
-- `db:generate`, so a deliberate, tested rebuild is the right way to fix it if
-- it is ever worth fixing - not as a side effect of adding a table.
-- Original generated file kept alongside as .drizzle-generated.

CREATE TABLE `inventorytransactions` (
	`transactionId` text PRIMARY KEY NOT NULL,
	`userId` text NOT NULL,
	`characterId` text NOT NULL,
	`requestHash` text NOT NULL,
	`result` text NOT NULL,
	`appliedAt` text NOT NULL
);
