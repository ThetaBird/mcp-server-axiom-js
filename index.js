require("dotenv").config();
const { Client } = require("@axiomhq/axiom-node");
const { RateLimiter } = require("limiter");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const {
  StdioServerTransport,
} = require("@modelcontextprotocol/sdk/server/stdio.js");
const { z } = require("zod");

// Configuration
const config = {
  token: process.env.AXIOM_TOKEN,
  url: process.env.AXIOM_URL || "https://api.axiom.co",
  orgId: process.env.AXIOM_ORG_ID,
  queryRateLimit: parseFloat(process.env.AXIOM_QUERY_RATE || "1"),
  queryRateBurst: parseInt(process.env.AXIOM_QUERY_BURST || "1"),
  datasetsRateLimit: parseFloat(process.env.AXIOM_DATASETS_RATE || "1"),
  datasetsRateBurst: parseInt(process.env.AXIOM_DATASETS_BURST || "1"),
};

if (!config.token) {
  console.error(
    "Error: Axiom token must be provided via AXIOM_TOKEN environment variable"
  );
  process.exit(1);
}

// Initialize Axiom client
const client = new Client({
  token: config.token,
  orgId: config.orgId,
  ...(config.url && { url: config.url }),
});

// Rate limiters
const queryLimiter = new RateLimiter({
  tokensPerInterval: config.queryRateBurst,
  interval: "second",
});

const datasetsLimiter = new RateLimiter({
  tokensPerInterval: config.datasetsRateBurst,
  interval: "second",
});

// Create MCP server
const server = new McpServer({
  name: "mcp-server-axiom",
  version: process.env.npm_package_version || "1.0.0",
});

// Define tools using the MCP SDK
server.tool(
  "queryApl",
  {
    query: z.string().describe("The APL query to run"),
  },
  async ({ query }) => {
    const remainingTokens = queryLimiter.tryRemoveTokens(1);
    if (!remainingTokens) {
      throw new Error("Rate limit exceeded for queries");
    }

    if (!query) {
      throw new Error("Query must not be empty");
    }

    try {
      const result = await client.query(query);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result),
          },
        ],
      };
    } catch (error) {
      throw new Error(`Query failed: ${error.message}`);
    }
  },
  {
    description: `Query Axiom datasets using Axiom Processing Language (APL).
Instructions:
1. Query must be a valid APL query string
2. Get schema first by getting a single event and projecting all fields
3. Maximum 65000 rows per query
4. Prefer aggregations when possible
5. Be selective with projections
6. Always restrict time range
7. Never guess schema`,
  }
);

server.tool(
  "listDatasets",
  {},
  async () => {
    const remainingTokens = datasetsLimiter.tryRemoveTokens(1);
    if (!remainingTokens) {
      throw new Error("Rate limit exceeded for dataset operations");
    }

    try {
      const datasets = await client.datasets.list();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(datasets),
          },
        ],
      };
    } catch (error) {
      throw new Error(`Failed to list datasets: ${error.message}`);
    }
  },
  {
    description: "List all available Axiom datasets",
  }
);

// Start receiving messages on stdin and sending messages on stdout
const transport = new StdioServerTransport();
server.connect(transport).catch((error) => {
  console.error("Failed to connect transport:", error);
  process.exit(1);
});
