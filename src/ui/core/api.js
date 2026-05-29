const API_BASE = "http://127.0.0.1:12453";

export function createApiClient(baseUrl = API_BASE) {
  return async function api(path, options = {}) {
    const response = await fetch(`${baseUrl}${path}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...(options.headers ?? {}),
      },
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload?.detail ?? `request failed with status ${response.status}`);
    }
    return payload?.result;
  };
}
