"""
Multi-Profile Configuration for Auto Claude.

Supports switching between different API providers:
- Z.AI (GLM-4.7) - Default, free/unlimited
- Claude Max (Opus 4.5) - Fallback when rate limited

Profile switching can be:
1. Manual: Set ACTIVE_PROFILE in .env
2. Automatic: Falls back to Claude Max when Z.AI rate limits

Environment Variables:
  ACTIVE_PROFILE: 'zai' (default) or 'claude_max'

  ZAI_AUTH_TOKEN: Z.AI API token
  ZAI_BASE_URL: Z.AI proxy URL
  ZAI_MODEL: Model to use (default: glm-4.7)

  CLAUDE_MAX_TOKEN: Claude Max OAuth token
  CLAUDE_MAX_MODEL: Model to use (default: claude-opus-4-5-20251101)
"""

import os
from dataclasses import dataclass
from typing import Optional


@dataclass
class ProfileConfig:
    """Configuration for an API profile."""
    name: str
    auth_token: str
    base_url: Optional[str]
    model: str
    description: str


# Rate limit error patterns from different providers
RATE_LIMIT_PATTERNS = [
    "rate limit",
    "rate_limit",
    "too many requests",
    "429",
    "limit usage",
    "usage limit",
    "exceeded",
    "overloaded",
    "quota",
]


def is_rate_limit_error(error_message: str) -> bool:
    """Check if an error message indicates rate limiting."""
    error_lower = error_message.lower()
    return any(pattern in error_lower for pattern in RATE_LIMIT_PATTERNS)


def get_zai_profile() -> Optional[ProfileConfig]:
    """Get Z.AI profile configuration."""
    token = os.environ.get("ZAI_AUTH_TOKEN")
    if not token:
        return None

    return ProfileConfig(
        name="zai",
        auth_token=token,
        base_url=os.environ.get("ZAI_BASE_URL", "https://api.z.ai/api/anthropic"),
        model=os.environ.get("ZAI_MODEL", "glm-4.7"),
        description="Z.AI (GLM-4.7) - Free/unlimited",
    )


def get_claude_max_profile() -> Optional[ProfileConfig]:
    """Get Claude Max profile configuration."""
    token = os.environ.get("CLAUDE_MAX_TOKEN")
    if not token:
        return None

    return ProfileConfig(
        name="claude_max",
        auth_token=token,
        base_url=None,  # Use default Anthropic API
        model=os.environ.get("CLAUDE_MAX_MODEL", "claude-opus-4-5-20251101"),
        description="Claude Max (Opus 4.5)",
    )


def get_active_profile_name() -> str:
    """Get the currently active profile name."""
    return os.environ.get("ACTIVE_PROFILE", "zai").lower()


def get_profile(name: str) -> Optional[ProfileConfig]:
    """Get a profile by name."""
    if name == "zai":
        return get_zai_profile()
    elif name == "claude_max":
        return get_claude_max_profile()
    return None


def get_active_profile() -> Optional[ProfileConfig]:
    """Get the currently active profile configuration."""
    profile_name = get_active_profile_name()
    return get_profile(profile_name)


def get_fallback_profile() -> Optional[ProfileConfig]:
    """Get the fallback profile (the one not currently active)."""
    active_name = get_active_profile_name()
    if active_name == "zai":
        return get_claude_max_profile()
    else:
        return get_zai_profile()


def switch_to_fallback() -> Optional[ProfileConfig]:
    """
    Switch to the fallback profile.

    Updates environment variables to use the fallback profile.
    Returns the new active profile, or None if no fallback available.
    """
    fallback = get_fallback_profile()
    if not fallback:
        return None

    # Update active profile
    os.environ["ACTIVE_PROFILE"] = fallback.name

    # Apply profile settings to environment
    apply_profile_to_env(fallback)

    print(f"\n[Profile Switch] Switched to: {fallback.description}")
    return fallback


def apply_profile_to_env(profile: ProfileConfig) -> None:
    """Apply a profile's configuration to environment variables."""
    # Set auth token
    os.environ["CLAUDE_CODE_OAUTH_TOKEN"] = profile.auth_token
    os.environ["ANTHROPIC_AUTH_TOKEN"] = profile.auth_token

    # Set base URL (or clear it for direct Anthropic API)
    if profile.base_url:
        os.environ["ANTHROPIC_BASE_URL"] = profile.base_url
    elif "ANTHROPIC_BASE_URL" in os.environ:
        del os.environ["ANTHROPIC_BASE_URL"]

    # Set model
    os.environ["AUTO_BUILD_MODEL"] = profile.model


def initialize_active_profile() -> Optional[ProfileConfig]:
    """
    Initialize the environment with the active profile settings.

    Should be called at startup to ensure env vars match the active profile.
    Returns the active profile, or None if no valid profile found.
    """
    profile = get_active_profile()
    if profile:
        apply_profile_to_env(profile)
        return profile

    # No active profile configured, try fallback
    return switch_to_fallback()


def get_model_for_profile() -> str:
    """Get the model to use based on active profile."""
    profile = get_active_profile()
    if profile:
        return profile.model

    # Fallback to env var or default
    return os.environ.get("AUTO_BUILD_MODEL", "claude-sonnet-4-20250514")


def list_available_profiles() -> list[ProfileConfig]:
    """List all configured profiles."""
    profiles = []

    zai = get_zai_profile()
    if zai:
        profiles.append(zai)

    claude_max = get_claude_max_profile()
    if claude_max:
        profiles.append(claude_max)

    return profiles


def print_profile_status() -> None:
    """Print current profile status."""
    active = get_active_profile()
    fallback = get_fallback_profile()

    print("\n=== Profile Configuration ===")
    if active:
        print(f"  Active: {active.description}")
        print(f"    - Model: {active.model}")
        print(f"    - Base URL: {active.base_url or 'default (api.anthropic.com)'}")
    else:
        print("  Active: None configured")

    if fallback:
        print(f"  Fallback: {fallback.description}")
        print(f"    - Model: {fallback.model}")
    else:
        print("  Fallback: None configured")
    print()
