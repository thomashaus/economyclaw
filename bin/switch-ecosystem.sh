#!/bin/bash
# EconomyClaw — Time-Sharing Ecosystem Switcher

MODE=$1
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')

case $MODE in
  trading-on)
    echo "[$TIMESTAMP] Switching to TRADING mode" >> ~/economy/services/logs/ecosystem-switch.log
    cd ~/economy && pm2 stop ecosystem.config.js 2>/dev/null
    cd ~/trading && pm2 start ecosystem.config.js
    ;;
  supply-on)
    echo "[$TIMESTAMP] Switching to SUPPLY mode" >> ~/economy/services/logs/ecosystem-switch.log
    cd ~/trading && pm2 stop ecosystem.config.js 2>/dev/null
    cd ~/economy && pm2 start ecosystem.config.js
    ;;
  status)
    pm2 status
    ;;
  *)
    echo "Usage: switch-ecosystem.sh {trading-on|supply-on|status}"
    ;;
esac
