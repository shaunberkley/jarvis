export { runInboxPoll } from "./watcher.js";
export { classifyMessage, inferCompanies } from "./classifier.js";
export { linkInboxMatches } from "./linker.js";
export { notifyStageTransitions } from "./notifier.js";
export type { InboxMatch, InboxPollResult, Classification } from "./types.js";
