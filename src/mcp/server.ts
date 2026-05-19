/**
 * Custom Jarvis MCP server.
 *
 * Exposes slash-command-equivalent tools that Claude Code calls when Shaun
 * sends a /jarvis-* message via Telegram (forwarded by claude-code-channels).
 *
 * Initial tool set (stubs — actual logic lives in src/modules/):
 *   - jarvis_status        Current pipeline summary
 *   - jarvis_pause         Pause autonomous modules (Scout scan, inbox poll)
 *   - jarvis_resume        Resume autonomous modules
 *   - jarvis_search        Manual ad-hoc search across applied jobs / memory
 *   - jarvis_remember      Force-write a memory entry
 *   - jarvis_recall        Query episodic memory
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  {
    name: "jarvis",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Tool definitions
const tools = [
  {
    name: "jarvis_status",
    description:
      "Get current Jarvis pipeline summary: last Scout scan, jobs applied today, unread recruiter replies, paused modules, and any errors.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "jarvis_pause",
    description:
      "Pause one or more autonomous Jarvis modules. Useful when Shaun wants to stop automatic activity (e.g. during interviews or weekends).",
    inputSchema: {
      type: "object",
      properties: {
        modules: {
          type: "array",
          items: {
            type: "string",
            enum: ["scout", "inbox", "calendar", "meeting", "all"],
          },
          description: "Modules to pause. Pass ['all'] to pause everything.",
        },
      },
      required: ["modules"],
    },
  },
  {
    name: "jarvis_resume",
    description: "Resume previously paused Jarvis modules.",
    inputSchema: {
      type: "object",
      properties: {
        modules: {
          type: "array",
          items: {
            type: "string",
            enum: ["scout", "inbox", "calendar", "meeting", "all"],
          },
        },
      },
      required: ["modules"],
    },
  },
  {
    name: "jarvis_search",
    description:
      "Manual ad-hoc search across Jarvis state and memory. Searches applied jobs, recruiter contacts, meeting episodes, and inbox threads.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        scope: {
          type: "string",
          enum: ["jobs", "meetings", "inbox", "all"],
          default: "all",
        },
        limit: { type: "number", default: 10 },
      },
      required: ["query"],
    },
  },
  {
    name: "jarvis_remember",
    description:
      "Force Jarvis to remember a fact, decision, or note. Writes to Zep with appropriate entity tagging.",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string" },
        type: {
          type: "string",
          enum: ["fact", "decision", "preference", "task", "context"],
          default: "fact",
        },
        entities: {
          type: "array",
          items: { type: "string" },
          description: "Named entities mentioned (people, companies, projects).",
        },
      },
      required: ["content"],
    },
  },
  {
    name: "jarvis_recall",
    description:
      "Query episodic memory. Pulls relevant past episodes ranked by temporal recency and semantic similarity.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        timeframe: {
          type: "string",
          enum: ["today", "week", "month", "quarter", "all"],
          default: "all",
        },
        limit: { type: "number", default: 5 },
      },
      required: ["query"],
    },
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  // STUB: real logic will dispatch to src/modules/* implementations.
  // Returning placeholder content so Telegram → Channels → Claude → this MCP
  // round-trip is exercisable end-to-end before the modules exist.
  switch (name) {
    case "jarvis_status":
      return {
        content: [
          {
            type: "text",
            text: "[stub] Jarvis is online. No modules running yet. See src/modules/ for module implementations.",
          },
        ],
      };

    case "jarvis_pause":
      return {
        content: [
          {
            type: "text",
            text: `[stub] Pause requested for modules: ${JSON.stringify(args?.modules)}.`,
          },
        ],
      };

    case "jarvis_resume":
      return {
        content: [
          {
            type: "text",
            text: `[stub] Resume requested for modules: ${JSON.stringify(args?.modules)}.`,
          },
        ],
      };

    case "jarvis_search":
      return {
        content: [
          {
            type: "text",
            text: `[stub] Search not yet implemented. Query: ${JSON.stringify(args)}`,
          },
        ],
      };

    case "jarvis_remember":
      return {
        content: [
          {
            type: "text",
            text: `[stub] Memory write not yet wired to Zep. Args: ${JSON.stringify(args)}`,
          },
        ],
      };

    case "jarvis_recall":
      return {
        content: [
          {
            type: "text",
            text: `[stub] Memory recall not yet wired to Zep. Args: ${JSON.stringify(args)}`,
          },
        ],
      };

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
