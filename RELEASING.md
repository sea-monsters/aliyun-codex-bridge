# Releasing

This document describes the release process for aliyun-codex-bridge.

## Version Policy

- **Patch releases only** (0.1.0 baseline)
- Current stable line: **0.1.x**
- No minor or major bumps without explicit discussion
- Always increment by +0.0.1 from current version

## Release Steps

### 1. Run Tests

```bash
# Set your API key
export AI_API_KEY="sk-your-key"

# Run unit tests (mandatory)
npm run test:unit

# Run integration test suite (optional but recommended)
npm run test:curl
# or
npm test
```

### 2. Bump Version

```bash
# Use the release script (recommended)
npm run release:patch

# Or manually edit package.json and change:
# "version": "0.1.1" -> "version": "0.1.2"
```

### 3. Update CHANGELOG.md

Add an entry for the new version following [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) format.

### 4. Commit

```bash
git add package.json package-lock.json CHANGELOG.md README.md docs/guide.md RELEASING.md
git commit -m "chore: release v0.1.2"
```

### 5. Tag

```bash
git tag v0.1.2
```

### 6. Push (Optional)

```bash
git push
git push --tags
```

### 7. Publish to npm

```bash
# Optional: remove local runtime artifacts before publish
pwsh -File scripts/prepare-clean-release.ps1

# Optional: secret scan
rg -n "sk-[A-Za-z0-9_-]{10,}|AI_API_KEY\\s*=|DASHSCOPE_API_KEY\\s*=" -S . --glob "!node_modules/**" --glob "!.git/**"

npm publish
```

`prepare-clean-release.ps1` currently removes `response.log`, `*.tmp`, `tmp/*`, and `logs/*.{log,json,sse,txt,tmp}` artifacts.

## release:patch Script

The `npm run release:patch` script:

1. Verifies current version is in `0.1.x`
2. Bumps patch version by +0.0.1
3. Refuses to bump minor/major versions
4. Updates package.json in-place

Example:
```bash
$ npm run release:patch
Current version: 0.1.1
Bumping to: 0.1.2
Updated package.json
```
