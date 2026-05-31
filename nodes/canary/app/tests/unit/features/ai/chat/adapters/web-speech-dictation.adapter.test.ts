// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * @vitest-environment jsdom
 *
 * Module: `@tests/unit/features/ai/chat/adapters/web-speech-dictation.adapter`
 * Purpose: Unit tests for the Web Speech API DictationAdapter.
 * Scope: Tests adapter creation, support detection, session lifecycle, and event callbacks.
 * Invariants: PROGRESSIVE_ENHANCEMENT — undefined when unsupported. Session emits correct events.
 * Side-effects: global (mocked SpeechRecognition on window)
 * Links: @/features/ai/chat/adapters/web-speech-dictation.adapter
 * @internal
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createWebSpeechDictationAdapter,
  isSpeechRecognitionSupported,
} from "@/features/ai/chat/adapters/web-speech-dictation.adapter";

/** Minimal mock for SpeechRecognition using a class so `new Ctor()` works */
class MockSpeechRecognition {
  continuous = false;
  interimResults = false;
  lang = "";
  onstart: ((ev: Event) => void) | null = null;
  onspeechstart: ((ev: Event) => void) | null = null;
  onresult: ((ev: unknown) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  onend: ((ev: Event) => void) | null = null;
  start = vi.fn();
  stop = vi.fn();
  abort = vi.fn();
}

let mockInstance: MockSpeechRecognition;

function installMockSpeechRecognition() {
  // Each test gets a fresh class that captures its instance
  const OrigClass = MockSpeechRecognition;
  const WrappedCtor = class extends OrigClass {
    constructor() {
      super();
      mockInstance = this;
    }
  };
  Object.defineProperty(window, "webkitSpeechRecognition", {
    value: WrappedCtor,
    writable: true,
    configurable: true,
  });
}

function removeMockSpeechRecognition() {
  // Delete rather than set undefined — `"x" in window` returns true for undefined properties
  delete (window as Record<string, unknown>).webkitSpeechRecognition;
  delete (window as Record<string, unknown>).SpeechRecognition;
}

describe("web-speech-dictation.adapter", () => {
  afterEach(() => {
    removeMockSpeechRecognition();
  });

  describe("isSpeechRecognitionSupported", () => {
    it("returns false when SpeechRecognition is not available", () => {
      removeMockSpeechRecognition();
      expect(isSpeechRecognitionSupported()).toBe(false);
    });

    it("returns true when webkitSpeechRecognition is available", () => {
      installMockSpeechRecognition();
      expect(isSpeechRecognitionSupported()).toBe(true);
    });
  });

  describe("createWebSpeechDictationAdapter", () => {
    it("returns undefined when unsupported", () => {
      removeMockSpeechRecognition();
      expect(createWebSpeechDictationAdapter()).toBeUndefined();
    });

    it("returns a DictationAdapter when supported", () => {
      installMockSpeechRecognition();
      const adapter = createWebSpeechDictationAdapter();
      expect(adapter).toBeDefined();
      expect(adapter).toHaveProperty("listen");
    });
  });

  /** Mock is installed in beforeEach — adapter is always defined */
  function createAdapter() {
    const adapter = createWebSpeechDictationAdapter();
    if (!adapter)
      throw new Error("Expected adapter to be defined (mock installed)");
    return adapter;
  }

  describe("session lifecycle", () => {
    beforeEach(() => {
      installMockSpeechRecognition();
    });

    it("starts recognition on listen()", () => {
      const adapter = createAdapter();
      adapter.listen();
      expect(mockInstance.start).toHaveBeenCalledOnce();
    });

    it("configures continuous and interimResults", () => {
      const adapter = createAdapter();
      adapter.listen();
      expect(mockInstance.continuous).toBe(true);
      expect(mockInstance.interimResults).toBe(true);
    });

    it("session status starts as 'starting'", () => {
      const adapter = createAdapter();
      const session = adapter.listen();
      expect(session.status).toEqual({ type: "starting" });
    });

    it("session status becomes 'running' on onstart", () => {
      const adapter = createAdapter();
      const session = adapter.listen();
      mockInstance.onstart?.(new Event("start"));
      expect(session.status).toEqual({ type: "running" });
    });

    it("stop() calls recognition.stop()", async () => {
      const adapter = createAdapter();
      const session = adapter.listen();
      await session.stop();
      expect(mockInstance.stop).toHaveBeenCalledOnce();
      expect(session.status).toEqual({ type: "ended", reason: "stopped" });
    });

    it("cancel() calls recognition.abort()", () => {
      const adapter = createAdapter();
      const session = adapter.listen();
      session.cancel();
      expect(mockInstance.abort).toHaveBeenCalledOnce();
      expect(session.status).toEqual({ type: "ended", reason: "cancelled" });
    });
  });

  describe("event callbacks", () => {
    beforeEach(() => {
      installMockSpeechRecognition();
    });

    it("fires onSpeechStart when speech is detected", () => {
      const adapter = createAdapter();
      const session = adapter.listen();
      const callback = vi.fn();
      session.onSpeechStart(callback);

      mockInstance.onspeechstart?.(new Event("speechstart"));
      expect(callback).toHaveBeenCalledOnce();
    });

    it("fires onSpeechStart only once", () => {
      const adapter = createAdapter();
      const session = adapter.listen();
      const callback = vi.fn();
      session.onSpeechStart(callback);

      mockInstance.onspeechstart?.(new Event("speechstart"));
      mockInstance.onspeechstart?.(new Event("speechstart"));
      expect(callback).toHaveBeenCalledOnce();
    });

    it("fires onSpeech with interim results", () => {
      const adapter = createAdapter();
      const session = adapter.listen();
      const callback = vi.fn();
      session.onSpeech(callback);

      mockInstance.onresult?.({
        resultIndex: 0,
        results: {
          length: 1,
          0: {
            isFinal: false,
            0: { transcript: "hello", confidence: 0.9 },
            length: 1,
          },
        },
      });

      expect(callback).toHaveBeenCalledWith({
        transcript: "hello",
        isFinal: false,
      });
    });

    it("fires onSpeech and onSpeechEnd with final results", () => {
      const adapter = createAdapter();
      const session = adapter.listen();
      const speechCb = vi.fn();
      const endCb = vi.fn();
      session.onSpeech(speechCb);
      session.onSpeechEnd(endCb);

      mockInstance.onresult?.({
        resultIndex: 0,
        results: {
          length: 1,
          0: {
            isFinal: true,
            0: { transcript: "hello world", confidence: 0.95 },
            length: 1,
          },
        },
      });

      const expected = { transcript: "hello world", isFinal: true };
      expect(speechCb).toHaveBeenCalledWith(expected);
      expect(endCb).toHaveBeenCalledWith(expected);
    });

    it("unsubscribe removes callback", () => {
      const adapter = createAdapter();
      const session = adapter.listen();
      const callback = vi.fn();
      const unsub = session.onSpeechStart(callback);

      unsub();
      mockInstance.onspeechstart?.(new Event("speechstart"));
      expect(callback).not.toHaveBeenCalled();
    });

    it("sets error status on recognition error", () => {
      const adapter = createAdapter();
      const session = adapter.listen();
      mockInstance.onerror?.(new Event("error"));
      expect(session.status).toEqual({ type: "ended", reason: "error" });
    });
  });
});
