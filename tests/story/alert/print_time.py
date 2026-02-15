#!/usr/bin/env python3
import time
from datetime import datetime

for i in range(20):
    print(datetime.now().strftime("%Y-%m-%d %H:%M:%S"))
    time.sleep(1)

print("done")
