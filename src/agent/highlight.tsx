import { createContext } from "react";

export const AgentHighlightContext = createContext<ReadonlySet<string>>(new Set());
