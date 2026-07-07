"""Shared configuration for the MongoDB-on-CMA cookbook.

Tunables, index names, thresholds, and the server-version check used across the retrieval,
tool, and AP2 modules. Kept import-light so every other module can depend on it freely.
"""

from __future__ import annotations

DEFAULT_MODEL = "claude-haiku-4-5"
EMBED_MODEL = "voyage-4-large"
EMBED_DIM = 1024
RERANK_MODEL = "rerank-2.5"
DECIDED_STATUSES = ("approved", "rejected", "escalated", "completed")
VECTOR_INDEX_NAME = "transactions_vector_index"
SEARCH_INDEX_NAME = "transactions_search_index"
LEXICAL_PATHS = ["text", "sender.name", "recipient.name"]
PROJECT_FIELDS = ["transaction_id", "text", "amount", "sender", "recipient", "decision"]
REQUIRED_ENV = ("ANTHROPIC_API_KEY", "MONGO_URI")

ATLAS_EMBEDDINGS_URL = "https://ai.mongodb.com/v1/embeddings"
ATLAS_RERANK_URL = "https://ai.mongodb.com/v1/rerank"


class EmbeddingDimensionMismatch(RuntimeError): ...


class IndexTimeout(RuntimeError): ...


def _parse_major_minor(version: str) -> tuple[int, int]:
    parts = str(version).split(".")
    try:
        return (int(parts[0]), int(parts[1]) if len(parts) > 1 else 0)
    except (ValueError, IndexError):
        return (0, 0)


def supports_rank_fusion(version: str) -> bool:
    return _parse_major_minor(version) >= (8, 0)
