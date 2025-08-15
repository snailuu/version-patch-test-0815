# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

This is a GitHub Action for automatic package version patching, designed to automatically increment package.json version numbers based on branch and PR labels in a semantic versioning workflow.

## Commands

### Build and Development
- `pnpm install` - Install dependencies
- `pnpm build` - Build the action using tsup (outputs to dist/index.cjs)
- `pnpm dev` - Build in watch mode (note: README mentions this but no dev script exists in package.json)

### Code Quality
- `pnpm check` - Run Biome linter and formatter with auto-fix
- `pnpm format` - Run Biome formatter only

## Architecture

### Core Components

**src/index.ts** - Main entry point containing the GitHub Action logic:
- Handles PR-based and push-based version bumping
- Supports three branches: `main`, `beta`, and `alpha`
- Uses PR labels (`major`, `minor`, `patch`) to determine version increment type
- Implements complex branch synchronization logic between main → beta → alpha

**src/core.ts** - Simple wrapper around GitHub Actions core utilities providing a logger interface

### Version Management Strategy

The action implements a three-tier branching strategy:

1. **main branch** - Production releases (removes prerelease identifiers)
2. **beta branch** - Pre-release versions with `-beta` suffix  
3. **alpha branch** - Development versions with `-alpha` suffix

Version bumping behavior:
- Uses semver library for version calculations
- PR labels determine bump type: `major` → premajor, `minor` → preminor, `patch` → prepatch
- Automatic branch synchronization: main changes flow to beta, beta changes flow to alpha
- Handles merge conflicts during synchronization with fallback strategies

### Dependencies

Key external dependencies:
- `@actions/core`, `@actions/exec`, `@actions/github` - GitHub Actions runtime
- `semver` - Semantic version parsing and manipulation
- `pkg-types` - Package.json reading/writing utilities

### Build Configuration

- **tsup**: Bundles all dependencies into single CJS file at dist/index.cjs
- **Biome**: Code formatting and linting (120 char line width, single quotes, space indentation)
- **TypeScript**: Configured for Node.js development

### GitHub Action Configuration

Located in `action.yaml`:
- Requires `token` input (GitHub token for repository operations)
- Runs on Node.js 20
- Executes the built dist/index.cjs file

The action is triggered by:
- PR events with labels on main/alpha/beta branches
- Push events to main/alpha/beta branches
- Repository dispatch events for label changes

### Testing

No test framework is currently configured in this project.