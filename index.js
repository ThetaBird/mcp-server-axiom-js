require("dotenv").config();
const { Axiom } = require("@axiomhq/js");
const { RateLimiter } = require("limiter");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const {
  StdioServerTransport,
} = require("@modelcontextprotocol/sdk/server/stdio.js");
const { z } = require("zod");
const {
  getStringifiedSchema,
  convertSchemaToJSON,
  fieldsSchema,
} = require("./helpers/convertToSchemaJSON.js");
// Configuration
const config = {
  token: process.env.AXIOM_TOKEN,
  url: process.env.AXIOM_URL || "https://api.axiom.co",
  internalUrl: "https://app.axiom.co/api/internal",
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
const client = new Axiom({
  token: config.token,
  ...(config.orgId && { organizationId: config.orgId }),
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
  `# Instructions
1. Query Axiom datasets using Axiom Processing Language (APL). The query must be a valid APL query string.
2. ALWAYS get the schema of the dataset before running queries rather than guessing.
    You can do this by getting a single event and projecting all fields.
3. Keep in mind that there's a maximum row limit of 65000 rows per query.
4. Prefer aggregations over non aggregating queries when possible to reduce the amount of data returned.
5. Be selective in what you project in each query (unless otherwise needed, like for discovering the schema).
    It's expensive to project all fields.
6. ALWAYS restrict the time range of the query to the smallest possible range that
    meets your needs. This will reduce the amount of data scanned and improve query performance.
7. NEVER guess the schema of the dataset. If you don't where something is, use search first to find in which fields
    it appears.

# Examples
Basic:
- Filter: ['logs'] | where ['severity'] == "error" or ['duration'] > 500ms
- Time range: ['logs'] | where ['_time'] > ago(2h) and ['_time'] < now()
- Project rename: ['logs'] | project-rename responseTime=['duration'], path=['url']

Aggregations:
- Count by: ['logs'] | summarize count() by bin(['_time'], 5m), ['status']
- Multiple aggs: ['logs'] | summarize count(), avg(['duration']), max(['duration']), p95=percentile(['duration'], 95) by ['endpoint']
- Dimensional: ['logs'] | summarize dimensional_analysis(['isError'], pack_array(['endpoint'], ['status']))
- Histograms: ['logs'] | summarize histogram(['responseTime'], 100) by ['endpoint']
- Distinct: ['logs'] | summarize dcount(['userId']) by bin_auto(['_time'])

Search & Parse:
- Search all: search "error" or "exception"
- Parse logs: ['logs'] | parse-kv ['message'] as (duration:long, error:string) with (pair_delimiter=",")
- Regex extract: ['logs'] | extend errorCode = extract("error code ([0-9]+)", 1, ['message'])
- Contains ops: ['logs'] | where ['message'] contains_cs "ERROR" or ['message'] startswith "FATAL"

Data Shaping:
- Extend & Calculate: ['logs'] | extend duration_s = ['duration']/1000, success = ['status'] < 400
- Dynamic: ['logs'] | extend props = parse_json(['properties']) | where ['props.level'] == "error"
- Pack/Unpack: ['logs'] | extend fields = pack("status", ['status'], "duration", ['duration'])
- Arrays: ['logs'] | where ['url'] in ("login", "logout", "home") | where array_length(['tags']) > 0

Advanced:
- Make series: ['metrics'] | make-series avg(['cpu']) default=0 on ['_time'] step 1m by ['host']
- Join: ['errors'] | join kind=inner (['users'] | project ['userId'], ['email']) on ['userId']
- Union: union ['logs-app*'] | where ['severity'] == "error"
- Fork: ['logs'] | fork (where ['status'] >= 500 | as errors) (where ['status'] < 300 | as success)
- Case: ['logs'] | extend level = case(['status'] >= 500, "error", ['status'] >= 400, "warn", "info")

Time Operations:
- Bin & Range: ['logs'] | where ['_time'] between(datetime(2024-01-01)..now())
- Multiple time bins: ['logs'] | summarize count() by bin(['_time'], 1h), bin(['_time'], 1d)
- Time shifts: ['logs'] | extend prev_hour = ['_time'] - 1h

String Operations:
- String funcs: ['logs'] | extend domain = tolower(extract("://([^/]+)", 1, ['url']))
- Concat: ['logs'] | extend full_msg = strcat(['level'], ": ", ['message'])
- Replace: ['logs'] | extend clean_msg = replace_regex("(password=)[^&]*", "\\1***", ['message'])

Common Patterns:
- Error analysis: ['logs'] | where ['severity'] == "error" | summarize error_count=count() by ['error_code'], ['service']
- Status codes: ['logs'] | summarize requests=count() by ['status'], bin_auto(['_time']) | where ['status'] >= 500
- Latency tracking: ['logs'] | summarize p50=percentile(['duration'], 50), p90=percentile(['duration'], 90) by ['endpoint']
- User activity: ['logs'] | summarize user_actions=count() by ['userId'], ['action'], bin(['_time'], 1h)`,
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
  }
);

server.tool(
  "listDatasets",
  "List all available Axiom datasets",
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
  }
);

const datasetInfoSchema = z.object({
  compressedBytes: z.number(),
  compressedBytesHuman: z.string(),
  created: z.string(),
  fields: fieldsSchema,
  inputBytes: z.number(),
  inputBytesHuman: z.string(),
  maxTime: z.string(),
  minTime: z.string(),
  name: z.string(),
  numBlocks: z.number(),
  numEvents: z.number(),
  numFields: z.number(),
  quickQueries: z.null(),
  who: z.string(),
});

server.tool(
  "getDatasetInfoAndSchema",
  "Get dataset info and schema",
  {
    dataset: z.string().describe("The dataset to get info and schema for"),
  },
  async ({ dataset }) => {
    const remainingTokens = datasetsLimiter.tryRemoveTokens(1);
    if (!remainingTokens) {
      throw new Error("Rate limit exceeded for dataset operations");
    }

    try {
      // Axiom client does not provide access to internal routes. We need to hit the API directly.
      const response = await fetch(
        `${config.internalUrl}/datasets/${dataset}/info`,
        {
          headers: {
            Authorization: `Bearer ${config.token}`,
            "X-AXIOM-ORG-ID": config.orgId,
          },
        }
      );

      const rawData = await response.json();

      // Validate the response data
      const data = datasetInfoSchema.parse(rawData);

      // Convert the fields to type definitions string
      const typeDefsString = getStringifiedSchema(
        convertSchemaToJSON(data.fields)
      );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ ...data, fields: typeDefsString }), // Override the fields with the type definitions
          },
        ],
      };
    } catch (error) {
      throw new Error(`Failed to list datasets: ${error.message}`);
    }
  }
);

// Start receiving messages on stdin and sending messages on stdout
const transport = new StdioServerTransport();
server.connect(transport).catch((error) => {
  console.error("Failed to connect transport:", error);
  process.exit(1);
});
