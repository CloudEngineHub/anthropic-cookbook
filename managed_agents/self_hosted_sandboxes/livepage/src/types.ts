export interface Env {
  PAGE: DurableObjectNamespace;
  ANTHROPIC_API_KEY: string;
  ANTHROPIC_BASE_URL: string;
  ANTHROPIC_BETA: string;
  WEBHOOK_SECRET?: string;
}

/**
 * Webhook payload POSTed to the customer endpoint.
 * Source: api/api/services/async_service/webhook_async/webhook_transformer.py
 */
export interface WebhookPayload {
  type: "event";
  id: string;
  timestamp: string;
  data: {
    type:
      | "session.created"
      | "session.pending"
      | "session.running"
      | "session.idled"
      | "session.requires_action"
      | "session.archived"
      | "session.deleted";
    id: string; // sess_…
    organization_id: string;
    workspace_id: string;
  };
}

export interface SessionEvent {
  id?: string;
  type: string;
  tool_name?: string;
  tool_use_id?: string;
  input?: Record<string, unknown>;
  is_error?: boolean;
  content?: ContentBlock[];
}

export interface ContentBlock {
  type: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  is_error?: boolean;
}

export interface ToolUse {
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
}

/** An edit applied to the page — stored in insertion order for replay. */
export type PageEdit =
  | { kind: "set_html"; selector: string; html: string }
  | { kind: "add_block"; position: "before" | "after" | "append" | "prepend"; anchor: string; html: string }
  | { kind: "remove"; selector: string }
  | { kind: "set_style"; css: string; id?: string }
  | { kind: "set_attr"; selector: string; name: string; value: string };
