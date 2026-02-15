#!/bin/bash

# Print current time every 1 second for 20 seconds

for i in {1..20}; do
    date +"%Y-%m-%d %H:%M:%S"
    sleep 1
done

echo "Done!"
