-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Group" (
    "code" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ownerId" TEXT,
    "shuttleToolsEnabled" BOOLEAN NOT NULL DEFAULT false,
    "crossSessionHistory" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "Group_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Group" ("code", "createdAt", "name", "ownerId") SELECT "code", "createdAt", "name", "ownerId" FROM "Group";
DROP TABLE "Group";
ALTER TABLE "new_Group" RENAME TO "Group";
CREATE TABLE "new_Session" (
    "code" TEXT NOT NULL PRIMARY KEY,
    "groupId" TEXT NOT NULL,
    "date" TEXT,
    "venue" TEXT,
    "courtCount" INTEGER,
    "rawImportText" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" DATETIME,
    "mode" TEXT NOT NULL DEFAULT 'variety',
    "courtFormats" TEXT,
    "courtModes" TEXT,
    "courtLabels" TEXT,
    "shuttleToolsEnabled" BOOLEAN NOT NULL DEFAULT false,
    "crossSessionHistory" BOOLEAN NOT NULL DEFAULT false,
    "shuttleCount" INTEGER,
    "shuttlePriceSatang" INTEGER,
    "billConfig" TEXT,
    "disabledRuleIds" TEXT DEFAULT '[]',
    CONSTRAINT "Session_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group" ("code") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Session" ("billConfig", "code", "courtCount", "courtFormats", "courtLabels", "courtModes", "createdAt", "date", "disabledRuleIds", "endedAt", "groupId", "mode", "rawImportText", "shuttleCount", "shuttlePriceSatang", "venue") SELECT "billConfig", "code", "courtCount", "courtFormats", "courtLabels", "courtModes", "createdAt", "date", "disabledRuleIds", "endedAt", "groupId", "mode", "rawImportText", "shuttleCount", "shuttlePriceSatang", "venue" FROM "Session";
DROP TABLE "Session";
ALTER TABLE "new_Session" RENAME TO "Session";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
