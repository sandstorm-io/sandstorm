import downloadFile from "/imports/client/download-file";
import { meteorCallPromise } from "/imports/client/meteor-call-promise";

// TODO: can we move this somewhere more centralized/does meteor provide
// type declarations for this somewhere?
declare var __meteor_runtime_config__: {
  DDP_DEFAULT_CONNECTION_URL?: string;
}

export function makeAndDownloadBackup(grainId: string, suggestedFilename: string): Promise<void> {
  // Make a backup and then download it. 'suggestedFileName' is the file name
  // to save as, minus the .zip suffix.

  return meteorCallPromise("backupGrain", grainId).then((id) => {
    const origin = __meteor_runtime_config__.DDP_DEFAULT_CONNECTION_URL || "";
    const url = origin + "/downloadBackup/" + id;
    downloadFile(url, suggestedFilename + ".zip");
  })
}
