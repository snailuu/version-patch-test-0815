# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

This is a GitHub Action for automatic package version patching, designed to automatically increment package.json version numbers based on branch and PR labels in a semantic versioning workflow.

## Commands

### Build and Development
- `pnpm install` - Install dependencies
- `pnpm build` - Build the action using tsup (outputs to dist/index.cjs)
- Note: README mentions `pnpm dev` but no dev script exists in package.json

### Code Quality
- `pnpm check` - Run Biome linter and formatter with auto-fix
- `pnpm format` - Run Biome formatter only

## Architecture

### Core Components

**src/index.ts** - Main entry point orchestrating the GitHub Action workflow:
- Handles PR-based (preview mode) and push-based (execution mode) events
- Integrates all modular components for version management
- Manages error handling and Action outputs

**src/core.ts** - Simple wrapper around GitHub Actions core utilities providing a logger interface

**src/git.ts** - Git operations and branch synchronization logic:
- Git command execution utilities (`execGit`, `execGitWithOutput`)
- File change detection and commit/push operations
- CHANGELOG generation using conventional-changelog-cli
- Branch synchronization with intelligent conflict resolution
- Automatic issue creation for unresolvable merge conflicts

**src/version.ts** - Version calculation and management:
- `VersionUtils` class with prefix handling, parsing, and normalization
- Git tag operations and version comparison logic
- Base version calculation from upstream branches
- Version upgrade algorithms based on labels and branch hierarchy
- Package.json version file updates

**src/pr.ts** - GitHub Pull Request operations:
- `PRUtils` class for PR label validation and release type detection
- PR information retrieval for both pull_request and push events
- Comment management (create/update version previews, errors, skip messages)
- Event validation and branch support checking

**src/types.ts** - TypeScript type definitions and constants:
- Core types: `SupportedBranch`, `VersionInfo`, `PRData`, `VersionPreviewData`
- Configuration constants: version prefixes, Git user config, default versions
- Message templates: comments, commits, error messages
- Error handling with `ActionError` class and type guards

### Version Management Strategy

The action implements a three-tier branching strategy:

1. **main branch** - Production releases (removes prerelease identifiers)
2. **beta branch** - Pre-release versions with `-beta` suffix  
3. **alpha branch** - Development versions with `-alpha` suffix

Version bumping behavior:
- Uses semver library for version calculations
- PR labels determine bump type: `major` → premajor, `minor` → preminor, `patch` → prepatch
- **Alpha branch**: Adds `-alpha` prerelease identifier, upgrades existing alpha versions
- **Beta branch**: Always increments to next `prerelease` with `-beta` identifier
- **Main branch**: Removes prerelease identifiers, creates patch release
- Automatic branch synchronization: main → beta, beta → alpha
- Complex conflict resolution: preserves higher version numbers during merges

### Dependencies

Key external dependencies:
- `@actions/core`, `@actions/exec`, `@actions/github` - GitHub Actions runtime
- `semver` - Semantic version parsing and manipulation
- `pkg-types` - Package.json reading/writing utilities

### Build Configuration

- **tsup**: Bundles all dependencies into single CJS file at dist/index.cjs (configured to include all dependencies via `noExternal`)
- **Biome**: Code formatting and linting (120 char line width, single quotes, space indentation, allows explicit `any`, disables non-null assertions)
- **TypeScript**: Configured for Node.js development with ES modules

### GitHub Action Configuration

Located in `action.yaml`:
- Requires `token` input (GitHub token for repository operations)
- Runs on Node.js 20
- Executes the built dist/index.cjs file

The action is triggered by:
- PR events with labels on main/alpha/beta branches
- Push events to main/alpha/beta branches
- Repository dispatch events for label changes

### Known Issues

As documented in todo.md:
- **Merge conflicts**: Alpha branch changes can be lost during beta→alpha sync when alpha version is higher than beta
- **Label persistence**: PR labels cause continuous version bumps instead of incrementing prerelease numbers
- **Missing automation**: No automatic issue creation for unresolvable merge conflicts

### Testing

No test framework currently configured in the repository.

ALWAYS prefer editing an existing file to creating a new one.
NEVER proactively create documentation files (*.md) or README files. Only create documentation files if explicitly requested by the User.
