import argparse
import json
import requests
import os
import sys

BASE_URL = "http://localhost:10000"

def submit_sweep(config_path):
    config_path = os.path.abspath(config_path)
    if not os.path.exists(config_path):
        print(f"Error: Config file not found at {config_path}")
        sys.exit(1)

    with open(config_path, "r") as f:
        try:
            config = json.load(f)
        except json.JSONDecodeError as e:
            print(f"Error parsing JSON: {e}")
            sys.exit(1)

    # Validate structure roughly
    if "runs" not in config:
        print("Error: Config must contain 'runs' list.")
        sys.exit(1)
        
    # Auto-populate workdir if missing, relative to config file location
    # This is important because the command probably assumes running from that dir
    # For .agents/configs.json, the workdir is likely the Parent of .agents, i.e. the project root/instance dir
    
    # Heuristic: if config is in .agents/ inside a dir, workdir is that dir.
    # Otherwise, workdir is config parent dir.
    config_dir = os.path.dirname(config_path)
    default_workdir = config_dir
    if os.path.basename(config_dir) == ".agents":
        default_workdir = os.path.dirname(config_dir)
    
    print(f"Using default workdir: {default_workdir}")

    for run in config["runs"]:
        if "workdir" not in run:
            run["workdir"] = default_workdir

    print(f"Submitting sweep '{config.get('name', 'unnamed')}' with {len(config['runs'])} runs...")
    
    try:
        res = requests.post(f"{BASE_URL}/sweeps", json=config)
        if res.status_code == 200:
            data = res.json()
            print(f"Success! Sweep started.")
            print(f"Run IDs: {data.get('run_ids')}")
        else:
            print(f"Failed to submit sweep. Status: {res.status_code}")
            print(f"Response: {res.text}")
    except requests.exceptions.ConnectionError:
        print(f"Error: Could not connect to server at {BASE_URL}. Is it running?")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Submit a sweep from a JSON config file.")
    parser.add_argument("config_file", help="Path to the JSON config file")
    args = parser.parse_args()
    
    submit_sweep(args.config_file)
