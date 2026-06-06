import {
  DEFAULT_LANGGRAPH_GRAPH_ID,
  type LangGraphCatalog,
  NODE_LANGGRAPH_CATALOG,
  NODE_LANGGRAPH_GRAPH_IDS,
} from "@cogni/langgraph-graphs";

export const LANGGRAPH_CATALOG: LangGraphCatalog = NODE_LANGGRAPH_CATALOG;
export {
  DEFAULT_LANGGRAPH_GRAPH_ID,
  NODE_LANGGRAPH_GRAPH_IDS as LANGGRAPH_GRAPH_IDS,
};
export * from "@cogni/langgraph-graphs/graphs";
