// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/ai/chat/adapters/web-speech-dictation.adapter`
 * Purpose: DictationAdapter implementation using the Web Speech API (SpeechRecognition).
 * Scope: Bridges browser SpeechRecognition to assistant-ui's DictationAdapter interface.
 *   Does not manage UI state or text injection (delegates to assistant-ui runtime).
 * Invariants: PROGRESSIVE_ENHANCEMENT — returns undefined when SpeechRecognition unavailable.
 * Side-effects: browser (microphone access via SpeechRecognition API)
 * Notes:
 *   TODO: Chrome's SpeechRecognition proxies audio to Google servers. Replace with
 *   @huggingface/transformers whisper-tiny ONNX model for fully local recognition.
 *   Firefox uses on-device recognition (truly local).
 * Links: assistant-ui DictationAdapter interface
 * @public
 */

import type { DictationAdapter } from "@assistant-ui/react";

/**
 * Minimal Web Speech API types — SpeechRecognition/SpeechRecognitionEvent
 * are not in TypeScript's default lib.dom (only the result/alternative types are).
 * We declare the subset we need rather than pulling in a full types package.
 */
interface WebSpeechRecognitionEvent extends Event {
  readonly resultIndex: number;
  readonly results: SpeechRecognitionResultList;
}

interface WebSpeechRecognition extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onstart: ((this: WebSpeechRecognition, ev: Event) => void) | null;
  onspeechstart: ((this: WebSpeechRecognition, ev: Event) => void) | null;
  onresult:
    | ((this: WebSpeechRecognition, ev: WebSpeechRecognitionEvent) => void)
    | null;
  onerror: ((this: WebSpeechRecognition, ev: Event) => void) | null;
  onend: ((this: WebSpeechRecognition, ev: Event) => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

interface WebSpeechRecognitionConstructor {
  new (): WebSpeechRecognition;
}

/**
 * Returns true when the browser supports the Web Speech API.
 */
export function isSpeechRecognitionSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    ("SpeechRecognition" in window || "webkitSpeechRecognition" in window)
  );
}

/** Window with vendor-prefixed SpeechRecognition (e.g. Chrome's webkitSpeechRecognition) */
interface SpeechWindow {
  SpeechRecognition?: WebSpeechRecognitionConstructor;
  webkitSpeechRecognition?: WebSpeechRecognitionConstructor;
}

function getSpeechRecognitionCtor():
  | WebSpeechRecognitionConstructor
  | undefined {
  if (typeof window === "undefined") return undefined;
  const win = window as unknown as SpeechWindow;
  return win.SpeechRecognition ?? win.webkitSpeechRecognition;
}

/**
 * Creates a DictationAdapter backed by the Web Speech API.
 * Returns `undefined` when the browser lacks SpeechRecognition support
 * (progressive enhancement — caller should hide the mic button).
 */
export function createWebSpeechDictationAdapter():
  | DictationAdapter
  | undefined {
  const Ctor = getSpeechRecognitionCtor();
  if (!Ctor) return undefined;

  return {
    listen: (): DictationAdapter.Session => {
      const recognition = new Ctor();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = navigator.language || "en-US";

      type Callback<T = void> = (arg: T) => void;
      const speechStartListeners: Callback[] = [];
      const speechEndListeners: Callback<DictationAdapter.Result>[] = [];
      const speechListeners: Callback<DictationAdapter.Result>[] = [];

      let status: DictationAdapter.Status = { type: "starting" };
      let hasSpeechStarted = false;

      recognition.onstart = () => {
        status = { type: "running" };
      };

      recognition.onspeechstart = () => {
        if (!hasSpeechStarted) {
          hasSpeechStarted = true;
          for (const cb of speechStartListeners) cb();
        }
      };

      recognition.onresult = (event: WebSpeechRecognitionEvent) => {
        let interimTranscript = "";
        let finalTranscript = "";

        for (let i = event.resultIndex; i < event.results.length; i++) {
          const result = event.results[i];
          if (!result?.[0]) continue;
          if (result.isFinal) {
            finalTranscript += result[0].transcript;
          } else {
            interimTranscript += result[0].transcript;
          }
        }

        if (finalTranscript) {
          const adapterResult: DictationAdapter.Result = {
            transcript: finalTranscript,
            isFinal: true,
          };
          for (const cb of speechEndListeners) cb(adapterResult);
          for (const cb of speechListeners) cb(adapterResult);
        }

        if (interimTranscript) {
          const adapterResult: DictationAdapter.Result = {
            transcript: interimTranscript,
            isFinal: false,
          };
          for (const cb of speechListeners) cb(adapterResult);
        }
      };

      recognition.onerror = () => {
        status = { type: "ended", reason: "error" };
      };

      recognition.onend = () => {
        if (status.type !== "ended") {
          status = { type: "ended", reason: "stopped" };
        }
      };

      recognition.start();

      return {
        get status() {
          return status;
        },

        stop: async () => {
          status = { type: "ended", reason: "stopped" };
          recognition.stop();
        },

        cancel: () => {
          status = { type: "ended", reason: "cancelled" };
          recognition.abort();
        },

        onSpeechStart: (callback: () => void) => {
          speechStartListeners.push(callback);
          return () => {
            const idx = speechStartListeners.indexOf(callback);
            if (idx >= 0) speechStartListeners.splice(idx, 1);
          };
        },

        onSpeechEnd: (callback: (result: DictationAdapter.Result) => void) => {
          speechEndListeners.push(callback);
          return () => {
            const idx = speechEndListeners.indexOf(callback);
            if (idx >= 0) speechEndListeners.splice(idx, 1);
          };
        },

        onSpeech: (callback: (result: DictationAdapter.Result) => void) => {
          speechListeners.push(callback);
          return () => {
            const idx = speechListeners.indexOf(callback);
            if (idx >= 0) speechListeners.splice(idx, 1);
          };
        },
      };
    },
  };
}
