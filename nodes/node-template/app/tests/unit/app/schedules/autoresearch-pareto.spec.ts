import { describe, expect, it } from "vitest";
import {
  AUTORESEARCH_PARETO_SCHEDULE_COUNT,
  buildAutoresearchParetoSchedules,
} from "@/app/(app)/schedules/_api/autoresearchPareto";

const modelRef = {
  providerKey: "platform",
  modelId: "gpt-4o-mini",
};

describe("buildAutoresearchParetoSchedules", () => {
  it("builds two recurring prompt variations for each autoresearch graph", () => {
    const schedules = buildAutoresearchParetoSchedules({
      modelRef,
      timezone: "America/Los_Angeles",
      now: new Date("2026-06-05T12:34:56.000Z"),
    });

    expect(schedules).toHaveLength(AUTORESEARCH_PARETO_SCHEDULE_COUNT);
    expect(schedules.map((schedule) => schedule.graphId)).toEqual([
      "langgraph:autoresearch-single-lane",
      "langgraph:autoresearch-single-lane",
      "langgraph:autoresearch-syntropy-loop",
      "langgraph:autoresearch-syntropy-loop",
      "langgraph:autoresearch-registry-swarm",
      "langgraph:autoresearch-registry-swarm",
    ]);
    expect(new Set(schedules.map((schedule) => schedule.cron)).size).toBe(6);
    expect(
      schedules.every((schedule) => schedule.timezone === "America/Los_Angeles")
    ).toBe(true);
  });

  it("includes comparable autoresearch metadata in every schedule input", () => {
    const schedules = buildAutoresearchParetoSchedules({
      modelRef,
      timezone: "UTC",
      now: new Date("2026-06-05T12:34:56.000Z"),
    });

    const variationIds = new Set<string>();

    for (const schedule of schedules) {
      const input = schedule.input;
      const messages = input.messages;
      const message = Array.isArray(messages) ? messages[0] : null;

      expect(input.modelRef).toEqual(modelRef);
      expect(typeof input.recurringPrompt).toBe("string");
      expect(typeof input.linkedInfoInstruction).toBe("string");
      expect(typeof input.mission).toBe("string");
      expect(typeof input.objective).toBe("string");
      expect(input.comparableMetric).toMatchObject({
        direction: "maximize",
        unit: "0_to_100_score",
      });
      expect(input.paretoPreset).toMatchObject({
        id: "node-template-autoresearch-pareto",
        launchedAt: "2026-06-05T12:34:56.000Z",
      });
      expect(message).toMatchObject({
        role: "user",
        content: input.recurringPrompt,
      });
      expect(String(input.linkedInfoInstruction)).toContain(
        "First retrieve linked information by priority"
      );

      const preset = input.paretoPreset as { promptVariationId?: unknown };
      if (typeof preset.promptVariationId === "string") {
        variationIds.add(preset.promptVariationId);
      }
    }

    expect(variationIds).toEqual(new Set(["pareto-exploit", "pareto-explore"]));
  });
});
