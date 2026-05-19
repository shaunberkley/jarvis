/**
 * Registry of all enabled source adapters.
 * Add new adapters here as they're implemented.
 */

import { ashbyAdapter } from "./ashby.js";
import { greenhouseAdapter } from "./greenhouse.js";
import { leverAdapter } from "./lever.js";
import { linkedinAdapter } from "./linkedin.js";
import type { Source, SourceAdapter } from "../types.js";

const registry: Record<Source, SourceAdapter | undefined> = {
  ashby: ashbyAdapter,
  greenhouse: greenhouseAdapter,
  lever: leverAdapter,
  linkedin: linkedinAdapter,
  workday: undefined,     // planned: per-company custom integrations
  yc: undefined,          // planned: Work at a Startup
  wellfound: undefined,   // planned: AngelList successor
};

export function getAdapter(source: Source): SourceAdapter | undefined {
  return registry[source];
}

export const enabledAdapters: SourceAdapter[] = Object.values(registry).filter(
  (a): a is SourceAdapter => Boolean(a)
);
