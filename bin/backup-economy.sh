#!/bin/bash
# EconomyClaw — Economy State Backup
# Runs nightly. Backs up config, audit logs, and service state to iCloud.

BACKUP_DIR="$HOME/Library/Mobile Documents/com~apple~CloudDocs/EconomyClaw-Backup/ec-prime"
DATE=$(date +%Y-%m-%d)

mkdir -p "${BACKUP_DIR}/${DATE}"

# Backup economy configs and state
rsync -av --exclude='node_modules' --exclude='*.log' \
  ~/economy/services/ "${BACKUP_DIR}/${DATE}/economy-services/" 2>/dev/null

rsync -av \
  ~/economy/chamber/governor/config.json \
  ~/economy/services/registry.json \
  "${BACKUP_DIR}/${DATE}/" 2>/dev/null

# Backup trading config
rsync -av --exclude='node_modules' --exclude='*.log' \
  ~/trading/config/ "${BACKUP_DIR}/${DATE}/trading-config/" 2>/dev/null

# Backup audit log
cp ~/economy/services/audit/economy.log "${BACKUP_DIR}/${DATE}/economy-audit.log" 2>/dev/null

# Backup ecosystem configs
cp ~/economy/ecosystem.config.js "${BACKUP_DIR}/${DATE}/"
cp ~/trading/ecosystem.config.js "${BACKUP_DIR}/${DATE}/trading-ecosystem.config.js"

echo "$(date '+%Y-%m-%d %H:%M:%S') Backup complete: ${BACKUP_DIR}/${DATE}"
