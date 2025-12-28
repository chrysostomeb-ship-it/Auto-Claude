"""
Authentication helpers for Auto Claude.

Provides centralized authentication token resolution with fallback support
for multiple environment variables, and SDK environment variable passthrough
for custom API endpoints.

Supports multi-profile configuration:
- Z.AI (GLM-4.7) as default
- Claude Max (Opus 4.5) as fallback when rate limited
"""

import json
import os
import platform
import subprocess

from core.profiles import get_active_profile, initialize_active_profile

# Priority order for auth token resolution
# NOTE: We intentionally do NOT fall back to ANTHROPIC_API_KEY.
# Auto Claude is designed to use Claude Code OAuth tokens only.
# This prevents silent billing to user's API credits when OAuth fails.
AUTH_TOKEN_ENV_VARS = [
    "CLAUDE_CODE_OAUTH_TOKEN",  # OAuth token from Claude Code CLI
    "ANTHROPIC_AUTH_TOKEN",  # CCR/proxy token (for enterprise setups)
]

# Environment variables to pass through to SDK subprocess
# NOTE: ANTHROPIC_API_KEY is intentionally excluded to prevent silent API billing
SDK_ENV_VARS = [
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_AUTH_TOKEN",
    "NO_PROXY",
    "DISABLE_TELEMETRY",
    "DISABLE_COST_WARNINGS",
    "API_TIMEOUT_MS",
]


def get_token_from_keychain() -> str | None:
    """
    Get authentication token from macOS Keychain.

    Reads Claude Code credentials from macOS Keychain and extracts the OAuth token.
    Only works on macOS (Darwin platform).

    Returns:
        Token string if found in Keychain, None otherwise
    """
    # Only attempt on macOS
    if platform.system() != "Darwin":
        return None

    try:
        # Query macOS Keychain for Claude Code credentials
        result = subprocess.run(
            [
                "/usr/bin/security",
                "find-generic-password",
                "-s",
                "Claude Code-credentials",
                "-w",
            ],
            capture_output=True,
            text=True,
            timeout=5,
        )

        if result.returncode != 0:
            return None

        # Parse JSON response
        credentials_json = result.stdout.strip()
        if not credentials_json:
            return None

        data = json.loads(credentials_json)

        # Extract OAuth token from nested structure
        token = data.get("claudeAiOauth", {}).get("accessToken")

        if not token:
            return None

        # Validate token format (Claude OAuth tokens start with sk-ant-oat01-)
        if not token.startswith("sk-ant-oat01-"):
            return None

        return token

    except (subprocess.TimeoutExpired, json.JSONDecodeError, KeyError, Exception):
        # Silently fail - this is a fallback mechanism
        return None


def get_auth_token() -> str | None:
    """
    Get authentication token from active profile or environment variables.

    Checks multiple sources in priority order:
    1. Active profile (ZAI or Claude Max based on ACTIVE_PROFILE)
    2. CLAUDE_CODE_OAUTH_TOKEN (env var)
    3. ANTHROPIC_AUTH_TOKEN (CCR/proxy env var for enterprise setups)
    4. macOS Keychain (if on Darwin platform)

    NOTE: ANTHROPIC_API_KEY is intentionally NOT supported to prevent
    silent billing to user's API credits when OAuth is misconfigured.

    Returns:
        Token string if found, None otherwise
    """
    # First check active profile
    profile = get_active_profile()
    if profile:
        return profile.auth_token

    # Then check environment variables
    for var in AUTH_TOKEN_ENV_VARS:
        token = os.environ.get(var)
        if token:
            return token

    # Fallback to macOS Keychain
    return get_token_from_keychain()


def get_auth_token_source() -> str | None:
    """Get the name of the source that provided the auth token."""
    # Check active profile first
    profile = get_active_profile()
    if profile:
        return f"Profile: {profile.description}"

    # Check environment variables
    for var in AUTH_TOKEN_ENV_VARS:
        if os.environ.get(var):
            return var

    # Check if token came from macOS Keychain
    if get_token_from_keychain():
        return "macOS Keychain"

    return None


def require_auth_token() -> str:
    """
    Get authentication token or raise ValueError.

    Raises:
        ValueError: If no auth token is found in any supported source
    """
    token = get_auth_token()
    if not token:
        error_msg = (
            "No OAuth token found.\n\n"
            "Auto Claude requires Claude Code OAuth authentication.\n"
            "Direct API keys (ANTHROPIC_API_KEY) are not supported.\n\n"
        )
        # Provide platform-specific guidance
        if platform.system() == "Darwin":
            error_msg += (
                "To authenticate:\n"
                "  1. Run: claude setup-token\n"
                "  2. The token will be saved to macOS Keychain automatically\n\n"
                "Or set CLAUDE_CODE_OAUTH_TOKEN in your .env file."
            )
        else:
            error_msg += (
                "To authenticate:\n"
                "  1. Run: claude setup-token\n"
                "  2. Set CLAUDE_CODE_OAUTH_TOKEN in your .env file"
            )
        raise ValueError(error_msg)
    return token


def get_sdk_env_vars() -> dict[str, str]:
    """
    Get environment variables to pass to SDK.

    Collects relevant env vars (ANTHROPIC_BASE_URL, etc.) that should
    be passed through to the claude-agent-sdk subprocess.

    Also includes profile-specific settings if a profile is active.

    Returns:
        Dict of env var name -> value for non-empty vars
    """
    env = {}

    # Apply active profile settings first
    profile = get_active_profile()
    if profile:
        env["ANTHROPIC_AUTH_TOKEN"] = profile.auth_token
        if profile.base_url:
            env["ANTHROPIC_BASE_URL"] = profile.base_url

    # Collect other SDK env vars (may override profile settings)
    for var in SDK_ENV_VARS:
        value = os.environ.get(var)
        if value:
            env[var] = value

    return env


def ensure_claude_code_oauth_token() -> None:
    """
    Ensure CLAUDE_CODE_OAUTH_TOKEN is set (for SDK compatibility).

    If not set but other auth tokens are available, copies the value
    to CLAUDE_CODE_OAUTH_TOKEN so the underlying SDK can use it.
    """
    if os.environ.get("CLAUDE_CODE_OAUTH_TOKEN"):
        return

    token = get_auth_token()
    if token:
        os.environ["CLAUDE_CODE_OAUTH_TOKEN"] = token


def setup_profiles() -> None:
    """
    Initialize and setup profile configuration at startup.

    This should be called early in the application startup to:
    1. Initialize the active profile from ACTIVE_PROFILE env var
    2. Apply profile settings to environment variables
    3. Print profile status for debugging
    """
    from core.profiles import initialize_active_profile, print_profile_status

    profile = initialize_active_profile()
    if profile:
        print_profile_status()
    else:
        print("[Profiles] No profiles configured, using environment variables")
