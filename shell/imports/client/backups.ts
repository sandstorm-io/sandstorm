import downloadFile from '/imports/client/download-file.js';
import { meteorCallPromise } from '/imports/client/meteor-call-promise.ts';

// TODO: can we move this somewhere more centralized/does meteor provide
// type declarations for this somewhere?
declare var __meteor_runtime_config__: {
  DDP_DEFAULT_CONNECTION_URL?: string;
}

export function makeAndDownloadBackup(grainId: string, grainTitle: string): Promise<void> {
  return meteorCallPromise("backupGrain", grainId).then((id) => {
    const origin = __meteor_runtime_config__.DDP_DEFAULT_CONNECTION_URL || "";
    const url = origin + "/downloadBackup/" + id;
    const suggestedFilename = grainTitle + ".zip";
    downloadFile(url, suggestedFilename);
  })
}
