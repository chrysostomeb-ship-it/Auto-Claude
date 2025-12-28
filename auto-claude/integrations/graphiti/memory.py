"""
Graphiti Memory Integration V2 - Backward Compatibility Facade
================================================================

This module maintains backward compatibility by re-exporting the modular
memory system from the auto-claude/graphiti/ package.

The refactored code is now organized as:
- graphiti/graphiti.py - Main GraphitiMemory class
- graphiti/client.py - FalkorDB client wrapper
- graphiti/queries.py - Graph query operations
- graphiti/search.py - Semantic search logic
- graphiti/schema.py - Graph schema definitions

This facade ensures existing imports continue to work:
    from graphiti_memory import GraphitiMemory, is_graphiti_enabled

New code should prefer importing from the graphiti package:
    from graphiti import GraphitiMemory
    from graphiti.schema import GroupIdMode

For detailed documentation on the memory system architecture and usage,
see graphiti/graphiti.py.
"""

from pathlib import Path

# Import config utilities
from graphiti_config import (
    GraphitiConfig,
    is_graphiti_enabled,
)

# Re-export from modular system
# Use relative import within the integrations.graphiti package
from .queries_pkg import (
    EPISODE_TYPE_CODEBASE_DISCOVERY,
    EPISODE_TYPE_GOTCHA,
    EPISODE_TYPE_HISTORICAL_CONTEXT,
    EPISODE_TYPE_PATTERN,
    EPISODE_TYPE_QA_RESULT,
    EPISODE_TYPE_SESSION_INSIGHT,
    EPISODE_TYPE_TASK_OUTCOME,
    MAX_CONTEXT_RESULTS,
    GraphitiMemory,
    GroupIdMode,
)


# Convenience function for getting a memory manager
def get_graphiti_memory(
    spec_dir: Path,
    project_dir: Path | None = None,
) -> GraphitiMemory | None:
    """
    Get a GraphitiMemory instance if available.

    Args:
        spec_dir: Spec directory (used for group_id)
        project_dir: Project root directory (defaults to spec_dir.parent.parent)

    Returns:
        GraphitiMemory instance or None if not available
    """
    if not is_graphiti_enabled():
        return None

    if project_dir is None:
        project_dir = spec_dir.parent.parent

    return GraphitiMemory(spec_dir, project_dir)


# Public API exports
__all__ = [
    # Config
    "GraphitiConfig",
    "is_graphiti_enabled",
    # Memory
    "GraphitiMemory",
    "GroupIdMode",
    "get_graphiti_memory",
    # Episode types
    "EPISODE_TYPE_SESSION_INSIGHT",
    "EPISODE_TYPE_CODEBASE_DISCOVERY",
    "EPISODE_TYPE_PATTERN",
    "EPISODE_TYPE_GOTCHA",
    "EPISODE_TYPE_TASK_OUTCOME",
    "EPISODE_TYPE_QA_RESULT",
    "EPISODE_TYPE_HISTORICAL_CONTEXT",
    # Constants
    "MAX_CONTEXT_RESULTS",
]
