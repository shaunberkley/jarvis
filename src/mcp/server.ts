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
import {
  addBlacklist,
  getCriteria,
  getJobById,
  getWatchlist,
  listAvailableResumes,
  pickBestResume,
  runScan,
} from "../modules/scout/index.js";

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
  // -------------------------------------------------------------------------
  // Scout module tools
  // -------------------------------------------------------------------------
  {
    name: "scout_scan_now",
    description:
      "Manually trigger Scout to scan all watchlist companies across enabled sources right now. Returns summary of new jobs found and matches above threshold. Normally runs hourly on its own.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "scout_status",
    description:
      "Get Scout pipeline status: enabled sources, current criteria, watchlist size, and a snapshot of recent scan activity.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "scout_blacklist",
    description:
      "Blacklist a company so Scout never surfaces or applies to their jobs again.",
    inputSchema: {
      type: "object",
      properties: {
        company: { type: "string" },
        reason: { type: "string" },
      },
      required: ["company"],
    },
  },
  {
    name: "scout_pick_resume",
    description:
      "Pick the best resume variant for a given Scout job using the heuristic catalog picker. Returns the top pick plus ranked alternatives with rationale so the Claude Code session can override based on JD nuance.",
    inputSchema: {
      type: "object",
      properties: {
        jobId: {
          type: "string",
          description: "scout_jobs.id of the job to pick a resume for.",
        },
      },
      required: ["jobId"],
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

    // -----------------------------------------------------------------------
    // Scout
    // -----------------------------------------------------------------------
    case "scout_scan_now": {
      const result = await runScan();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                startedAt: result.startedAt,
                finishedAt: result.finishedAt,
                durationMs: result.finishedAt.getTime() - result.startedAt.getTime(),
                sourcesScanned: result.sourcesScanned,
                companiesScanned: result.companiesScanned,
                jobsSeen: result.jobsSeen,
                newJobs: result.newJobs,
                matchCount: result.matches.length,
                matches: result.matches.map((m) => ({
                  title: m.job.title,
                  company: m.job.companyName,
                  url: m.job.url,
                  score: m.job.score,
                  reasons: m.job.reasons,
                  pickedResume: m.pickedResume,
                })),
                errors: result.errors,
              },
              null,
              2
            ),
          },
        ],
      };
    }

    case "scout_status": {
      const [criteria, watchlist] = await Promise.all([getCriteria(), getWatchlist()]);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                criteria,
                watchlist: {
                  total: watchlist.length,
                  bySource: countBy(watchlist, (w) => w.source),
                },
              },
              null,
              2
            ),
          },
        ],
      };
    }

    case "scout_blacklist": {
      const company = String(args?.company ?? "");
      const reason = args?.reason != null ? String(args.reason) : undefined;
      if (!company) throw new Error("company is required");
      await addBlacklist(company, reason);
      return {
        content: [
          { type: "text", text: `Blacklisted ${company}${reason ? ` (${reason})` : ""}.` },
        ],
      };
    }

    case "scout_pick_resume": {
      const jobId = String(args?.jobId ?? "");
      if (!jobId) throw new Error("jobId is required");
      const job = await getJobById(jobId);
      if (!job) throw new Error(`No job found with id ${jobId}`);
      const catalog = listAvailableResumes();
      const { pick, alternatives } = pickBestResume(
        job.title,
        job.description,
        job.companyName,
        catalog
      );
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                jobId: job.id,
                job: {
                  title: job.title,
                  company: job.companyName,
                  url: job.url,
                  source: job.source,
                },
                pick: {
                  pdfFile: pick.resume.pdfFile,
                  pdfPath: pick.resume.pdfPath,
                  markdownFile: pick.resume.markdownFile,
                  variant: pick.resume.variant,
                  companyTarget: pick.resume.companyTarget,
                  score: pick.score,
                  rationale: pick.rationale,
                },
                alternatives: alternatives.map((alt) => ({
                  pdfFile: alt.resume.pdfFile,
                  markdownFile: alt.resume.markdownFile,
                  variant: alt.resume.variant,
                  companyTarget: alt.resume.companyTarget,
                  score: alt.score,
                  rationale: alt.rationale,
                })),
                catalogSize: catalog.length,
              },
              null,
              2
            ),
          },
        ],
      };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

function countBy<T>(items: T[], key: (item: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) {
    const k = key(item);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

const transport = new StdioServerTransport();
await server.connect(transport);
