#!/bin/bash
# ============================================================
# Spider Store — DigitalOcean Droplet First-Time Setup Script
# Run this ONCE on a fresh Ubuntu 22.04 Droplet as root
# ============================================================

set -e

echo "=== [Setup] Installing Docker ==="
apt-get update -y
apt-get install -y ca-certificates curl gnupg lsb-release git

curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /usr/share/keyrings/docker-archive-keyring.gpg

echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/docker-archive-keyring.gpg] https://download.docker.com/linux/ubuntu \
  $(lsb_release -cs) stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null

apt-get update -y
apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin

# Also install docker-compose v1 (some scripts use it)
curl -L "https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)" \
  -o /usr/local/bin/docker-compose
chmod +x /usr/local/bin/docker-compose

echo "=== [Setup] Docker installed: $(docker --version) ==="
echo "=== [Setup] Docker Compose: $(docker-compose --version) ==="

# Create project directory
mkdir -p /opt/spider-store
cd /opt/spider-store

echo "=== [Setup] Cloning backend repo ==="
git clone https://github.com/minasamir1401/spider-store-back.git .

echo "=== [Setup] Cloning frontend repo ==="
git clone https://github.com/minasamir1401/spider-store-front.git frontend

echo ""
echo "=== [Setup] IMPORTANT: Create your .env file ==="
echo "Run: nano /opt/spider-store/.env"
echo "Add the following variables:"
echo ""
echo "  DATABASE_URL=your_postgresql_connection_string"
echo "  JWT_SECRET=your_very_long_random_secret"
echo "  ADMIN_USERNAME=admin"
echo "  ADMIN_PASSWORD=your_strong_password"
echo "  CORS_ORIGIN=https://your-frontend-domain.com"
echo ""
echo "=== [Setup] After creating .env, run: ==="
echo "  cd /opt/spider-store"
echo "  docker-compose up -d"
echo ""
echo "=== [Setup] Complete! ==="
