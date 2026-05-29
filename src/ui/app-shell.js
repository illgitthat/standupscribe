import { createApiClient } from "./core/api.js";
import { createSettingsPage } from "./features/settings-page/index.js";

const BOOTSTRAP_FLAG = "__ssAppShellBooted";

function createShellRoot() {
  const appRoot = document.getElementById("root");
  if (!appRoot) {
    throw new Error("app root #root is missing");
  }
  appRoot.replaceChildren();

  const shell = document.createElement("div");
  shell.className = "rr-app-shell";
  shell.innerHTML = `
    <header class="rr-app-topbar">
      <div class="rr-app-brand-cluster">
        <div class="rr-app-mark" aria-hidden="true">SS</div>
        <div class="rr-app-topbar-copy">
          <div class="rr-app-brand-row">
            <h1 class="rr-app-brand">StandupScribe</h1>
          </div>
        </div>
      </div>
      <nav class="rr-app-nav" data-role="nav">
        <button class="rr-app-nav-button" data-path="/settings" type="button">Settings</button>
        <a class="rr-app-nav-button" href="/realtime-test.html">StandupScribe</a>
      </nav>
    </header>
    <main class="rr-app-page" data-role="page"></main>
  `;
  appRoot.appendChild(shell);
  return {
    page: shell.querySelector('[data-role="page"]'),
    nav: shell.querySelector('[data-role="nav"]'),
  };
}

export function bootstrapAppShell() {
  if (window[BOOTSTRAP_FLAG]) {
    return window[BOOTSTRAP_FLAG];
  }

  const api = createApiClient();
  const shellRoot = createShellRoot();
  const settingsPage = createSettingsPage({ api });

  function renderRoute() {
    document.title = "StandupScribe Settings";
    shellRoot.page.replaceChildren();
    settingsPage.mount(shellRoot.page);
    for (const button of shellRoot.nav.querySelectorAll('[data-path]')) {
      button.setAttribute("data-active", "true");
    }
  }

  function onNavClick(event) {
    const button = event.target.closest('[data-path]');
    if (!button) {
      return;
    }
    window.history.replaceState({}, "", button.getAttribute("data-path") || "/settings");
    renderRoute();
  }

  shellRoot.nav.addEventListener("click", onNavClick);
  if (window.location.pathname !== "/settings") {
    window.history.replaceState({}, "", "/settings");
  }
  renderRoute();

  window[BOOTSTRAP_FLAG] = {
    cleanup() {
      settingsPage.unmount();
      shellRoot.nav.removeEventListener("click", onNavClick);
    },
  };
  return window[BOOTSTRAP_FLAG];
}

bootstrapAppShell();
