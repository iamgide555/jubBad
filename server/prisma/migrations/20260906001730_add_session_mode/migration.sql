-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
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
    CONSTRAINT "Session_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group" ("code") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Session" ("code", "courtCount", "createdAt", "date", "endedAt", "groupId", "rawImportText", "venue") SELECT "code", "courtCount", "createdAt", "date", "endedAt", "groupId", "rawImportText", "venue" FROM "Session";
DROP TABLE "Session";
ALTER TABLE "new_Session" RENAME TO "Session";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
