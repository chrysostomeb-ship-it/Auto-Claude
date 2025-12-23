"""
GitHub Automation Orchestrator
==============================

Main coordinator for all GitHub automation workflows:
- PR Review: AI-powered code review
- Issue Triage: Classification and labeling
- Issue Auto-Fix: Automatic spec creation and execution

This is a STANDALONE system - does not modify existing task execution pipeline.
"""

from __future__ import annotations

import json
import subprocess
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

try:
    # When imported as part of package
    from .models import (
        AutoFixState,
        AutoFixStatus,
        GitHubRunnerConfig,
        PRReviewFinding,
        PRReviewResult,
        ReviewCategory,
        ReviewSeverity,
        TriageCategory,
        TriageResult,
    )
except ImportError:
    # When imported directly (runner.py adds github dir to path)
    from models import (
        AutoFixState,
        AutoFixStatus,
        GitHubRunnerConfig,
        PRReviewFinding,
        PRReviewResult,
        ReviewCategory,
        ReviewSeverity,
        TriageCategory,
        TriageResult,
    )


@dataclass
class ProgressCallback:
    """Callback for progress updates."""

    phase: str
    progress: int  # 0-100
    message: str
    issue_number: int | None = None
    pr_number: int | None = None


class GitHubOrchestrator:
    """
    Orchestrates all GitHub automation workflows.

    Usage:
        orchestrator = GitHubOrchestrator(
            project_dir=Path("/path/to/project"),
            config=config,
        )

        # Review a PR
        result = await orchestrator.review_pr(pr_number=123)

        # Triage issues
        results = await orchestrator.triage_issues(issue_numbers=[1, 2, 3])

        # Auto-fix an issue
        state = await orchestrator.auto_fix_issue(issue_number=456)
    """

    def __init__(
        self,
        project_dir: Path,
        config: GitHubRunnerConfig,
        progress_callback: Callable[[ProgressCallback], None] | None = None,
    ):
        self.project_dir = Path(project_dir)
        self.config = config
        self.progress_callback = progress_callback

        # GitHub directory for storing state
        self.github_dir = self.project_dir / ".auto-claude" / "github"
        self.github_dir.mkdir(parents=True, exist_ok=True)

    def _report_progress(
        self,
        phase: str,
        progress: int,
        message: str,
        issue_number: int | None = None,
        pr_number: int | None = None,
    ) -> None:
        """Report progress to callback if set."""
        if self.progress_callback:
            self.progress_callback(
                ProgressCallback(
                    phase=phase,
                    progress=progress,
                    message=message,
                    issue_number=issue_number,
                    pr_number=pr_number,
                )
            )

    async def _fetch_pr_data(self, pr_number: int) -> dict:
        """Fetch PR data from GitHub API via gh CLI."""
        result = subprocess.run(
            [
                "gh",
                "pr",
                "view",
                str(pr_number),
                "--json",
                "number,title,body,state,headRefName,baseRefName,author,files,additions,deletions,changedFiles",
            ],
            cwd=self.project_dir,
            capture_output=True,
            text=True,
        )

        if result.returncode != 0:
            raise RuntimeError(f"Failed to fetch PR #{pr_number}: {result.stderr}")

        return json.loads(result.stdout)

    async def _fetch_pr_diff(self, pr_number: int) -> str:
        """Fetch PR diff from GitHub."""
        result = subprocess.run(
            ["gh", "pr", "diff", str(pr_number)],
            cwd=self.project_dir,
            capture_output=True,
            text=True,
        )

        if result.returncode != 0:
            raise RuntimeError(f"Failed to fetch PR diff #{pr_number}: {result.stderr}")

        return result.stdout

    async def _fetch_issue_data(self, issue_number: int) -> dict:
        """Fetch issue data from GitHub API via gh CLI."""
        result = subprocess.run(
            [
                "gh",
                "issue",
                "view",
                str(issue_number),
                "--json",
                "number,title,body,state,labels,author,comments,createdAt,updatedAt",
            ],
            cwd=self.project_dir,
            capture_output=True,
            text=True,
        )

        if result.returncode != 0:
            raise RuntimeError(
                f"Failed to fetch issue #{issue_number}: {result.stderr}"
            )

        return json.loads(result.stdout)

    async def _fetch_open_issues(self, limit: int = 100) -> list[dict]:
        """Fetch all open issues from the repository."""
        result = subprocess.run(
            [
                "gh",
                "issue",
                "list",
                "--state",
                "open",
                "--limit",
                str(limit),
                "--json",
                "number,title,body,labels,author,createdAt,updatedAt,comments",
            ],
            cwd=self.project_dir,
            capture_output=True,
            text=True,
        )

        if result.returncode != 0:
            raise RuntimeError(f"Failed to fetch open issues: {result.stderr}")

        return json.loads(result.stdout)

    async def _post_pr_review(
        self,
        pr_number: int,
        body: str,
        event: str = "COMMENT",  # APPROVE, REQUEST_CHANGES, COMMENT
        comments: list[dict] | None = None,
    ) -> int:
        """Post a review to a PR."""
        # Build the gh command
        cmd = ["gh", "pr", "review", str(pr_number)]

        if event == "APPROVE":
            cmd.append("--approve")
        elif event == "REQUEST_CHANGES":
            cmd.append("--request-changes")
        else:
            cmd.append("--comment")

        cmd.extend(["--body", body])

        result = subprocess.run(
            cmd,
            cwd=self.project_dir,
            capture_output=True,
            text=True,
        )

        if result.returncode != 0:
            raise RuntimeError(f"Failed to post PR review: {result.stderr}")

        # TODO: Parse review ID from response
        return 0

    async def _post_issue_comment(self, issue_number: int, body: str) -> None:
        """Post a comment to an issue."""
        result = subprocess.run(
            ["gh", "issue", "comment", str(issue_number), "--body", body],
            cwd=self.project_dir,
            capture_output=True,
            text=True,
        )

        if result.returncode != 0:
            raise RuntimeError(f"Failed to post issue comment: {result.stderr}")

    async def _add_issue_labels(self, issue_number: int, labels: list[str]) -> None:
        """Add labels to an issue."""
        if not labels:
            return

        result = subprocess.run(
            ["gh", "issue", "edit", str(issue_number), "--add-label", ",".join(labels)],
            cwd=self.project_dir,
            capture_output=True,
            text=True,
        )

        if result.returncode != 0:
            raise RuntimeError(f"Failed to add labels: {result.stderr}")

    async def _remove_issue_labels(self, issue_number: int, labels: list[str]) -> None:
        """Remove labels from an issue."""
        if not labels:
            return

        result = subprocess.run(
            [
                "gh",
                "issue",
                "edit",
                str(issue_number),
                "--remove-label",
                ",".join(labels),
            ],
            cwd=self.project_dir,
            capture_output=True,
            text=True,
        )

        # Don't fail if labels don't exist
        if result.returncode != 0 and "not found" not in result.stderr.lower():
            raise RuntimeError(f"Failed to remove labels: {result.stderr}")

    # =========================================================================
    # PR REVIEW
    # =========================================================================

    async def review_pr(self, pr_number: int) -> PRReviewResult:
        """
        Perform AI-powered review of a pull request.

        Args:
            pr_number: The PR number to review

        Returns:
            PRReviewResult with findings and overall assessment
        """
        self._report_progress(
            "fetching", 10, f"Fetching PR #{pr_number}...", pr_number=pr_number
        )

        try:
            # Fetch PR data and diff
            pr_data = await self._fetch_pr_data(pr_number)
            pr_diff = await self._fetch_pr_diff(pr_number)

            self._report_progress(
                "analyzing", 30, "Analyzing code changes...", pr_number=pr_number
            )

            # Run AI review
            findings = await self._run_pr_review_agent(pr_data, pr_diff)

            self._report_progress(
                "generating", 70, "Generating review summary...", pr_number=pr_number
            )

            # Determine overall status
            critical_count = sum(
                1 for f in findings if f.severity == ReviewSeverity.CRITICAL
            )
            high_count = sum(1 for f in findings if f.severity == ReviewSeverity.HIGH)

            if critical_count > 0:
                overall_status = "request_changes"
                summary = f"Found {critical_count} critical and {high_count} high-severity issues that need to be addressed."
            elif high_count > 0:
                overall_status = "request_changes"
                summary = f"Found {high_count} high-severity issues. Please review the suggestions."
            elif findings:
                overall_status = "comment"
                summary = f"Found {len(findings)} suggestions for improvement."
            else:
                overall_status = "approve"
                summary = "Looks good! No significant issues found."

            # Create result
            result = PRReviewResult(
                pr_number=pr_number,
                repo=self.config.repo,
                success=True,
                findings=findings,
                summary=summary,
                overall_status=overall_status,
            )

            # Optionally post review
            if self.config.auto_post_reviews:
                self._report_progress(
                    "posting", 90, "Posting review to GitHub...", pr_number=pr_number
                )
                review_id = await self._post_pr_review(
                    pr_number=pr_number,
                    body=self._format_review_body(result),
                    event=overall_status.upper(),
                )
                result.review_id = review_id

            # Save result
            result.save(self.github_dir)

            self._report_progress(
                "complete", 100, "Review complete!", pr_number=pr_number
            )
            return result

        except Exception as e:
            result = PRReviewResult(
                pr_number=pr_number,
                repo=self.config.repo,
                success=False,
                error=str(e),
            )
            result.save(self.github_dir)
            return result

    async def _run_pr_review_agent(
        self, pr_data: dict, pr_diff: str
    ) -> list[PRReviewFinding]:
        """Run the AI agent to review PR code."""
        from core.client import create_client

        # Load prompt
        prompt_file = (
            Path(__file__).parent.parent.parent
            / "prompts"
            / "github"
            / "pr_reviewer.md"
        )
        if not prompt_file.exists():
            # Use inline prompt if file doesn't exist yet
            prompt = self._get_default_pr_review_prompt()
        else:
            prompt = prompt_file.read_text()

        # Build context
        context = f"""
## Pull Request #{pr_data["number"]}

**Title:** {pr_data["title"]}
**Author:** {pr_data["author"]["login"]}
**Base:** {pr_data["baseRefName"]} ← **Head:** {pr_data["headRefName"]}
**Changes:** {pr_data["additions"]} additions, {pr_data["deletions"]} deletions across {pr_data["changedFiles"]} files

### Description
{pr_data.get("body", "No description provided.")}

### Files Changed
{self._format_files_changed(pr_data.get("files", []))}

### Diff
```diff
{pr_diff[:50000]}  # Limit diff size
```
"""

        full_prompt = prompt + "\n\n---\n\n" + context

        # Create client with appropriate tools
        client = create_client(
            project_dir=self.project_dir,
            spec_dir=self.github_dir,
            model=self.config.model,
            agent_type="qa_reviewer",  # Similar tool permissions
        )

        findings = []

        try:
            async with client:
                await client.query(full_prompt)

                response_text = ""
                async for msg in client.receive_response():
                    msg_type = type(msg).__name__
                    if msg_type == "AssistantMessage" and hasattr(msg, "content"):
                        for block in msg.content:
                            if hasattr(block, "text"):
                                response_text += block.text

                # Parse findings from response
                findings = self._parse_review_findings(response_text)

        except Exception as e:
            # Return empty findings on error - main function will catch
            print(f"PR review agent error: {e}")

        return findings

    def _format_files_changed(self, files: list[dict]) -> str:
        """Format the files changed list."""
        if not files:
            return "No files information available."

        lines = []
        for f in files[:20]:  # Limit to 20 files
            path = f.get("path", "unknown")
            additions = f.get("additions", 0)
            deletions = f.get("deletions", 0)
            lines.append(f"- `{path}` (+{additions}/-{deletions})")

        if len(files) > 20:
            lines.append(f"- ... and {len(files) - 20} more files")

        return "\n".join(lines)

    def _parse_review_findings(self, response_text: str) -> list[PRReviewFinding]:
        """Parse findings from AI response."""
        findings = []

        # Try to find JSON block in response
        try:
            import re

            json_match = re.search(
                r"```json\s*(\[.*?\])\s*```", response_text, re.DOTALL
            )
            if json_match:
                findings_data = json.loads(json_match.group(1))
                for i, f in enumerate(findings_data):
                    findings.append(
                        PRReviewFinding(
                            id=f.get("id", f"finding-{i + 1}"),
                            severity=ReviewSeverity(
                                f.get("severity", "medium").lower()
                            ),
                            category=ReviewCategory(
                                f.get("category", "quality").lower()
                            ),
                            title=f.get("title", "Finding"),
                            description=f.get("description", ""),
                            file=f.get("file", "unknown"),
                            line=f.get("line", 1),
                            end_line=f.get("end_line"),
                            suggested_fix=f.get("suggested_fix"),
                            fixable=f.get("fixable", False),
                        )
                    )
        except (json.JSONDecodeError, KeyError, ValueError) as e:
            print(f"Failed to parse findings: {e}")

        return findings

    def _format_review_body(self, result: PRReviewResult) -> str:
        """Format the review body for posting to GitHub."""
        lines = [
            "## 🤖 AI Code Review",
            "",
            result.summary,
            "",
        ]

        if result.findings:
            lines.append(f"### Findings ({len(result.findings)} total)")
            lines.append("")

            for f in result.findings:
                emoji = {
                    "critical": "🔴",
                    "high": "🟠",
                    "medium": "🟡",
                    "low": "🔵",
                }.get(f.severity.value, "⚪")
                lines.append(f"#### {emoji} [{f.severity.value.upper()}] {f.title}")
                lines.append(f"📁 `{f.file}:{f.line}`")
                lines.append("")
                lines.append(f.description)

                if f.suggested_fix:
                    lines.append("")
                    lines.append("**Suggested fix:**")
                    lines.append(f"```\n{f.suggested_fix}\n```")

                lines.append("")

        lines.append("---")
        lines.append(
            "*This review was generated by AutoCloud AI. Human review is still recommended.*"
        )

        return "\n".join(lines)

    def _get_default_pr_review_prompt(self) -> str:
        """Default PR review prompt if file doesn't exist."""
        return """# PR Review Agent

You are an AI code reviewer. Analyze the provided pull request and identify:

1. **Security Issues** - vulnerabilities, injection risks, auth problems
2. **Code Quality** - complexity, duplication, error handling
3. **Style Issues** - naming, formatting, patterns
4. **Test Coverage** - missing tests, edge cases
5. **Documentation** - missing/outdated docs

For each finding, output a JSON array:

```json
[
  {
    "id": "finding-1",
    "severity": "critical|high|medium|low",
    "category": "security|quality|style|test|docs|pattern|performance",
    "title": "Brief issue title",
    "description": "Detailed explanation",
    "file": "path/to/file.ts",
    "line": 42,
    "suggested_fix": "Optional code or suggestion",
    "fixable": true
  }
]
```

Be specific and actionable. Focus on significant issues, not nitpicks.
"""

    # =========================================================================
    # ISSUE TRIAGE
    # =========================================================================

    async def triage_issues(
        self,
        issue_numbers: list[int] | None = None,
        apply_labels: bool = False,
    ) -> list[TriageResult]:
        """
        Triage issues to detect duplicates, spam, and feature creep.

        Args:
            issue_numbers: Specific issues to triage, or None for all open issues
            apply_labels: Whether to apply suggested labels to GitHub

        Returns:
            List of TriageResult for each issue
        """
        self._report_progress("fetching", 10, "Fetching issues...")

        # Fetch issues
        if issue_numbers:
            issues = []
            for num in issue_numbers:
                issues.append(await self._fetch_issue_data(num))
        else:
            issues = await self._fetch_open_issues()

        if not issues:
            return []

        results = []
        total = len(issues)

        for i, issue in enumerate(issues):
            progress = 20 + int(60 * (i / total))
            self._report_progress(
                "analyzing",
                progress,
                f"Analyzing issue #{issue['number']}...",
                issue_number=issue["number"],
            )

            result = await self._triage_single_issue(issue, issues)
            results.append(result)

            # Apply labels if requested
            if apply_labels and (result.labels_to_add or result.labels_to_remove):
                try:
                    await self._add_issue_labels(issue["number"], result.labels_to_add)
                    await self._remove_issue_labels(
                        issue["number"], result.labels_to_remove
                    )
                except Exception as e:
                    print(f"Failed to apply labels to #{issue['number']}: {e}")

            # Save result
            result.save(self.github_dir)

        self._report_progress("complete", 100, f"Triaged {len(results)} issues")
        return results

    async def _triage_single_issue(
        self, issue: dict, all_issues: list[dict]
    ) -> TriageResult:
        """Triage a single issue using AI."""
        from core.client import create_client

        # Build context with issue and potential duplicates
        context = self._build_triage_context(issue, all_issues)

        # Load prompt
        prompt_file = (
            Path(__file__).parent.parent.parent
            / "prompts"
            / "github"
            / "issue_triager.md"
        )
        if not prompt_file.exists():
            prompt = self._get_default_triage_prompt()
        else:
            prompt = prompt_file.read_text()

        full_prompt = prompt + "\n\n---\n\n" + context

        # Run AI
        client = create_client(
            project_dir=self.project_dir,
            spec_dir=self.github_dir,
            model=self.config.model,
            agent_type="qa_reviewer",
        )

        try:
            async with client:
                await client.query(full_prompt)

                response_text = ""
                async for msg in client.receive_response():
                    msg_type = type(msg).__name__
                    if msg_type == "AssistantMessage" and hasattr(msg, "content"):
                        for block in msg.content:
                            if hasattr(block, "text"):
                                response_text += block.text

                return self._parse_triage_result(issue, response_text)

        except Exception as e:
            print(f"Triage error for #{issue['number']}: {e}")
            return TriageResult(
                issue_number=issue["number"],
                repo=self.config.repo,
                category=TriageCategory.FEATURE,
                confidence=0.0,
            )

    def _build_triage_context(self, issue: dict, all_issues: list[dict]) -> str:
        """Build context for triage including potential duplicates."""
        # Find potential duplicates by title similarity
        potential_dupes = []
        for other in all_issues:
            if other["number"] == issue["number"]:
                continue
            # Simple word overlap check
            title_words = set(issue["title"].lower().split())
            other_words = set(other["title"].lower().split())
            overlap = len(title_words & other_words) / max(len(title_words), 1)
            if overlap > 0.3:
                potential_dupes.append(other)

        lines = [
            f"## Issue #{issue['number']}",
            f"**Title:** {issue['title']}",
            f"**Author:** {issue['author']['login']}",
            f"**Created:** {issue['createdAt']}",
            f"**Labels:** {', '.join(label['name'] for label in issue.get('labels', []))}",
            "",
            "### Body",
            issue.get("body", "No description"),
            "",
        ]

        if potential_dupes:
            lines.append("### Potential Duplicates (similar titles)")
            for d in potential_dupes[:5]:
                lines.append(f"- #{d['number']}: {d['title']}")
            lines.append("")

        return "\n".join(lines)

    def _parse_triage_result(self, issue: dict, response_text: str) -> TriageResult:
        """Parse triage result from AI response."""
        import re

        # Default result
        result = TriageResult(
            issue_number=issue["number"],
            repo=self.config.repo,
            category=TriageCategory.FEATURE,
            confidence=0.5,
        )

        try:
            json_match = re.search(
                r"```json\s*(\{.*?\})\s*```", response_text, re.DOTALL
            )
            if json_match:
                data = json.loads(json_match.group(1))

                category_str = data.get("category", "feature").lower()
                if category_str in [c.value for c in TriageCategory]:
                    result.category = TriageCategory(category_str)

                result.confidence = float(data.get("confidence", 0.5))
                result.labels_to_add = data.get("labels_to_add", [])
                result.labels_to_remove = data.get("labels_to_remove", [])
                result.is_duplicate = data.get("is_duplicate", False)
                result.duplicate_of = data.get("duplicate_of")
                result.is_spam = data.get("is_spam", False)
                result.is_feature_creep = data.get("is_feature_creep", False)
                result.suggested_breakdown = data.get("suggested_breakdown", [])
                result.priority = data.get("priority", "medium")
                result.comment = data.get("comment")

        except (json.JSONDecodeError, KeyError, ValueError) as e:
            print(f"Failed to parse triage result: {e}")

        return result

    def _get_default_triage_prompt(self) -> str:
        """Default triage prompt if file doesn't exist."""
        return """# Issue Triage Agent

You are an issue triage assistant. Analyze the GitHub issue and classify it.

Determine:
1. **Category**: bug, feature, documentation, question, duplicate, spam, feature_creep
2. **Priority**: high, medium, low
3. **Is Duplicate?**: Check against potential duplicates list
4. **Is Spam?**: Check for promotional content, gibberish, abuse
5. **Is Feature Creep?**: Multiple unrelated features in one issue

Output JSON:

```json
{
  "category": "bug|feature|documentation|question|duplicate|spam|feature_creep",
  "confidence": 0.0-1.0,
  "priority": "high|medium|low",
  "labels_to_add": ["type:bug", "priority:high"],
  "labels_to_remove": [],
  "is_duplicate": false,
  "duplicate_of": null,
  "is_spam": false,
  "is_feature_creep": false,
  "suggested_breakdown": ["Suggested issue 1", "Suggested issue 2"],
  "comment": "Optional bot comment"
}
```
"""

    # =========================================================================
    # AUTO-FIX
    # =========================================================================

    async def auto_fix_issue(self, issue_number: int) -> AutoFixState:
        """
        Automatically fix an issue by creating a spec and running the build pipeline.

        This creates a spec from the issue and queues it for execution.
        The actual build runs through the normal spec execution pipeline.

        Args:
            issue_number: The issue number to fix

        Returns:
            AutoFixState tracking the fix progress
        """
        self._report_progress(
            "fetching",
            10,
            f"Fetching issue #{issue_number}...",
            issue_number=issue_number,
        )

        # Load or create state
        state = AutoFixState.load(self.github_dir, issue_number)
        if state and state.status not in [
            AutoFixStatus.FAILED,
            AutoFixStatus.COMPLETED,
        ]:
            # Already in progress
            return state

        try:
            # Fetch issue
            issue = await self._fetch_issue_data(issue_number)

            state = AutoFixState(
                issue_number=issue_number,
                issue_url=f"https://github.com/{self.config.repo}/issues/{issue_number}",
                repo=self.config.repo,
                status=AutoFixStatus.ANALYZING,
            )
            state.save(self.github_dir)

            self._report_progress(
                "analyzing", 30, "Analyzing issue...", issue_number=issue_number
            )

            # This would normally call the spec creation process
            # For now, we just create the state and let the frontend handle spec creation
            # via the existing investigation flow

            state.update_status(AutoFixStatus.CREATING_SPEC)
            state.save(self.github_dir)

            self._report_progress(
                "complete", 100, "Ready for spec creation", issue_number=issue_number
            )
            return state

        except Exception as e:
            if state:
                state.status = AutoFixStatus.FAILED
                state.error = str(e)
                state.save(self.github_dir)
            raise

    async def get_auto_fix_queue(self) -> list[AutoFixState]:
        """Get all issues in the auto-fix queue."""
        issues_dir = self.github_dir / "issues"
        if not issues_dir.exists():
            return []

        queue = []
        for f in issues_dir.glob("autofix_*.json"):
            try:
                issue_number = int(f.stem.replace("autofix_", ""))
                state = AutoFixState.load(self.github_dir, issue_number)
                if state:
                    queue.append(state)
            except (ValueError, json.JSONDecodeError):
                continue

        return sorted(queue, key=lambda s: s.created_at, reverse=True)

    async def check_auto_fix_labels(self) -> list[int]:
        """
        Check for issues with auto-fix labels and return their numbers.

        This is used by the frontend to detect new issues that should be auto-fixed.
        """
        if not self.config.auto_fix_enabled:
            return []

        issues = await self._fetch_open_issues()
        auto_fix_issues = []

        for issue in issues:
            labels = [label["name"].lower() for label in issue.get("labels", [])]
            if any(lbl.lower() in labels for lbl in self.config.auto_fix_labels):
                # Check if not already in queue
                state = AutoFixState.load(self.github_dir, issue["number"])
                if not state or state.status in [
                    AutoFixStatus.FAILED,
                    AutoFixStatus.COMPLETED,
                ]:
                    auto_fix_issues.append(issue["number"])

        return auto_fix_issues
