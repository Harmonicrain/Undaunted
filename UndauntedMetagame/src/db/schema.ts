import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
    userId: text("userId").notNull().primaryKey(),
    name: text("name").notNull(),
    notes: integer("notes").notNull(),
    isAdmin: integer("isAdmin", {mode: "boolean"}).notNull().default(false)
})

// Directed edges keep the Epic friends response (including pending direction)
// stable across relogs. Both sides of an invitation change in one transaction.
export const friends = sqliteTable("friends", {
    ownerId: text("ownerId").notNull(),
    friendId: text("friendId").notNull(),
    status: text("status").notNull(),
    direction: text("direction").notNull(),
    createdAt: text("createdAt").notNull()
}, (Table) => ({ pk: primaryKey({ columns: [Table.ownerId, Table.friendId] }) }));

export const friendblocks = sqliteTable("friendblocks", {
    ownerId: text("ownerId").notNull(),
    blockedId: text("blockedId").notNull(),
    createdAt: text("createdAt").notNull()
}, (Table) => ({ pk: primaryKey({ columns: [Table.ownerId, Table.blockedId] }) }));

export const slayerlinkinvites = sqliteTable("slayerlinkinvites", {
    inviteId: text("inviteId").notNull().primaryKey(),
    senderId: text("senderId").notNull(),
    targetId: text("targetId").notNull(),
    senderSlot: integer("senderSlot").notNull(),
    createdAt: integer("createdAt").notNull(),
    expiresAt: integer("expiresAt").notNull(),
    status: text("status").notNull()
});

// One row per link generation. linkId is the identity everything else binds
// to; a slot number is only an address and is reused by later links.
//
// progress is the link's shared Hunt Pass XP total and the single authority
// for the Linked_Slayer_Slot_N tracks (it is never mirrored into the
// progression table). It only changes together with a slayerlinkxp row.
//
// Each side leaves the link independently: *ReleasedAt frees that player's
// slot once their side is finished, without touching the partner's side.
// canceledAt ends the whole link, which is only allowed before any XP.
export const slayerlinks = sqliteTable("slayerlinks", {
    linkId: text("linkId").notNull().primaryKey(),
    senderId: text("senderId").notNull(),
    targetId: text("targetId").notNull(),
    senderSlot: integer("senderSlot").notNull(),
    targetSlot: integer("targetSlot").notNull(),
    createdAt: integer("createdAt").notNull(),
    endsAt: integer("endsAt").notNull(),
    progress: integer("progress").notNull().default(0),
    canceledAt: integer("canceledAt"),
    senderReleasedAt: integer("senderReleasedAt"),
    targetReleasedAt: integer("targetReleasedAt"),
    senderConfirmedRank: integer("senderConfirmedRank").notNull().default(0),
    targetConfirmedRank: integer("targetConfirmedRank").notNull().default(0)
});

// The prize pool the gameserver rolled for one participant of one link
// (PUT /slayerlink/links/rewards). Fixed once written.
//
// The claim columns are the entitlement guard: they are written in the same
// transaction as the inventory grant that delivered the earned rewards, never
// when the rewards are merely read. servedAt records when the gameserver last
// read this link's rewards; it binds the grant that follows to this link and
// consumes nothing.
export const slayerlinkpools = sqliteTable("slayerlinkpools", {
    linkId: text("linkId").notNull(),
    userId: text("userId").notNull(),
    pool: text("pool").notNull(),
    poolHash: text("poolHash").notNull(),
    createdAt: integer("createdAt").notNull(),
    servedAt: integer("servedAt"),
    claimTransactionId: text("claimTransactionId"),
    claimCharacterId: text("claimCharacterId"),
    claimedRewards: text("claimedRewards"),
    claimedAt: integer("claimedAt")
}, (Table) => ({ pk: primaryKey({ columns: [Table.linkId, Table.userId] }) }));

// Gameserver progression requests already applied, keyed by the stable
// request id the runtime attaches (x-undaunted-request-id). A retried request
// is answered without awarding its XP a second time.
export const progressionrequests = sqliteTable("progressionrequests", {
    requestId: text("requestId").notNull().primaryKey(),
    userId: text("userId").notNull(),
    requestHash: text("requestHash").notNull(),
    appliedAt: integer("appliedAt").notNull()
});

// Every XP contribution applied to a link. The key makes one source award
// count at most once per link.
export const slayerlinkxp = sqliteTable("slayerlinkxp", {
    eventId: text("eventId").notNull(),
    linkId: text("linkId").notNull(),
    sourceUserId: text("sourceUserId").notNull(),
    amount: integer("amount").notNull(),
    source: text("source").notNull(),
    createdAt: integer("createdAt").notNull()
}, (Table) => ({ pk: primaryKey({ columns: [Table.eventId, Table.linkId] }) }));

export const characters = sqliteTable("characters", {
    characterId: text("characterId").notNull().primaryKey(),
    userId: text("userId").notNull(),
    createdDate: text("createdDate").notNull(),
    lastModifiedDate: text("lastModifiedDate").notNull(),
    name: text("name").notNull(),
    updateVersion: integer("updateVersion").notNull(),
    data: text("data").notNull()
});

export const inventory = sqliteTable("inventories", {
    characterId: text("characterId").notNull().primaryKey(),
    instancedItems: text("instancedItems").notNull(),
    stackedItems: text("stackedItems").notNull()
});

export const loadouts = sqliteTable("loadouts", {
    characterId: text("characterId").notNull().primaryKey(),
    userId: text("userId").notNull(),
    loadouts: text("loadouts").notNull(),
    persistent: text("persistent").notNull()
});

export const gameserverapikeys = sqliteTable("gameserverapikeys", {
    id: integer("id").notNull().primaryKey({autoIncrement: true}),
    keyHash: text("keyHash")
});

export const userapikeys = sqliteTable("userapikeys", {
    userId: text("userId").notNull().primaryKey(),
    keyHash: text("keyHash").notNull()
});

export const userapikeystoregister = sqliteTable("userapikeystoregister", {
    userId: text("userId").notNull().primaryKey(),
    key: text("key").notNull()
});

export const gameserverapikeystoregister = sqliteTable("gameserverapikeystoregister", {
    key: text("key").primaryKey()
});

export const breadcrumbs = sqliteTable("breadcrumbs", {
    characterId: text("characterId").notNull().primaryKey(),
    userId: text("userId").notNull(),
    breadcrumbs: text("breadcrumbs").notNull(),
    updateVersion: integer("updateVersion").notNull()
});

export const encounteredcontent = sqliteTable("encounteredcontent", {
    characterId: text("characterId").notNull().primaryKey(),
    userId: text("userId").notNull(),
    encounteredcontent: text("encounteredcontent").notNull()
});

export const invitecodes = sqliteTable("invitecodes", {
    inviteCode: text("invitecode").notNull().primaryKey(),
    usesRemaining: integer("usesRemaining").notNull(),
    infiniteUses: integer("infiniteUses", {mode: "boolean"}).notNull()
});

// Replay ledger for inventory transactions. The client supplies a transactionId
// with every mutation but nothing used it, so a retried or duplicated request
// applied twice. The request hash distinguishes an honest retry (same id, same
// content - return the stored result) from a collision (same id, different
// content - reject rather than guess).
export const inventorytransactions = sqliteTable("inventorytransactions", {
    transactionId: text("transactionId").notNull().primaryKey(),
    userId: text("userId").notNull(),
    characterId: text("characterId").notNull(),
    requestHash: text("requestHash").notNull(),
    result: text("result").notNull(),
    appliedAt: text("appliedAt").notNull()
});

export const storepurchases = sqliteTable("storepurchases", {
    tokenHash: text("tokenHash").notNull().primaryKey(),
    userId: text("userId").notNull(),
    characterId: text("characterId").notNull(),
    skuId: text("skuId").notNull(),
    offerHash: text("offerHash").notNull(),
    expiresAt: integer("expiresAt").notNull(),
    redeemedAt: integer("redeemedAt")
});

// Entitlements held by an account. GET /entitlementsv2 reads this; the store
// redeem path writes it. Field names on the wire are entitlement / duration /
// activatedDate, taken from the 1.4.4 executable's own strings around its
// QueryEntitlements handler.
export const entitlements = sqliteTable("entitlements", {
    userId: text("userId").notNull(),
    entitlement: text("entitlement").notNull(),
    duration: integer("duration").notNull().default(0),
    activatedAt: integer("activatedAt").notNull(),
    source: text("source").notNull()
}, (Table) => ({
    pk: primaryKey({ columns: [Table.userId, Table.entitlement] })
}));

// Hunt Pass and mastery progression. Account-scoped, because the wire key is
// phx_account_id - rewards are delivered to a character, but progress is not.
//
// Rank is deliberately NOT stored. It is derived from totalPoints against the
// active config's requirements at read time, so a config edit cannot leave a
// stored rank disagreeing with the table it came from. The cost is that the
// requirements of a running season must be pinned; changing them is a
// generation bump, not an in-place edit.
//
// generation is bumped by an administrative reset. Resetting by deleting claim
// rows instead would either collide with the inventory replay ledger or
// re-award items the player still holds.
export const progression = sqliteTable("progression", {
    userId: text("userId").notNull(),
    trackId: text("trackId").notNull(),
    generation: integer("generation").notNull().default(0),
    totalPoints: integer("totalPoints").notNull().default(0),
    confirmedRank: integer("confirmedRank").notNull().default(0),
    confirmedPremiumRank: integer("confirmedPremiumRank").notNull().default(0),
    updatedAt: integer("updatedAt").notNull()
}, (Table) => ({
    pk: primaryKey({ columns: [Table.userId, Table.trackId] })
}));

// One row per reward actually handed over. This is the idempotency guard for
// granting: it is written in the same transaction as the inventory change, so
// a retry after a lost response grants nothing further.
//
// characterId records where the reward was delivered, which the key does not
// otherwise capture and which matters when an account later gains or loses
// characters.
export const progressionclaims = sqliteTable("progressionclaims", {
    userId: text("userId").notNull(),
    trackId: text("trackId").notNull(),
    generation: integer("generation").notNull(),
    rankId: integer("rankId").notNull(),
    kind: text("kind").notNull(),
    characterId: text("characterId").notNull(),
    claimedAt: integer("claimedAt").notNull()
}, (Table) => ({
    pk: primaryKey({ columns: [Table.userId, Table.trackId, Table.generation, Table.rankId, Table.kind] })
}));

// Objectives arrive alongside progress_tracks on POST /progression/{account}
// and are the client's record of "this achievement advanced". Stored so that
// the objectives read path can stop being a constant.
export const progressionobjectives = sqliteTable("progressionobjectives", {
    userId: text("userId").notNull(),
    objectiveId: text("objectiveId").notNull(),
    progress: integer("progress").notNull().default(0),
    completedCount: integer("completedCount").notNull().default(0),
    createdAt: integer("createdAt").notNull(),
    updatedAt: integer("updatedAt").notNull()
}, (Table) => ({
    pk: primaryKey({ columns: [Table.userId, Table.objectiveId] })
}));

// Account wallets. Hunt Pass ranks pay out CURRENCY_* rewards, and GET /balance
// answered with literal zeros for every currency except notes, so a stacked
// item grant could never show up there. Currencies are account-scoped, unlike
// inventory which is per character.
export const wallets = sqliteTable("wallets", {
    userId: text("userId").notNull(),
    currencyId: text("currencyId").notNull(),
    amount: integer("amount").notNull().default(0),
    updatedAt: integer("updatedAt").notNull()
}, (Table) => ({
    pk: primaryKey({ columns: [Table.userId, Table.currencyId] })
}));

// Bounties, as the client last sent them. POST /bounty/{account} accepted the
// payload and discarded it, so drafted bounties never survived a relog.
//
// The whole payload is stored verbatim rather than modelled column by column:
// the server does not yet author bounties, it only needs to give back what it
// was handed. Modelling can follow once bounty_data is populated and the server
// has an opinion about what a valid bounty is.
export const bounties = sqliteTable("bounties", {
    userId: text("userId").notNull().primaryKey(),
    payload: text("payload").notNull(),
    updatedAt: integer("updatedAt").notNull()
});

// Per-account cooldowns, keyed by the client's tracking id.
//
// These look incidental but the bounty system depends on them. The gameserver
// records when it last granted bounty tokens in a cooldown; on login,
// ServerInitializeBounties reads it back to decide whether this is a new
// bounty season. GET /cooldown returned an empty object and the batch write
// was discarded, so the marker was never found, every login was treated as a
// new season, tokens were revoked and regranted, and stored bounties were
// never recreated - which looked exactly like bounties failing to save.
// Escalation season state, one row per account and season.
//
// The world server owns the arithmetic: it levels the player, spends talent
// points and hands out rewards natively, then POSTs the whole season snapshot.
// These tables hold the last accepted snapshot. level and xp are the native
// representation exactly (xp is accumulated inside the current level), and
// updateVersion is the native counter the gameserver increments before every
// POST. See research/escalation/PROTOCOL.md.
export const escalationprogression = sqliteTable("escalationprogression", {
    userId: text("userId").notNull(),
    seasonId: text("seasonId").notNull(),
    level: integer("level").notNull().default(0),
    xp: integer("xp").notNull().default(0),
    updateVersion: integer("updateVersion").notNull().default(0),
    contentRevision: text("contentRevision").notNull(),
    requestHash: text("requestHash").notNull(),
    updatedAt: integer("updatedAt").notNull()
}, (Table) => ({
    pk: primaryKey({ columns: [Table.userId, Table.seasonId] })
}));

// Purchased talent ranks. Spent points are derived from the season's rank
// costs, never stored as a separate balance.
export const escalationtalents = sqliteTable("escalationtalents", {
    userId: text("userId").notNull(),
    seasonId: text("seasonId").notNull(),
    talentId: text("talentId").notNull(),
    rank: integer("rank").notNull()
}, (Table) => ({
    pk: primaryKey({ columns: [Table.userId, Table.seasonId, Table.talentId] })
}));

// Collected unlocks. Whether an unlock is unlocked is derived natively from
// the level; only collection is state. The items themselves are granted by the
// world server through the inventory path, so this is a record, not a grant.
export const escalationunlocks = sqliteTable("escalationunlocks", {
    userId: text("userId").notNull(),
    seasonId: text("seasonId").notNull(),
    unlockId: text("unlockId").notNull(),
    collectedAt: integer("collectedAt").notNull()
}, (Table) => ({
    pk: primaryKey({ columns: [Table.userId, Table.seasonId, Table.unlockId] })
}));

// Every accepted snapshot, keyed by its native version. Lets an exact retry be
// answered as a replay and a reused version with different content be refused.
export const escalationevents = sqliteTable("escalationevents", {
    userId: text("userId").notNull(),
    seasonId: text("seasonId").notNull(),
    updateVersion: integer("updateVersion").notNull(),
    requestHash: text("requestHash").notNull(),
    level: integer("level").notNull(),
    xp: integer("xp").notNull(),
    createdAt: integer("createdAt").notNull()
}, (Table) => ({
    pk: primaryKey({ columns: [Table.userId, Table.seasonId, Table.updateVersion] })
}));

export const cooldowns = sqliteTable("cooldowns", {
    userId: text("userId").notNull(),
    cooldownId: text("cooldownId").notNull(),
    startedDate: text("startedDate").notNull(),
    updatedAt: integer("updatedAt").notNull()
}, (Table) => ({
    pk: primaryKey({ columns: [Table.userId, Table.cooldownId] })
}));

// Successful link mutations and their replies commit together. Replaying a
// processed request must never resolve its slot against a newer link.
export const slayerlinkrequests = sqliteTable("slayerlinkrequests", {
    actor: text("actor").notNull(),
    requestId: text("requestId").notNull(),
    requestHash: text("requestHash").notNull(),
    response: text("response").notNull(),
    appliedAt: integer("appliedAt").notNull()
}, (Table) => ({ pk: primaryKey({ columns: [Table.actor, Table.requestId] }) }));

// Player Journey (Slayer's Path) node map for the 1.12.0 client. The
// gameserver saves the whole map with an update_version (POST /pjm/{account});
// the client and the gameserver read it back (GET /pjm, GET /pjm/{account}).
export const playerjourney = sqliteTable("playerjourney", {
    userId: text("userId").notNull().primaryKey(),
    nodes: text("nodes").notNull(),
    updateVersion: integer("updateVersion").notNull(),
    updatedAt: integer("updatedAt").notNull()
});
