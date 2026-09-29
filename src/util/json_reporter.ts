/**
 * Deterministic NDJSON output for --json mode. Lets a parent Claude Code
 * session (or any tool) drive patchwork-harness and parse its progress without
 * screen-scraping. Each event is one JSON object on its own line.
 *
 * Audit emit (Patchwork-shape JSONL on disk) is independent — these are
 * stdout events for live observers, not the durable record.
 */

export type JsonEventType =
  | "session_start"
  | "plan_proposed"
  | "plan_ready"
  | "step_start"
  | "step_token"
  | "step_end"
  | "file_diff"
  | "permission_required"
  | "human_pause"
  | "human_answer"
  | "session_end"
  | "harness"
  | "error";

export interface JsonEvent {
  type: JsonEventType;
  timestamp: string;
  session_id: string;
  data: Record<string, unknown>;
}

export interface JsonReporter {
  emit(type: JsonEventType, data?: Record<string, unknown>): void;
  setSessionId(id: string): void;
}

export class StdoutJsonReporter implements JsonReporter {
  private sessionId = "";

  setSessionId(id: string): void {
    this.sessionId = id;
  }

  emit(type: JsonEventType, data: Record<string, unknown> = {}): void {
    const event: JsonEvent = {
      type,
      timestamp: new Date().toISOString(),
      session_id: this.sessionId,
      data,
    };
    process.stdout.write(JSON.stringify(event) + "\n");
  }
}

export class NoOpJsonReporter implements JsonReporter {
  setSessionId(_id: string): void {
    /* noop */
  }
  emit(_type: JsonEventType, _data?: Record<string, unknown>): void {
    /* noop */
  }
}
