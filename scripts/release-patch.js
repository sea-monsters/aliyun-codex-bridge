#!/usr/bin/env node

/**
 * Safe patch version bumper
 * Only allows patch releases from 0.1.0 base line
 * Refuses minor/major bumps
 */

const fs = require('fs');
const path = require('path');

const PACKAGE_PATH = path.join(__dirname, '..', 'package.json');

function bumpPatch(version) {
  const parts = version.split('.').map(Number);

  if (parts.length !== 3) {
    throw new Error(`Invalid version format: ${version}`);
  }

  const [major, minor, patch] = parts;

  // Only allow 0.1.x versions
  if (major !== 0 || minor !== 1) {
    console.error(`ERROR: Current version is ${version}`);
    console.error('This script only supports patch releases for 0.1.x versions.');
    console.error('For other version changes, edit package.json manually.');
    process.exit(1);
  }

  const newVersion = `0.1.${patch + 1}`;
  return newVersion;
}

function main() {
  // Read package.json
  const pkg = JSON.parse(fs.readFileSync(PACKAGE_PATH, 'utf8'));
  const currentVersion = pkg.version;

  console.log(`Current version: ${currentVersion}`);

  // Bump patch
  const newVersion = bumpPatch(currentVersion);
  console.log(`Bumping to: ${newVersion}`);

  // Update package.json
  pkg.version = newVersion;

  // Write back
  fs.writeFileSync(PACKAGE_PATH, JSON.stringify(pkg, null, 2) + '\n');

  console.log('Updated package.json');
  console.log('\nNext steps:');
  console.log('  1. Update CHANGELOG.md');
  console.log('  2. Commit: git add package.json CHANGELOG.md && git commit -m "chore: release v' + newVersion + '"');
  console.log('  3. Tag: git tag v' + newVersion);
  console.log('  4. Publish: npm publish');
}

main();
