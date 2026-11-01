-- CreateTable
CREATE TABLE "LineAccount" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "lineUserId" TEXT NOT NULL,
    "displayName" TEXT,
    "pictureUrl" TEXT,
    "profileAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "LineAccountGroup" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "groupId" TEXT NOT NULL,
    "lineAccountId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "firstSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LineAccountGroup_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group" ("code") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "LineAccountGroup_lineAccountId_fkey" FOREIGN KEY ("lineAccountId") REFERENCES "LineAccount" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex (moved up: the backfill below and the PlayerLineAccount foreign key need it)
CREATE UNIQUE INDEX "LineAccount_lineUserId_key" ON "LineAccount"("lineUserId");

-- CreateIndex
CREATE INDEX "LineAccountGroup_lastSeenAt_idx" ON "LineAccountGroup"("lastSeenAt");

-- CreateIndex
CREATE UNIQUE INDEX "LineAccountGroup_groupId_lineAccountId_key" ON "LineAccountGroup"("groupId", "lineAccountId");

-- Backfill (hand-written). Every (group, LINE user) already known from the three tables that hold one:
-- a player link (source 'claim' for a self link, 'host' for a host link), a slip held for the host ('slip'), and a
-- roster posted in a linked LINE group ('roster'; a host's direct message to the bot is not a group sighting).
-- `namePriority` orders where a name or picture is taken from: a slip's LINE profile, then the link, then the roster.
CREATE TEMP VIEW "_LineSeen" AS
    SELECT "groupId", "lineUserId", "displayName", NULL AS "pictureUrl", "createdAt" AS "seenAt",
           CASE "linkedBy" WHEN 'self' THEN 'claim' ELSE 'host' END AS "source", 2 AS "namePriority"
    FROM "PlayerLineAccount"
    UNION ALL
    SELECT "groupId", "lineUserId", "displayName", "pictureUrl", "createdAt", 'slip', 1
    FROM "PendingSlip"
    UNION ALL
    SELECT "groupId", "senderUserId", "senderName", NULL, "postedAt", 'roster', 3
    FROM "LineRosterMessage"
    WHERE "direct" = 0 AND "senderUserId" IS NOT NULL;

INSERT INTO "LineAccount" ("id", "lineUserId", "displayName", "pictureUrl", "createdAt", "updatedAt")
SELECT
    lower(hex(randomblob(12))),
    u."lineUserId",
    (SELECT s."displayName" FROM "_LineSeen" s
       WHERE s."lineUserId" = u."lineUserId" AND s."displayName" IS NOT NULL AND s."displayName" <> ''
       ORDER BY s."namePriority", s."seenAt" DESC LIMIT 1),
    (SELECT s."pictureUrl" FROM "_LineSeen" s
       WHERE s."lineUserId" = u."lineUserId" AND s."pictureUrl" IS NOT NULL AND s."pictureUrl" <> ''
       ORDER BY s."namePriority", s."seenAt" DESC LIMIT 1),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM (SELECT DISTINCT "lineUserId" FROM "_LineSeen") u;

INSERT INTO "LineAccountGroup" ("id", "groupId", "lineAccountId", "source", "firstSeenAt", "lastSeenAt")
SELECT
    lower(hex(randomblob(12))),
    g."groupId",
    a."id",
    (SELECT s."source" FROM "_LineSeen" s
       WHERE s."groupId" = g."groupId" AND s."lineUserId" = g."lineUserId"
       ORDER BY s."seenAt", s."namePriority" LIMIT 1),
    g."firstSeenAt",
    g."lastSeenAt"
FROM (
    SELECT "groupId", "lineUserId", min("seenAt") AS "firstSeenAt", max("seenAt") AS "lastSeenAt"
    FROM "_LineSeen" GROUP BY "groupId", "lineUserId"
) g
JOIN "LineAccount" a ON a."lineUserId" = g."lineUserId";

-- Dropped before the rebuild: the view reads the PlayerLineAccount table being replaced.
DROP VIEW "_LineSeen";

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_PlayerLineAccount" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "groupId" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "lineUserId" TEXT NOT NULL,
    "linkedBy" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PlayerLineAccount_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group" ("code") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PlayerLineAccount_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PlayerLineAccount_lineUserId_fkey" FOREIGN KEY ("lineUserId") REFERENCES "LineAccount" ("lineUserId") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_PlayerLineAccount" ("createdAt", "groupId", "id", "lineUserId", "linkedBy", "playerId") SELECT "createdAt", "groupId", "id", "lineUserId", "linkedBy", "playerId" FROM "PlayerLineAccount";
DROP TABLE "PlayerLineAccount";
ALTER TABLE "new_PlayerLineAccount" RENAME TO "PlayerLineAccount";
CREATE UNIQUE INDEX "PlayerLineAccount_groupId_lineUserId_key" ON "PlayerLineAccount"("groupId", "lineUserId");
CREATE UNIQUE INDEX "PlayerLineAccount_groupId_playerId_key" ON "PlayerLineAccount"("groupId", "playerId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
