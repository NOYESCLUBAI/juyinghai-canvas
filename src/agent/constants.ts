export const MAX_STEPS = 12;
export const MAX_CREATES_PER_RUN = 8;
export const READ_CARD_CHARS = 12_000;
export const OVERVIEW_PREVIEW_CHARS = 120;
export const INSTRUCTION_CHARS = 4_000;
export const MODEL_TIMEOUT_MS = 45_000;
export const HISTORY_LIMIT = 40;
export const TOOL_RESULT_CHARS = 4_000;
export const AGENT_PROXY_PATH = "/api/agent";

export const READ_TOOLS = new Set([
  "canvas_overview",
  "read_cards",
  "search_cards",
  "select_cards",
  "focus_viewport",
  "finish",
]);

export const ASPECT_RATIOS = ["adaptive", "1:1", "16:9", "9:16", "4:3", "3:4"] as const;
