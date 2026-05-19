export interface Env {
  REPL: DurableObjectNamespace;
  ANTHROPIC_API_KEY: string;
  ANTHROPIC_BASE_URL: string;
  ANTHROPIC_BETA: string;
  WEBHOOK_SECRET?: string;
}

/**
 * Webhook payload POSTed to the customer endpoint.
 * Source: api/api/services/async_service/webhook_async/webhook_transformer.py
 *         _build_customer_payload()
 */
export interface WebhookPayload {
  type: "event";
  id: string; // whe_...
  timestamp: string; // ISO 8601 Z
  data: {
    type:
      | "session.created"
      | "session.pending"
      | "session.running"
      | "session.idled"
      | "session.requires_action"
      | "session.archived"
      | "session.deleted";
    id: string; // sess_… tagged session id
    organization_id: string;
    workspace_id: string;
  };
}

/** Subset of the SDK's BetaSessionsEventResource we care about. */
export interface SessionEvent {
  id?: string;
  type: string;
  // flat tool_use / tool_result shape (SALT beta)
  tool_name?: string;
  tool_use_id?: string;
  input?: Record<string, unknown>;
  is_error?: boolean;
  // agent event with nested content blocks (current production)
  content?: ContentBlock[];
}

export interface ContentBlock {
  type: string;
  // tool_use block
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  // tool_result block
  tool_use_id?: string;
  is_error?: boolean;
}

/** Normalised tool_use across both wire shapes. */
export interface ToolUse {
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
}

export interface StoredSnippet {
  /** User-visible top-level names declared by this snippet. */
  names: string[];
  /** Original source — replayed on isolate cold start. */
  source: string;
  createdAt: number;
}
