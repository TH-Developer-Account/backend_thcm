#!/bin/bash
set -e

echo "→ Pulling latest code..."
git pull origin develop

echo "→ Building new image..."
docker compose build --no-cache

echo "→ Running migrations..."
docker compose run --rm -e DATABASE_URL=postgresql://postgres:123@postgres:5432/postgres api npx prisma migrate deploy

echo "→ Restarting service..."
docker compose up -d

echo "→ Cleaning up old images..."
docker image prune -f

echo "✓ api-service deployed"