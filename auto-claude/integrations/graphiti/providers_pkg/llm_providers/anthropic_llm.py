"""
Anthropic LLM Provider
======================

Anthropic LLM client implementation for Graphiti.
Supports custom base_url for proxies like Z.AI.
"""

import os
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from graphiti_config import GraphitiConfig

from ..exceptions import ProviderError, ProviderNotInstalled


def create_anthropic_llm_client(config: "GraphitiConfig") -> Any:
    """
    Create Anthropic LLM client.

    Supports custom base URL via ANTHROPIC_BASE_URL env var for proxies.
    Supports custom model via GRAPHITI_ANTHROPIC_MODEL env var.

    Args:
        config: GraphitiConfig with Anthropic settings

    Returns:
        Anthropic LLM client instance

    Raises:
        ProviderNotInstalled: If graphiti-core[anthropic] is not installed
        ProviderError: If API key is missing
    """
    try:
        from anthropic import AsyncAnthropic
        from graphiti_core.llm_client.anthropic_client import AnthropicClient
        from graphiti_core.llm_client.config import LLMConfig
    except ImportError as e:
        raise ProviderNotInstalled(
            f"Anthropic provider requires graphiti-core[anthropic]. "
            f"Install with: pip install graphiti-core[anthropic]\n"
            f"Error: {e}"
        )

    # Get API key - support both ANTHROPIC_API_KEY and ANTHROPIC_AUTH_TOKEN
    api_key = config.anthropic_api_key or os.environ.get("ANTHROPIC_AUTH_TOKEN")
    if not api_key:
        raise ProviderError(
            "Anthropic provider requires ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN"
        )

    # Get custom base URL (for proxies like Z.AI)
    base_url = os.environ.get("ANTHROPIC_BASE_URL")

    # Get custom model (e.g., glm-4.6 via Z.AI)
    model = os.environ.get("GRAPHITI_ANTHROPIC_MODEL", config.anthropic_model)

    llm_config = LLMConfig(
        api_key=api_key,
        model=model,
    )

    # Create custom client with base_url if provided
    if base_url:
        client = AsyncAnthropic(api_key=api_key, base_url=base_url)
        return AnthropicClient(config=llm_config, client=client)

    return AnthropicClient(config=llm_config)
