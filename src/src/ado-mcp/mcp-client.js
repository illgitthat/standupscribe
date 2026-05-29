const { spawn } = require("node:child_process");
const { EventEmitter } = require("node:events");
const readline = require("node:readline");

const MCP_CLIENT_INFO = {
  name: "standupscribe-ado-bridge",
  version: "0.1.0",
};
const RAW_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05", "2024-10-07"];
const REQUEST_TIMEOUT_MS = 60 * 1000;

function resolveStructuredToolResult(result) {
  if (result?.structuredContent !== undefined) {
    return result.structuredContent;
  }
  return result;
}

function normalizeToolDefinition(tool) {
  return {
    description: String(tool?.description ?? "").trim(),
    inputSchema: tool?.inputSchema ?? { type: "object", properties: {} },
    name: String(tool?.name ?? "").trim(),
  };
}

function toError(error, fallbackMessage = "Unexpected MCP client error") {
  if (error instanceof Error) {
    return error;
  }
  return new Error(String(error ?? fallbackMessage));
}

function createTimeoutError(method) {
  return new Error(`MCP request timed out for ${method}`);
}

function tryLoadSdk() {
  try {
    const { Client } = require("@modelcontextprotocol/sdk/client");
    const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");
    return { Client, StdioClientTransport };
  } catch {
    return null;
  }
}

class McpClient extends EventEmitter {
  constructor() {
    super();
    this.backend = null;
    this.child = null;
    this.client = null;
    this.pending = new Map();
    this.readlineInterface = null;
    this.requestId = 0;
    this.stderrBuffer = [];
    this.stderrListener = null;
    this.transport = null;
  }

  async start(spawnOptions = {}) {
    if (this.backend) {
      return this;
    }

    const sdk = tryLoadSdk();
    if (sdk) {
      await this.startWithSdk(sdk, spawnOptions);
      return this;
    }

    await this.startRaw(spawnOptions);
    return this;
  }

  async startWithSdk({ Client, StdioClientTransport }, spawnOptions) {
    const transport = new StdioClientTransport({
      args: spawnOptions.args ?? [],
      command: spawnOptions.command,
      cwd: spawnOptions.cwd,
      env: spawnOptions.env,
      stderr: "pipe",
    });
    const client = new Client(MCP_CLIENT_INFO, {
      capabilities: {},
    });

    transport.onmessage = (message) => {
      if (message && typeof message === "object" && "method" in message && !("id" in message)) {
        this.emit("notification", message);
      }
    };
    transport.onerror = (error) => {
      this.emit("error", toError(error));
    };
    transport.onclose = () => {
      this.backend = null;
      this.client = null;
      this.transport = null;
      this.emit("exit", {
        pid: transport.pid,
        stderr: this.getStderr(),
      });
    };

    if (transport.stderr) {
      this.stderrListener = (chunk) => {
        this.appendStderr(chunk);
      };
      transport.stderr.on("data", this.stderrListener);
    }

    client.fallbackNotificationHandler = async (notification) => {
      this.emit("notification", notification);
    };
    client.onerror = (error) => {
      this.emit("error", toError(error));
    };

    await client.connect(transport);
    this.backend = "sdk";
    this.client = client;
    this.transport = transport;
  }

  async startRaw(spawnOptions) {
    const child = spawn(spawnOptions.command, spawnOptions.args ?? [], {
      cwd: spawnOptions.cwd,
      env: {
        ...process.env,
        ...(spawnOptions.env ?? {}),
      },
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    this.child = child;
    this.readlineInterface = readline.createInterface({
      crlfDelay: Number.POSITIVE_INFINITY,
      input: child.stdout,
    });

    child.stderr.on("data", (chunk) => {
      this.appendStderr(chunk);
    });
    child.on("error", (error) => {
      this.emit("error", toError(error));
    });
    child.on("exit", (code, signal) => {
      this.backend = null;
      this.child = null;
      this.rejectPendingRequests(new Error(`MCP server exited${code !== null ? ` with code ${code}` : ""}${signal ? ` (${signal})` : ""}`));
      this.emit("exit", {
        code,
        signal,
        stderr: this.getStderr(),
      });
    });

    this.readlineInterface.on("line", (line) => {
      this.handleRawLine(line);
    });

    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });

    const initializeResult = await this.requestRaw("initialize", {
      capabilities: {},
      clientInfo: MCP_CLIENT_INFO,
      protocolVersion: RAW_PROTOCOL_VERSIONS[0],
    });
    if (!RAW_PROTOCOL_VERSIONS.includes(String(initializeResult?.protocolVersion ?? ""))) {
      throw new Error(`Unsupported MCP protocol version: ${initializeResult?.protocolVersion ?? "(missing)"}`);
    }
    await this.sendRawNotification("notifications/initialized");
    this.backend = "raw";
  }

  async listTools() {
    this.assertStarted();
    if (this.backend === "sdk") {
      const result = await this.client.listTools();
      return (result?.tools ?? []).map(normalizeToolDefinition);
    }
    const result = await this.requestRaw("tools/list");
    return (result?.tools ?? []).map(normalizeToolDefinition);
  }

  async callTool(name, args = {}) {
    this.assertStarted();
    if (this.backend === "sdk") {
      const result = await this.client.callTool({
        arguments: args ?? {},
        name,
      });
      return resolveStructuredToolResult(result);
    }
    const result = await this.requestRaw("tools/call", {
      arguments: args ?? {},
      name,
    });
    return resolveStructuredToolResult(result);
  }

  async stop() {
    const backend = this.backend;
    this.backend = null;

    try {
      if (backend === "sdk") {
        const transport = this.transport;
        if (transport?.stderr && this.stderrListener) {
          transport.stderr.off("data", this.stderrListener);
        }
        this.stderrListener = null;
        await this.client?.close();
      } else if (backend === "raw") {
        await this.stopRawChild();
      }
    } finally {
      this.client = null;
      this.transport = null;
      this.child = null;
      this.rejectPendingRequests(new Error("MCP client stopped"));
      this.readlineInterface?.close();
      this.readlineInterface = null;
    }
  }

  assertStarted() {
    if (!this.backend) {
      throw new Error("MCP client is not started");
    }
  }

  appendStderr(chunk) {
    const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk ?? "");
    if (!text) {
      return;
    }
    this.stderrBuffer.push(text);
    if (this.stderrBuffer.length > 200) {
      this.stderrBuffer.splice(0, this.stderrBuffer.length - 200);
    }
  }

  getStderr() {
    return this.stderrBuffer.join("").trim();
  }

  handleRawLine(line) {
    const trimmed = String(line ?? "").trim();
    if (!trimmed) {
      return;
    }

    let message = null;
    try {
      message = JSON.parse(trimmed);
    } catch (error) {
      this.emit("error", new Error(`Failed to parse MCP JSON line: ${trimmed}\n${toError(error).message}`));
      return;
    }

    if (message && typeof message === "object" && "id" in message) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      clearTimeout(pending.timeoutId);
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message || `MCP request failed with code ${message.error.code}`));
        return;
      }
      pending.resolve(message.result);
      return;
    }

    if (message && typeof message === "object" && "method" in message) {
      this.emit("notification", message);
    }
  }

  async requestRaw(method, params) {
    const child = this.child;
    if (!child?.stdin) {
      throw new Error("Raw MCP client is not connected");
    }
    const id = ++this.requestId;
    const message = {
      jsonrpc: "2.0",
      id,
      method,
    };
    if (params !== undefined) {
      message.params = params;
    }
    const payload = `${JSON.stringify(message)}\n`;
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pending.delete(id);
        reject(createTimeoutError(method));
      }, REQUEST_TIMEOUT_MS);
      timeoutId.unref?.();
      this.pending.set(id, {
        reject,
        resolve,
        timeoutId,
      });
      child.stdin.write(payload, (error) => {
        if (!error) {
          return;
        }
        clearTimeout(timeoutId);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  async sendRawNotification(method, params) {
    const child = this.child;
    if (!child?.stdin) {
      throw new Error("Raw MCP client is not connected");
    }
    const message = {
      jsonrpc: "2.0",
      method,
    };
    if (params !== undefined) {
      message.params = params;
    }
    await new Promise((resolve, reject) => {
      child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  rejectPendingRequests(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeoutId);
      pending.reject(error);
    }
    this.pending.clear();
  }

  async stopRawChild() {
    const child = this.child;
    if (!child) {
      return;
    }

    const waitForExit = new Promise((resolve) => {
      child.once("exit", resolve);
    });

    try {
      child.stdin?.end();
    } catch {
    }

    await Promise.race([
      waitForExit,
      new Promise((resolve) => {
        const timer = setTimeout(resolve, 2000);
        timer.unref?.();
      }),
    ]);

    if (child.exitCode === null) {
      try {
        child.kill("SIGTERM");
      } catch {
      }
      await Promise.race([
        waitForExit,
        new Promise((resolve) => {
          const timer = setTimeout(resolve, 2000);
          timer.unref?.();
        }),
      ]);
    }

    if (child.exitCode === null) {
      try {
        child.kill("SIGKILL");
      } catch {
      }
    }
  }
}

module.exports = {
  McpClient,
};
