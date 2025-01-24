require("dotenv").config();
const express = require("express");
const { Client } = require("@axiomhq/axiom-node");
const { RateLimiter } = require("limiter");

const app = express();
app.use(express.json());

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

// MCP Implementation info
const implementation = {
  name: "axiom-mcp",
  version: process.env.npm_package_version || "dev",
};

// Tool definitions
const tools = [
  {
    name: "queryApl",
    description: `Query Axiom datasets using Axiom Processing Language (APL).
Instructions:
1. Query must be a valid APL query string
2. Get schema first by getting a single event and projecting all fields
3. Maximum 65000 rows per query
4. Prefer aggregations when possible
5. Be selective with projections
6. Always restrict time range
7. Never guess schema`,
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The APL query to run",
        },
      },
    },
  },
  {
    name: "listDatasets",
    description: "List all available Axiom datasets",
    parameters: {
      type: "object",
      properties: {},
    },
  },
];

// Endpoints
app.get("/", (req, res) => {
  res.json(implementation);
});

app.get("/tools", (req, res) => {
  res.json(tools);
});

app.post("/tools/:name/call", async (req, res) => {
  const { name } = req.params;
  const { arguments: args } = req.body;

  try {
    switch (name) {
      case "queryApl": {
        const remainingTokens = queryLimiter.tryRemoveTokens(1);
        if (!remainingTokens) {
          return res
            .status(429)
            .json({ error: "Rate limit exceeded for queries" });
        }

        const query = args?.query;
        if (!query) {
          return res.status(400).json({ error: "Query must not be empty" });
        }

        const result = await client.query(query);
        res.json({
          content: [
            {
              type: "text",
              text: JSON.stringify(result),
            },
          ],
        });
        break;
      }

      case "listDatasets": {
        const remainingTokens = datasetsLimiter.tryRemoveTokens(1);
        if (!remainingTokens) {
          return res
            .status(429)
            .json({ error: "Rate limit exceeded for dataset operations" });
        }

        const datasets = await client.datasets.list();
        res.json({
          content: [
            {
              type: "text",
              text: JSON.stringify(datasets),
            },
          ],
        });
        break;
      }

      default:
        res.status(404).json({ error: "Tool not found" });
    }
  } catch (error) {
    console.error(`Error executing tool ${name}:`, error);
    res.status(500).json({ error: error.message });
  }
});

const port = process.env.PORT || 3000;
const server = app.listen(port, () => {
  console.log(`MCP server listening at http://localhost:${port}`);
});

// Handle shutdown gracefully
process.on("SIGINT", () => {
  console.log("\nGracefully shutting down...");
  server.close(() => {
    console.log("Server closed");
    process.exit(0);
  });
});
