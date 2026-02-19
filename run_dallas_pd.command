#!/bin/bash

# Navigate to the project directory relative to the script
# This makes it portable so you can move the folder anywhere
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$DIR"

echo "========================================"
echo "   Dallas PD Active Calls Command Center"
echo "========================================"
echo ""
echo "Checking dependencies..."

# Ensure dependencies are installed (silently if already present)
pip install -r requirements.txt > /dev/null 2>&1

echo "Starting server..."

# Open browser in background after a brief delay
(sleep 2 && open "http://localhost:3000") &

# Start the server
python3 server.py
