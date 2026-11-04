import fs from "node:fs";

import { SANDSTORM_ALTHOME } from "/imports/server/constants";
import { isTesting } from "/imports/shared/testing";

export function checkMigrationTestFailure(migrationNumber) {
  if (!isTesting) return;

  // Native Sandstorm sandboxes the shell with the installation root at `/`. Development
  // launchers can instead expose an absolute alternate home through Meteor settings.
  const failpointPath = `${SANDSTORM_ALTHOME || ""}/var/migration-test-failure`;
  let configuredMigration;
  try {
    configuredMigration = fs.readFileSync(failpointPath, "utf8").trim();
  } catch (err) {
    if (err.code === "ENOENT") return;
    throw err;
  }

  if (configuredMigration === String(migrationNumber)) {
    throw new Error(`Intentional test failure before migration ${migrationNumber}`);
  }
}
