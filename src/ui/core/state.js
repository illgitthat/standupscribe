import { SETTINGS_OPEN_KEY, readSessionStorageFlag } from "./storage.js";

export function createUiState() {
  return {
    activeMeetingTab: "notes",
    busy: false,
    currentState: null,
    onboardingComplete: false,
    refreshPromise: null,
    settings: null,
    settingsOpen: readSessionStorageFlag(SETTINGS_OPEN_KEY),
    speakerDiarizationStatus: null,
    setupStatus: null,
    transcriptionProfile: null,
  };
}
