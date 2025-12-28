"""
Ollama LLM Provider
===================

Ollama LLM client implementation for Graphiti (using OpenAI-compatible interface).
"""

from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from graphiti_config import GraphitiConfig

from ..exceptions import ProviderError, ProviderNotInstalled


def create_ollama_llm_client(config: "GraphitiConfig") -> Any:
    """
    Create Ollama LLM client (using OpenAI-compatible interface).

    Args:
        config: GraphitiConfig with Ollama settings

    Returns:
        Ollama LLM client instance

    Raises:
        ProviderNotInstalled: If graphiti-core is not installed
        ProviderError: If model is not specified
    """
    import os

    try:
        from graphiti_core.llm_client.config import LLMConfig
        from graphiti_core.llm_client.openai_generic_client import OpenAIGenericClient
    except ImportError as e:
        raise ProviderNotInstalled(
            f"Ollama provider requires graphiti-core. "
            f"Install with: pip install graphiti-core\n"
            f"Error: {e}"
        )

    if not config.ollama_llm_model:
        raise ProviderError("Ollama provider requires OLLAMA_LLM_MODEL")

    # Support separate base URL for LLM (e.g., Z.AI proxy)
    # Priority: GRAPHITI_LLM_BASE_URL > OLLAMA_BASE_URL
    base_url = os.environ.get("GRAPHITI_LLM_BASE_URL", config.ollama_base_url)
    if not base_url.endswith("/v1"):
        base_url = base_url.rstrip("/") + "/v1"

    # Get API key from env (for proxies like Z.AI that need auth)
    api_key = os.environ.get("GRAPHITI_LLM_API_KEY", "ollama")

    llm_config = LLMConfig(
        api_key=api_key,
        model=config.ollama_llm_model,
        small_model=config.ollama_llm_model,
        base_url=base_url,
    )

    return OpenAIGenericClient(config=llm_config)
