// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/ai/chat/components/ChatComposerExtras`
 * Purpose: Provides composer toolbar extras for chat including model selection, graph selection, and voice input.
 * Scope: Smart component managing model selection state, localStorage persistence, and API data synchronization. Does not implement model fetching or localStorage utilities (delegates to hooks and preferences module).
 * Invariants: Validates localStorage preference against API models.
 * Side-effects: global (localStorage via preferences module), IO (API fetch via useModels hook)
 * Notes: Designed to be passed as composerLeft slot to kit Thread.
 * Links: ModelPicker component, GraphPicker component, useModels hook, model-preference module
 * @public
 */

"use client";

import type { GraphId, ModelRef } from "@cogni/ai-core";
import { useEffect, useState } from "react";
import {
  type GraphOption,
  GraphPicker,
} from "@/features/ai/components/GraphPicker";
import {
  CHATGPT_MODELS,
  ModelPicker,
} from "@/features/ai/components/ModelPicker";
import { useModels } from "@/features/ai/hooks/useModels";
import {
  setPreferredModelId,
  validatePreferredModel,
} from "@/features/ai/preferences/model-preference";

/**
 * TODO: P1 - Replace hardcoded graphs with API fetch from /api/v1/ai/agents
 * Per CATALOG_STATIC_IN_P0: graphs are static, no runtime discovery yet.
 * See AGENT_DISCOVERY.md Phase 2 checklist.
 */
const AVAILABLE_GRAPHS: readonly GraphOption[] = [
  {
    graphId: "langgraph:brain" satisfies GraphId,
    name: "Brain",
    description: "General canary operator with repo awareness and shipping bias",
  },
  {
    graphId: "langgraph:research" satisfies GraphId,
    name: "Research",
    description: "Deep research across docs, repos, and the live web",
  },
  {
    graphId: "langgraph:browser" satisfies GraphId,
    name: "Browser",
    description: "Live-surface inspector for websites, flows, and runtime checks",
  },
  {
    graphId: "langgraph:frontend-tester" satisfies GraphId,
    name: "Frontend Tester",
    description: "QA pass for homepage, interaction, and visual regressions",
  },
  {
    graphId: "langgraph:operating-review" satisfies GraphId,
    name: "Operating Review",
    description:
      "Operator loop for backlog triage, bottleneck detection, and next-step pressure",
  },
  {
    graphId: "langgraph:ponderer" satisfies GraphId,
    name: "Ponderer",
    description: "Slow-thinking mode for synthesis, naming, and sharper judgment",
  },
];

/** Default graph ID - exported for page initialization */
export const DEFAULT_GRAPH_ID: GraphId = "langgraph:brain";

export interface ChatComposerExtrasProps {
  selectedModel: string;
  onModelChange: (ref: ModelRef) => void;
  defaultModelId: string;
  balance?: number;
  selectedGraph?: GraphId;
  onGraphChange?: (graphId: GraphId) => void;
}

export function ChatComposerExtras({
  selectedModel,
  onModelChange,
  defaultModelId,
  balance = 0,
  selectedGraph = DEFAULT_GRAPH_ID,
  onGraphChange,
}: Readonly<ChatComposerExtrasProps>) {
  const modelsQuery = useModels();
  const [localModel, setLocalModel] = useState(selectedModel);

  // Initialize from localStorage on mount, validate against API models
  useEffect(() => {
    if (modelsQuery.data) {
      // Valid model IDs = OpenRouter models + ChatGPT subscription models
      const modelIds = [
        ...modelsQuery.data.models.map((m) => m.ref.modelId),
        ...CHATGPT_MODELS.map((m) => m.id),
      ];
      const validated = validatePreferredModel(modelIds, defaultModelId);
      if (validated !== localModel) {
        setLocalModel(validated);
        // Find the matching ref from API models (defaults to platform provider)
        const matchedModel = modelsQuery.data.models.find(
          (m) => m.ref.modelId === validated
        );
        onModelChange(
          matchedModel?.ref ?? { providerKey: "platform", modelId: validated }
        );
      }
    }
  }, [modelsQuery.data, defaultModelId, localModel, onModelChange]);

  const handleModelChange = (ref: ModelRef) => {
    setLocalModel(ref.modelId);
    setPreferredModelId(ref.modelId);
    onModelChange(ref);
  };

  const handleGraphChange = (graphId: GraphId) => {
    onGraphChange?.(graphId);
  };

  return (
    <div className="flex items-center gap-1">
      <ModelPicker
        models={modelsQuery.data?.models ?? []}
        value={localModel}
        onValueChange={handleModelChange}
        disabled={modelsQuery.isLoading || modelsQuery.isError}
        balance={balance}
      />
      <GraphPicker
        graphs={AVAILABLE_GRAPHS}
        value={selectedGraph}
        onValueChange={handleGraphChange}
        disabled={!onGraphChange}
      />
    </div>
  );
}
