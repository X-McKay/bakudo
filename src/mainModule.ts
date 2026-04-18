import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const isMainModule = (importMetaUrl: string, argv1: string | undefined): boolean => {
  if (!argv1) {
    return false;
  }

  const directHref = pathToFileURL(argv1).href;
  if (importMetaUrl === directHref) {
    return true;
  }

  try {
    return importMetaUrl === pathToFileURL(realpathSync(argv1)).href;
  } catch {
    return false;
  }
};
