const path = require("node:path");

const {
  AdoBridge,
  buildSafeToolInvocation,
} = require("./ado-bridge");
const { resolveDataDir } = require("../paths");

async function main() {
  const appDir = path.resolve(__dirname, "..", "..");
  const dataDir = resolveDataDir({ appDir, isPackaged: false });
  const bridge = new AdoBridge({
    azureConfigDir: path.join(dataDir, "az-standupscribe"),
  });
  bridge.on("error", (error) => {
    console.error(`ADO bridge event: ${error instanceof Error ? error.message : String(error)}`);
  });

  try {
    console.log(`Starting Azure DevOps bridge with config dir: ${bridge.config.azureConfigDir}`);
    await bridge.start();
    const tools = await bridge.getTools();
    console.log(`Tool count: ${tools.length}`);
    console.log(`Tools: ${tools.map((tool) => tool.name).join(", ")}`);

    const safeTool = buildSafeToolInvocation(tools, { project: bridge.config.project });
    if (!safeTool) {
      throw new Error("No safe read-only Azure DevOps MCP tool is available for smoke testing.");
    }

    console.log(`Calling safe tool: ${safeTool.name}`);
    const result = await bridge.callTool(safeTool.name, safeTool.args);
    console.log("Safe tool result:");
    console.log(JSON.stringify(result, null, 2));
    console.log("ADO bridge smoke test passed.");
    process.exitCode = 0;
  } finally {
    await bridge.stop().catch((error) => {
      console.error(`Failed to stop bridge cleanly: ${error instanceof Error ? error.message : String(error)}`);
    });
  }
}

main().catch((error) => {
  console.error(`ADO bridge smoke test failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
