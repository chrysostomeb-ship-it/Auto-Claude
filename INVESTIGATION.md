# Investigation: v2.7.1 Release Artifacts Issue

## Investigation Date

2025-12-25

## Summary

The v2.7.1 release has **incorrect files attached**. All artifacts have v2.7.0 in their filenames, indicating the wrong build artifacts were uploaded.

---

## Phase 1: Reproduce and Verify Issue

### Subtask 1-1: Current v2.7.1 Assets

**Command:** `gh release view v2.7.1 --json assets -q '.assets[].name'`

**Release Metadata:**
- Tag Name: v2.7.1
- Release Name: v2.7.1
- Published At: 2025-12-22T13:35:38Z
- Is Draft: false
- Is Prerelease: false

**Files Currently Attached to v2.7.1:**

| File Name | Size (bytes) | Expected Name |
|-----------|-------------|---------------|
| Auto-Claude-2.7.0-darwin-arm64.dmg | 124,187,073 | Auto-Claude-2.7.1-darwin-arm64.dmg |
| Auto-Claude-2.7.0-darwin-arm64.zip | 117,694,085 | Auto-Claude-2.7.1-darwin-arm64.zip |
| Auto-Claude-2.7.0-darwin-x64.dmg | 130,635,398 | Auto-Claude-2.7.1-darwin-x64.dmg |
| Auto-Claude-2.7.0-darwin-x64.zip | 124,176,354 | Auto-Claude-2.7.1-darwin-x64.zip |
| Auto-Claude-2.7.0-linux-amd64.deb | 104,558,694 | Auto-Claude-2.7.1-linux-amd64.deb |
| Auto-Claude-2.7.0-linux-x86_64.AppImage | 145,482,885 | Auto-Claude-2.7.1-linux-x86_64.AppImage |
| Auto-Claude-2.7.0-win32-x64.exe | 101,941,972 | Auto-Claude-2.7.1-win32-x64.exe |
| checksums.sha256 | 718 | checksums.sha256 (with v2.7.1 filenames) |

### Issue Confirmed

**Problem:** All 7 platform artifacts attached to v2.7.1 have "2.7.0" in their filename instead of "2.7.1".

**Impact:**
- Users downloading v2.7.1 are receiving v2.7.0 binaries
- File naming does not match the release version
- Checksums file likely references v2.7.0 filenames
- Auto-update mechanisms may be confused by version mismatch

**Evidence:**
```
Files attached to v2.7.1:
- Auto-Claude-2.7.0-darwin-arm64.dmg   (WRONG - should be 2.7.1)
- Auto-Claude-2.7.0-darwin-arm64.zip   (WRONG - should be 2.7.1)
- Auto-Claude-2.7.0-darwin-x64.dmg     (WRONG - should be 2.7.1)
- Auto-Claude-2.7.0-darwin-x64.zip     (WRONG - should be 2.7.1)
- Auto-Claude-2.7.0-linux-amd64.deb    (WRONG - should be 2.7.1)
- Auto-Claude-2.7.0-linux-x86_64.AppImage (WRONG - should be 2.7.1)
- Auto-Claude-2.7.0-win32-x64.exe      (WRONG - should be 2.7.1)
- checksums.sha256                      (likely references wrong filenames)
```

---

### Subtask 1-2: Comparison with v2.7.0 and Expected Naming

**Command:** `gh release view v2.7.0 --json assets -q '.assets[].name'`

#### v2.7.0 Release Analysis

**Release Metadata:**
- Tag Name: v2.7.0
- Release Name: v2.7.0
- Published At: 2025-12-22T13:19:13Z
- Target Commitish: main
- Is Draft: false
- Is Prerelease: false

**Critical Finding:** v2.7.0 has **NO assets attached** (empty assets array).

#### Release Timeline

| Release | Published At | Assets Count | Status |
|---------|-------------|--------------|--------|
| v2.7.0  | 2025-12-22T13:19:13Z | 0 | No files attached |
| v2.7.1  | 2025-12-22T13:35:38Z | 8 | Wrong version in filenames |
| v2.7.2  | 2025-12-22T13:52:51Z | ? | Draft release |

**Observation:** v2.7.0 was published 16 minutes before v2.7.1, but has no artifacts attached.

#### Checksums File Analysis

The `checksums.sha256` file attached to v2.7.1 contains:
```
0a0094ff3e52609665f6f0d6d54180dbfc592956f91ef2cdd94e43a61b6b24d2  ./Auto-Claude-2.7.0-darwin-arm64.dmg
43b168f3073d60644bb111c8fa548369431dc448e67700ed526cb4cad61034e0  ./Auto-Claude-2.7.0-darwin-arm64.zip
5150cbba934fbeb3d97309a493cc8ef3c035e9ec38b31f01382d628025f5c451  ./Auto-Claude-2.7.0-darwin-x64.dmg
ea9139277290a8189f799d00bc3cd1aaf81a16e890ff90327eca01a4cce73e61  ./Auto-Claude-2.7.0-darwin-x64.zip
078b2ba6a2594bf048932776dc31a45e59cd9cb23b34b2cf2f810f4101f04736  ./Auto-Claude-2.7.0-linux-amd64.deb
1feb6b9be348a5e23238e009dbc1ce8b2788103a262cd856613332b3ab1711e9  ./Auto-Claude-2.7.0-linux-x86_64.AppImage
25383314b3bc032ceaf8a8416d5383879ed351c906f03175b8533047647a612d  ./Auto-Claude-2.7.0-win32-x64.exe
```

**Issue:** Checksums file also references v2.7.0 filenames, confirming the build was run with v2.7.0 version.

#### Expected Naming Pattern (from release.yml)

Based on the release workflow analysis, artifacts follow this naming convention:
```
Auto-Claude-{version}-{platform}-{arch}.{ext}
```

Where version comes from `package.json` in `auto-claude-ui/`.

**Expected v2.7.1 Artifacts:**
| Expected Filename | Actual Filename (Wrong) |
|-------------------|-------------------------|
| Auto-Claude-2.7.1-darwin-arm64.dmg | Auto-Claude-2.7.0-darwin-arm64.dmg |
| Auto-Claude-2.7.1-darwin-arm64.zip | Auto-Claude-2.7.0-darwin-arm64.zip |
| Auto-Claude-2.7.1-darwin-x64.dmg | Auto-Claude-2.7.0-darwin-x64.dmg |
| Auto-Claude-2.7.1-darwin-x64.zip | Auto-Claude-2.7.0-darwin-x64.zip |
| Auto-Claude-2.7.1-linux-amd64.deb | Auto-Claude-2.7.0-linux-amd64.deb |
| Auto-Claude-2.7.1-linux-x86_64.AppImage | Auto-Claude-2.7.0-linux-x86_64.AppImage |
| Auto-Claude-2.7.1-win32-x64.exe | Auto-Claude-2.7.0-win32-x64.exe |
| checksums.sha256 (v2.7.1 refs) | checksums.sha256 (v2.7.0 refs) |

#### Hypothesis

The evidence suggests one of the following scenarios:

1. **Tag/Version Mismatch:** The v2.7.1 tag may point to a commit where `package.json` still had version `2.7.0`
2. **Workflow Re-run:** The v2.7.1 release may have been created by re-running the v2.7.0 workflow artifacts
3. **Manual Upload Error:** Artifacts from v2.7.0 were manually attached to the v2.7.1 release
4. **Artifact Caching:** Old workflow artifacts were incorrectly reused for v2.7.1

**Next step:** Check git tags and package.json versions to determine root cause.

---

## Next Steps

1. ~~**Subtask 1-1:** Verify v2.7.1 assets~~ ✅ Complete
2. ~~**Subtask 1-2:** Compare with v2.7.0 release and verify expected naming pattern~~ ✅ Complete
3. **Subtask 1-3:** Check package.json version and git state
4. **Phase 2:** Investigate root cause (tag pointing to wrong commit, workflow issue, manual error)
5. **Phase 3:** Implement fix (re-upload correct files or publish v2.7.2)
6. **Phase 4:** Add validation to prevent future occurrences

---

## Status: Phase 1, Subtask 1-2 Complete

Comparison analysis complete:
- v2.7.0 release has NO assets attached
- v2.7.1 release has v2.7.0 artifacts attached (8 files)
- Checksums file confirms v2.7.0 version was baked into the build
- Timeline suggests possible workflow or tagging issue
