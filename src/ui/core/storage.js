export const SETTINGS_OPEN_KEY = "rr-meeting-settings-open";

export function readSessionStorageFlag(key) {
  try {
    return sessionStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

export function writeSessionStorageFlag(key, value) {
  try {
    sessionStorage.setItem(key, value ? "1" : "0");
  } catch {
  }
}
