#!/usr/bin/env bash
set -euo pipefail

TODAY=$(date +%Y%m%d)
CURRENT=$(grep -o '"version": "[^"]*"' package.json | cut -d'"' -f4)

# Parse current major.minor.patch and date suffix
if [[ "$CURRENT" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)-(.*)$ ]]; then
  MAJOR="${BASH_REMATCH[1]}"
  MINOR="${BASH_REMATCH[2]}"
  PATCH="${BASH_REMATCH[3]}"
  SUFFIX="${BASH_REMATCH[4]}"
  if [ "$SUFFIX" = "$TODAY" ]; then
    PATCH=$((PATCH + 1))
  else
    PATCH=$((PATCH + 1))
  fi
  VERSION="${MAJOR}.${MINOR}.${PATCH}-${TODAY}"
else
  # Fallback: just append today's date
  VERSION="${CURRENT}-${TODAY}"
fi

# Allow override via argument
VERSION="${1:-$VERSION}"

echo "Current: $CURRENT -> New: $VERSION"

echo "1. Bumping version to $VERSION..."
sed -i.bak "s/\"version\": \"[^\"]*\"/\"version\": \"$VERSION\"/" package.json && rm -f package.json.bak

echo "2. Commit and push"
git add package.json && git commit -m "bump version $VERSION" && git push

echo "3. Running changelog workflow..."
gh workflow run Changelog --field version="$VERSION"

echo "4. Sleeping 10s for changelog to complete..."
sleep 10

echo "5. Pulling changelog changes..."
git pull

echo "6. Creating tag v$VERSION..."
git tag "v$VERSION"

echo "7. Pushing tag..."
git push --tags

echo "Done. Release v$VERSION tagged and pushed."
